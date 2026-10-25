from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from groq import Groq
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .risk import ENGINEERING_LIMITS
from .simulation import DEMO_MACHINES, OneSecondSimulation
from .validation import validate_reading

logger = logging.getLogger("maintainx.live")
DB_PATH = Path(os.getenv("MAINTAINX_LIVE_DB", Path(__file__).with_name("live.db")))
DEFAULT_LIMITS = {**ENGINEERING_LIMITS, "process_temperature": 70.0, "torque": 85.0}
DEFAULT_LIMITS.update(downtime_cost_per_hour=350.0, estimated_repair_hours=3.0)
clients: set[WebSocket] = set()
mqtt_state = {"configured": False, "connected": False, "detail": "Not configured"}
mqtt_client = None
mqtt_loop: asyncio.AbstractEventLoop | None = None
simulator = OneSecondSimulation(int(os.getenv("MAINTAINX_SIMULATION_SEED", "42")))


class SensorPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    machine_id: str = Field(min_length=1, max_length=128)
    equipment_type: str = Field(default="Industrial equipment", max_length=120)
    timestamp: datetime | None = None
    air_temperature: float | None = None
    process_temperature: float | None = None
    rotational_speed: float | None = None
    torque: float | None = None
    tool_wear: float | None = None
    operating_state: str = Field(default="RUNNING", max_length=64)

    @model_validator(mode="after")
    def require_measurement(self):
        if all(getattr(self, key) is None for key in (
            "air_temperature", "process_temperature", "rotational_speed", "torque", "tool_wear"
        )):
            raise ValueError("At least one sensor measurement is required")
        return self


class EventStatusPayload(BaseModel):
    status: str


class SettingsPayload(BaseModel):
    process_temperature: float = Field(ge=20, le=150)
    torque: float = Field(ge=10, le=300)
    rotational_speed_low: float = Field(ge=0, le=9999)
    rotational_speed_high: float = Field(ge=1, le=10000)
    tool_wear: float = Field(ge=0, le=1000)
    downtime_cost_per_hour: float = Field(default=350, ge=0, le=10_000_000)
    estimated_repair_hours: float = Field(default=3, ge=0.1, le=1000)

    @model_validator(mode="after")
    def validate_rpm_range(self):
        if self.rotational_speed_high <= self.rotational_speed_low:
            raise ValueError("RPM upper limit must exceed the lower limit")
        return self


class MachineLimitsPayload(BaseModel):
    mode: str = Field(pattern="^(inherit|custom)$")
    process_temperature: float | None = Field(default=None, ge=20, le=150)
    torque: float | None = Field(default=None, ge=10, le=300)
    rotational_speed_low: float | None = Field(default=None, ge=0, le=9999)
    rotational_speed_high: float | None = Field(default=None, ge=1, le=10000)
    tool_wear: float | None = Field(default=None, ge=0, le=1000)
    source: str = Field(default="site_engineering", pattern="^(manufacturer|site_engineering|inherited_default)$")
    reference: str = Field(default="", max_length=300)

    @model_validator(mode="after")
    def validate_profile(self):
        if self.mode == "custom":
            required = (self.process_temperature, self.torque, self.rotational_speed_low,
                        self.rotational_speed_high, self.tool_wear)
            if any(value is None for value in required):
                raise ValueError("Custom profiles require every sensor limit")
            if self.rotational_speed_high <= self.rotational_speed_low:
                raise ValueError("RPM upper limit must exceed the lower limit")
            if self.source == "inherited_default":
                raise ValueError("Custom profiles must cite a manufacturer or site engineering source")
            if not self.reference.strip():
                raise ValueError("Add a manual, engineering approval, or other source reference")
        return self


class DevicePayload(BaseModel):
    machine_id: str = Field(min_length=1, max_length=128)
    machine_name: str = Field(default="", max_length=120)
    equipment_type: str = Field(default="Industrial equipment", max_length=120)
    criticality: float = Field(default=1.0, ge=0.1, le=5.0)
    limits: MachineLimitsPayload | None = None


class ChatPayload(BaseModel):
    machine_id: str = Field(min_length=1, max_length=128)
    question: str = Field(min_length=3, max_length=2000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


@contextmanager
def database():
    connection = connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    with database() as connection:
        connection.executescript("""
        CREATE TABLE IF NOT EXISTS devices (
            machine_id TEXT PRIMARY KEY, machine_name TEXT NOT NULL DEFAULT '',
            equipment_type TEXT NOT NULL,
            criticality REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
            machine_id TEXT NOT NULL REFERENCES devices(machine_id), air_temperature REAL,
            process_temperature REAL, rotational_speed REAL, torque REAL, tool_wear REAL,
            operating_state TEXT NOT NULL, source TEXT NOT NULL, data_quality_status TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS readings_machine_time ON readings(machine_id,timestamp DESC);
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL REFERENCES devices(machine_id),
            timestamp TEXT NOT NULL, event_type TEXT NOT NULL, condition TEXT NOT NULL,
            severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Open',
            recommended_action TEXT NOT NULL, fingerprint TEXT NOT NULL, reading_id INTEGER,
            resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS events_machine_time ON events(machine_id,timestamp DESC);
        CREATE TABLE IF NOT EXISTS actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL REFERENCES devices(machine_id),
            timestamp TEXT NOT NULL, action TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS machine_limits (
            machine_id TEXT PRIMARY KEY REFERENCES devices(machine_id) ON DELETE CASCADE,
            mode TEXT NOT NULL CHECK(mode IN ('inherit','custom')),
            process_temperature REAL, torque REAL, rotational_speed_low REAL,
            rotational_speed_high REAL, tool_wear REAL, source TEXT NOT NULL,
            reference TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
        );
        """)
        device_columns = {row["name"] for row in connection.execute("PRAGMA table_info(devices)")}
        if "machine_name" not in device_columns:
            connection.execute("ALTER TABLE devices ADD COLUMN machine_name TEXT NOT NULL DEFAULT ''")
        connection.execute("UPDATE devices SET machine_name=machine_id WHERE machine_name=''")
        connection.executemany("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", list(DEFAULT_LIMITS.items()))


def current_limits() -> dict[str, float]:
    with database() as connection:
        saved = {row["key"]: row["value"] for row in connection.execute("SELECT key,value FROM settings")}
    return {**DEFAULT_LIMITS, **saved}


def machine_limit_profile(machine_id: str) -> dict:
    with database() as connection:
        row = connection.execute("SELECT * FROM machine_limits WHERE machine_id=?", (machine_id,)).fetchone()
    if row and row["mode"] == "custom":
        return {key: row[key] for key in ("mode", "process_temperature", "torque", "rotational_speed_low",
            "rotational_speed_high", "tool_wear", "source", "reference", "updated_at")}
    return {"mode": "inherit", **current_limits(), "source": "inherited_default",
            "reference": "Shared fallback assumptions; not equipment-certified", "updated_at": None}


def limits_for_machine(machine_id: str) -> dict[str, float]:
    profile = machine_limit_profile(machine_id)
    if profile["mode"] == "custom":
        return {key: profile[key] for key in ("process_temperature", "torque", "rotational_speed_low",
                                               "rotational_speed_high", "tool_wear")}
    return current_limits()

def sync_threshold_events(connection: sqlite3.Connection, machine_id: str, timestamp: str,
                          reading_id: int, reading: dict, assessment: dict, limits: dict) -> None:
    active = connection.execute("""SELECT id,fingerprint FROM events WHERE machine_id=?
        AND event_type='threshold' AND status IN ('Open','Acknowledged')""", (machine_id,)).fetchall()
    active_codes = set(assessment["condition_codes"])
    existing_codes = {row["fingerprint"].rsplit("|", 2)[-2] for row in active}
    for event in active:
        code = event["fingerprint"].rsplit("|", 2)[-2]
        if code not in active_codes and condition_recovered(code, reading, limits):
            connection.execute("UPDATE events SET status='Resolved',resolved_at=? WHERE id=?", (timestamp, event["id"]))
            existing_codes.discard(code)
    if not assessment["condition_codes"]:
        return
    condition = "; ".join(assessment["violations"])
    for code in assessment["condition_codes"]:
        if code not in existing_codes:
            connection.execute("""INSERT INTO events(machine_id,timestamp,event_type,condition,severity,
                status,recommended_action,fingerprint,reading_id)
                VALUES(?,?,'threshold',?,?,'Open',?,?,?)""",
                (machine_id, timestamp, condition, assessment["risk"], assessment["recommended_action"],
                 f"{machine_id}|{code}|{timestamp}", reading_id))
        else:
            connection.execute("""UPDATE events SET condition=?,severity=?,recommended_action=?,reading_id=?
                WHERE machine_id=? AND event_type='threshold' AND status IN ('Open','Acknowledged')
                AND fingerprint LIKE ?""",
                (condition, assessment["risk"], assessment["recommended_action"], reading_id,
                 machine_id, f"{machine_id}|{code}|%"))


def assess(reading: dict, limits: dict | None = None) -> dict:
    limits = limits or current_limits()
    temp, torque = reading.get("process_temperature"), reading.get("torque")
    rpm, wear = reading.get("rotational_speed"), reading.get("tool_wear")
    violations = []
    if temp is not None and temp > limits["process_temperature"]:
        violations.append(("process_temperature", f"Process temperature {temp:g} C is above the configured {limits['process_temperature']:g} C limit"))
    if torque is not None and torque > limits["torque"]:
        violations.append(("torque", f"Torque {torque:g} Nm is above the configured {limits['torque']:g} Nm limit"))
    if rpm is not None and not limits["rotational_speed_low"] <= rpm <= limits["rotational_speed_high"]:
        violations.append(("rotational_speed", f"Speed {rpm:g} rpm is outside the configured {limits['rotational_speed_low']:g}-{limits['rotational_speed_high']:g} rpm band"))
    if wear is not None and wear > limits["tool_wear"]:
        violations.append(("tool_wear", f"Wear {wear:g} is above the configured {limits['tool_wear']:g} indicator limit"))
    if reading.get("data_quality_status", "good") != "good":
        violations.append(("sensor_quality", f"Sensor data needs verification ({reading['data_quality_status']})"))
    codes = [code for code, _ in violations]
    severe = ((temp is not None and temp > limits["process_temperature"] * 1.15)
              or (torque is not None and torque > limits["torque"] * 1.2)
              or (wear is not None and wear > limits["tool_wear"] * 1.15)
              or "sensor_quality" in codes)
    risk = "Critical" if len(codes) >= 2 or severe else "Attention" if codes else "Normal"
    if "sensor_quality" in codes:
        action = "Verify sensor signal and data quality before acting on the reading"
    elif temp is not None and temp > limits["process_temperature"]:
        action = "Review the temperature trend and cooling system with a qualified maintainer"
    elif torque is not None and torque > limits["torque"]:
        action = "Review load and drive-train condition under the approved maintenance procedure"
    elif wear is not None and wear > limits["tool_wear"]:
        action = "Schedule a wear inspection using the equipment manufacturer procedure"
    elif "rotational_speed" in codes:
        action = "Verify the speed sensor and approved equipment operating envelope"
    elif risk == "Critical":
        action = "Escalate for qualified engineering review"
    elif risk == "Attention":
        action = "Schedule an inspection and continue monitoring"
    else:
        action = "Continue monitoring"
    return {"risk": risk, "violations": [text for _, text in violations],
            "condition_codes": codes, "recommended_action": action}


def condition_recovered(code: str, reading: dict, limits: dict) -> bool:
    margin = 0.02
    if code == "process_temperature":
        value = reading.get("process_temperature")
        return value is not None and value < limits["process_temperature"] * (1 - margin)
    if code == "torque":
        value = reading.get("torque")
        return value is not None and value < limits["torque"] * (1 - margin)
    if code == "tool_wear":
        value = reading.get("tool_wear")
        return value is not None and value < limits["tool_wear"] * (1 - margin)
    if code == "rotational_speed":
        value = reading.get("rotational_speed")
        rpm_margin = max(10.0, (limits["rotational_speed_high"] - limits["rotational_speed_low"]) * margin)
        return value is not None and limits["rotational_speed_low"] + rpm_margin < value < limits["rotational_speed_high"] - rpm_margin
    if code == "sensor_quality":
        return reading.get("data_quality_status", "good") == "good"
    return True


def read_dict(row: sqlite3.Row) -> dict:
    result = dict(row)
    result["assessment"] = assess(result, limits_for_machine(result["machine_id"]))
    return result


def is_recent(timestamp: str | None, seconds: int | None = None) -> bool:
    if not timestamp:
        return False
    try:
        instant = datetime.fromisoformat(timestamp)
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - instant.astimezone(timezone.utc)).total_seconds()
        return 0 <= age <= (seconds if seconds is not None else int(os.getenv("MAINTAINX_STALE_SECONDS", "10")))
    except ValueError:
        return False


def persist_reading(payload: SensorPayload, source: str) -> dict:
    timestamp = (payload.timestamp or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
    raw = payload.model_dump(exclude={"timestamp", "equipment_type"})
    raw.update(timestamp=timestamp, source=source, data_quality_status="good")
    normalized, _ = validate_reading(raw)
    limits = limits_for_machine(payload.machine_id)
    assessment = assess(normalized, limits)
    with database() as connection:
        connection.execute("""INSERT INTO devices(machine_id,machine_name,equipment_type,created_at) VALUES(?,?,?,?)
            ON CONFLICT(machine_id) DO UPDATE SET equipment_type=excluded.equipment_type""",
            (payload.machine_id, payload.machine_id, payload.equipment_type, timestamp))
        cursor = connection.execute("""INSERT INTO readings(timestamp,machine_id,air_temperature,
            process_temperature,rotational_speed,torque,tool_wear,operating_state,source,data_quality_status)
            VALUES(:timestamp,:machine_id,:air_temperature,:process_temperature,:rotational_speed,
            :torque,:tool_wear,:operating_state,:source,:data_quality_status)""", normalized)
        reading_id = cursor.lastrowid
        sync_threshold_events(connection, payload.machine_id, timestamp, reading_id,
                              normalized, assessment, limits)
        row = connection.execute("SELECT * FROM readings WHERE id=?", (reading_id,)).fetchone()
    result = dict(row)
    result["assessment"] = assessment
    return result


def dashboard_data() -> dict:
    limits = current_limits()
    with database() as connection:
        devices = connection.execute("""SELECT d.*,r.id,r.timestamp,r.air_temperature,r.process_temperature,
            r.rotational_speed,r.torque,r.tool_wear,r.operating_state,r.source,r.data_quality_status
            FROM devices d LEFT JOIN readings r ON r.id=(SELECT MAX(id) FROM readings WHERE machine_id=d.machine_id)
            ORDER BY d.machine_id""").fetchall()
        events = connection.execute("SELECT * FROM events ORDER BY id DESC LIMIT 10").fetchall()
        due = connection.execute("SELECT COUNT(*) FROM events WHERE status IN ('Open','Acknowledged')").fetchone()[0]
        open_count = due
    machines = []
    for row in devices:
        item = dict(row)
        item["limit_profile"] = machine_limit_profile(item["machine_id"])
        if item.get("id") is None:
            item.update(risk="No data", assessment={"risk": "No data", "violations": [], "condition_codes": [], "recommended_action": "Awaiting first reading"})
        else:
            item["assessment"] = assess(item, limits_for_machine(item["machine_id"]))
            item["risk"] = item["assessment"]["risk"]
        rate = limits["downtime_cost_per_hour"]
        hours = limits["estimated_repair_hours"]
        item["stale"] = bool(item.get("source") in {"rest", "mqtt"} and not is_recent(item.get("timestamp")))
        item["downtime_scenario"] = {"rate_per_hour": rate, "repair_hours": hours,
            "estimated_cost": round(rate * hours * float(item.get("criticality", 1.0)), 2)}
        machines.append(item)
    event_rows = [dict(row) for row in events]
    return {"machines": machines, "events": event_rows,
            "metrics": {"total": len(machines), "critical": sum(row["risk"] == "Critical" for row in machines),
                        "attention": sum(row["risk"] == "Attention" for row in machines),
                        "normal": sum(row["risk"] == "Normal" for row in machines),
                        "real_connected": sum(row.get("source") in {"rest", "mqtt"} and not row.get("stale") for row in machines),
                        "simulation_assets": sum(row.get("source") == "synthetic-demo" for row in machines),
                        "actions_due": due, "open_events": open_count}, "connections": connection_status()}


def connection_status() -> dict:
    port = int(os.getenv("MAINTAINX_PORT", "8000"))
    configured = bool(os.getenv("MQTT_BROKER_HOST"))
    mqtt_port = int(os.getenv("MQTT_BROKER_PORT", "8883" if os.getenv("MQTT_TLS", "1") == "1" else "1883"))
    return {"rest": {"name": "Authenticated REST ingest", "port": port,
                      "configured": bool(os.getenv("MAINTAINX_INGEST_TOKEN")),
                      "endpoint": f"http://127.0.0.1:{port}/api/ingest/v1/readings"},
            "mqtt": {**mqtt_state, "configured": configured, "host": os.getenv("MQTT_BROKER_HOST", ""), "port": mqtt_port},
            "websocket": f"ws://127.0.0.1:{port}/ws",
            "simulation": {"enabled": simulator.running, "source": "synthetic-demo",
                           "tick": simulator.tick, "interval_seconds": 1,
                           "machines": len(DEMO_MACHINES) - len(simulator.removed)}}


async def broadcast(message: dict) -> None:
    targets = list(clients)
    results = await asyncio.gather(*(client.send_json(message) for client in targets), return_exceptions=True)
    clients.difference_update({client for client, result in zip(targets, results) if isinstance(result, Exception)})


def start_mqtt(loop: asyncio.AbstractEventLoop) -> None:
    global mqtt_client, mqtt_loop, mqtt_state
    host = os.getenv("MQTT_BROKER_HOST")
    if not host:
        mqtt_state = {"configured": False, "connected": False, "detail": "Not configured"}
        return
    mqtt_state = {"configured": True, "connected": False, "detail": "Connecting"}
    mqtt_loop = loop
    try:
        import paho.mqtt.client as mqtt
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=os.getenv("MQTT_CLIENT_ID", "maintain-x-dashboard"))
        if os.getenv("MQTT_USERNAME"):
            client.username_pw_set(os.getenv("MQTT_USERNAME"), os.getenv("MQTT_PASSWORD"))
        if os.getenv("MQTT_TLS", "1") == "1":
            client.tls_set()

        def on_connect(client, userdata, flags, reason_code, properties):
            mqtt_state.update(connected=reason_code == 0, detail="Connected" if reason_code == 0 else f"Connection refused ({reason_code})")
            if reason_code == 0:
                client.subscribe(os.getenv("MQTT_TOPIC", "maintain-x/+/readings"), qos=1)

        def on_message(client, userdata, message):
            try:
                payload = SensorPayload.model_validate_json(message.payload)
                result = persist_reading(payload, "mqtt")
                if mqtt_loop and mqtt_loop.is_running():
                    asyncio.run_coroutine_threadsafe(broadcast({"type": "reading", "data": result}), mqtt_loop)
            except Exception:
                logger.exception("Rejected MQTT sensor message")

        client.on_connect, client.on_message = on_connect, on_message
        client.connect(host, int(os.getenv("MQTT_BROKER_PORT", "8883" if os.getenv("MQTT_TLS", "1") == "1" else "1883")), 60)
        client.loop_start()
        mqtt_client = client
    except Exception as error:
        mqtt_state.update(connected=False, detail=f"Could not connect: {type(error).__name__}")
        logger.exception("MQTT connection unavailable")


@asynccontextmanager
async def lifespan(application: FastAPI):
    initialize_database()
    start_mqtt(asyncio.get_running_loop())
    if os.getenv("MAINTAINX_SIMULATION_ENABLED", "1") == "1":
        simulator.running = True
        with database() as connection:
            timestamp = datetime.now(timezone.utc).isoformat()
            for machine_id, values in DEMO_MACHINES.items():
                if machine_id not in simulator.removed:
                    connection.execute("INSERT OR IGNORE INTO devices(machine_id,machine_name,equipment_type,created_at) VALUES(?,?,?,?)",
                        (machine_id, machine_id, values["equipment_type"], timestamp))
    task = asyncio.create_task(simulation_worker())
    yield
    simulator.running = False
    task.cancel()
    if mqtt_client:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()


async def simulation_worker():
    while True:
        if simulator.running:
            updated = []
            for raw in simulator.step():
                payload = SensorPayload.model_validate(raw)
                updated.append(persist_reading(payload, "synthetic-demo"))
            if updated:
                await broadcast({"type": "readings", "data": updated})
        await asyncio.sleep(1)


app = FastAPI(title="MAINTAIN-X Live Equipment API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware,
    allow_origins=os.getenv("MAINTAINX_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH"], allow_headers=["Authorization", "Content-Type"])


def require_ingest_token(authorization: str | None = Header(default=None)) -> None:
    expected = os.getenv("MAINTAINX_INGEST_TOKEN", "")
    if not expected:
        raise HTTPException(503, "Sensor ingestion is disabled until MAINTAINX_INGEST_TOKEN is configured")
    if authorization != f"Bearer {expected}":
        raise HTTPException(401, "Invalid sensor-ingest credential")


@app.get("/api/health")
def health():
    return {"status": "ok", "connections": connection_status()}


@app.get("/api/dashboard")
def get_dashboard():
    return dashboard_data()


@app.get("/api/machines")
def get_machines(risk: str | None = Query(default=None)):
    machines = dashboard_data()["machines"]
    return machines if not risk or risk == "All risks" else [row for row in machines if row["risk"].lower() == risk.lower()]


def save_machine_limits(connection: sqlite3.Connection, machine_id: str,
                         payload: MachineLimitsPayload, timestamp: str) -> None:
    if payload.mode == "inherit":
        connection.execute("DELETE FROM machine_limits WHERE machine_id=?", (machine_id,))
        return
    connection.execute("""INSERT INTO machine_limits(machine_id,mode,process_temperature,torque,
        rotational_speed_low,rotational_speed_high,tool_wear,source,reference,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET mode=excluded.mode,
        process_temperature=excluded.process_temperature,torque=excluded.torque,
        rotational_speed_low=excluded.rotational_speed_low,rotational_speed_high=excluded.rotational_speed_high,
        tool_wear=excluded.tool_wear,source=excluded.source,reference=excluded.reference,updated_at=excluded.updated_at""",
        (machine_id, payload.mode, payload.process_temperature, payload.torque,
         payload.rotational_speed_low, payload.rotational_speed_high, payload.tool_wear,
         payload.source, payload.reference.strip(), timestamp))


@app.post("/api/machines", status_code=201)
async def register_machine(payload: DevicePayload):
    timestamp = datetime.now(timezone.utc).isoformat()
    machine_name = payload.machine_name.strip() or payload.machine_id
    with database() as connection:
        connection.execute("""INSERT INTO devices(machine_id,machine_name,equipment_type,criticality,created_at) VALUES(?,?,?,?,?)
            ON CONFLICT(machine_id) DO UPDATE SET machine_name=excluded.machine_name,
            equipment_type=excluded.equipment_type,criticality=excluded.criticality""",
            (payload.machine_id, machine_name, payload.equipment_type, payload.criticality, timestamp))
        if payload.limits:
            save_machine_limits(connection, payload.machine_id, payload.limits, timestamp)
            latest = connection.execute("SELECT * FROM readings WHERE machine_id=? ORDER BY id DESC LIMIT 1",
                                        (payload.machine_id,)).fetchone()
        else:
            latest = None
    if latest:
        reading = dict(latest)
        limits = limits_for_machine(payload.machine_id)
        assessment = assess(reading, limits)
        with database() as connection:
            sync_threshold_events(connection, payload.machine_id, reading["timestamp"], reading["id"],
                                  reading, assessment, limits)
    await broadcast({"type": "snapshot", "data": dashboard_data()})
    return next(row for row in dashboard_data()["machines"] if row["machine_id"] == payload.machine_id)


@app.get("/api/machines/{machine_id}/history")
def machine_history(machine_id: str, limit: int = Query(120, ge=1, le=1000)):
    with database() as connection:
        rows = connection.execute("SELECT * FROM readings WHERE machine_id=? ORDER BY id DESC LIMIT ?", (machine_id, limit)).fetchall()
    return [dict(row) for row in reversed(rows)]


@app.get("/api/machines/{machine_id}/limits")
def get_machine_limits(machine_id: str):
    with database() as connection:
        exists = connection.execute("SELECT 1 FROM devices WHERE machine_id=?", (machine_id,)).fetchone()
    if not exists:
        raise HTTPException(404, "Machine not found")
    return machine_limit_profile(machine_id)


@app.put("/api/machines/{machine_id}/limits")
async def put_machine_limits(machine_id: str, payload: MachineLimitsPayload):
    timestamp = datetime.now(timezone.utc).isoformat()
    with database() as connection:
        if not connection.execute("SELECT 1 FROM devices WHERE machine_id=?", (machine_id,)).fetchone():
            raise HTTPException(404, "Machine not found")
        save_machine_limits(connection, machine_id, payload, timestamp)
        latest = connection.execute("SELECT * FROM readings WHERE machine_id=? ORDER BY id DESC LIMIT 1", (machine_id,)).fetchone()
    if latest:
        reading = dict(latest)
        limits = limits_for_machine(machine_id)
        assessment = assess(reading, limits)
        with database() as connection:
            sync_threshold_events(connection, machine_id, reading["timestamp"], reading["id"],
                                  reading, assessment, limits)
    profile = machine_limit_profile(machine_id)
    await broadcast({"type": "snapshot", "data": dashboard_data()})
    return profile


@app.get("/api/events")
def get_events(machine_id: str | None = None, severity: str | None = None, status: str | None = None,
               limit: int = Query(200, ge=1, le=1000)):
    clauses, values = [], []
    for column, value in (("machine_id", machine_id), ("severity", severity), ("status", status)):
        if value and value != "All":
            clauses.append(f"{column}=?")
            values.append(value)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with database() as connection:
        rows = connection.execute(f"SELECT * FROM events{where} ORDER BY id DESC LIMIT ?", (*values, limit)).fetchall()
    return [dict(row) for row in rows]


@app.patch("/api/events/{event_id}")
def update_event(event_id: int, payload: EventStatusPayload):
    if payload.status not in {"Acknowledged", "Resolved"}:
        raise HTTPException(422, "Status must be Acknowledged or Resolved")
    with database() as connection:
        result = connection.execute("UPDATE events SET status=?,resolved_at=? WHERE id=?",
            (payload.status, datetime.now(timezone.utc).isoformat() if payload.status == "Resolved" else None, event_id))
        if result.rowcount == 0:
            raise HTTPException(404, "Event not found")
        return dict(connection.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone())


@app.get("/api/settings")
def get_settings():
    return current_limits()


@app.put("/api/settings")
async def put_settings(payload: SettingsPayload):
    with database() as connection:
        connection.executemany("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                               list(payload.model_dump().items()))
    result = current_limits()
    await broadcast({"type": "settings", "data": result})
    return result


@app.post("/api/ingest/v1/readings", dependencies=[Depends(require_ingest_token)])
async def ingest(payload: SensorPayload):
    result = persist_reading(payload, "rest")
    await broadcast({"type": "reading", "data": result})
    return result


@app.post("/api/actions", status_code=201)
def log_action(payload: dict[str, str]):
    machine_id, action, notes = payload.get("machine_id", "").strip(), payload.get("action", "").strip(), payload.get("notes", "")[:2000]
    if not machine_id or not action:
        raise HTTPException(422, "Machine ID and action are required")
    with database() as connection:
        if not connection.execute("SELECT 1 FROM devices WHERE machine_id=?", (machine_id,)).fetchone():
            raise HTTPException(404, "Machine not found")
        cursor = connection.execute("INSERT INTO actions(machine_id,timestamp,action,notes) VALUES(?,?,?,?)",
            (machine_id, datetime.now(timezone.utc).isoformat(), action, notes))
        return dict(connection.execute("SELECT * FROM actions WHERE id=?", (cursor.lastrowid,)).fetchone())


@app.get("/api/reports/{machine_id}")
def report(machine_id: str):
    with database() as connection:
        device = connection.execute("SELECT * FROM devices WHERE machine_id=?", (machine_id,)).fetchone()
        if not device:
            raise HTTPException(404, "Machine not found")
        readings = connection.execute("SELECT * FROM readings WHERE machine_id=? ORDER BY id", (machine_id,)).fetchall()
        events = connection.execute("SELECT * FROM events WHERE machine_id=? ORDER BY id", (machine_id,)).fetchall()
        actions = connection.execute("SELECT * FROM actions WHERE machine_id=? ORDER BY id", (machine_id,)).fetchall()
    return {"device": dict(device), "readings": [dict(row) for row in readings],
            "events": [dict(row) for row in events], "actions": [dict(row) for row in actions],
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "limits": limits_for_machine(machine_id), "limit_profile": machine_limit_profile(machine_id)}


@app.get("/api/reports/{machine_id}/events.csv")
def report_csv(machine_id: str):
    data = report(machine_id)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["timestamp", "event_type", "severity", "status", "condition", "recommended_action"])
    for row in data["events"]:
        writer.writerow([row[key] for key in ("timestamp", "event_type", "severity", "status", "condition", "recommended_action")])
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={machine_id}-events.csv"})


def chat_messages(machine_id: str, question: str, history: list[dict[str, str]]) -> list[dict[str, str]]:
    with database() as connection:
        device = connection.execute("SELECT * FROM devices WHERE machine_id=?", (machine_id,)).fetchone()
        reading = connection.execute("SELECT * FROM readings WHERE machine_id=? ORDER BY id DESC LIMIT 1", (machine_id,)).fetchone()
        events = connection.execute("SELECT * FROM events WHERE machine_id=? ORDER BY id DESC LIMIT 8", (machine_id,)).fetchall()
    if not device:
        raise HTTPException(404, "Machine not found")
    device_limits = limits_for_machine(machine_id)
    context = {"device": dict(device), "latest_reading": dict(reading) if reading else None,
        "assessment": assess(dict(reading), device_limits) if reading else None,
        "recent_events": [dict(row) for row in events], "configured_limits": device_limits,
        "limit_profile": machine_limit_profile(machine_id)}
    system = ("You are MAINTAIN-X's industrial maintenance analysis assistant. Explain critical status using only supplied "
        "readings, configured limits, and event history. Distinguish observed data from inference. Give a prioritized, "
        "non-invasive triage checklist. Never suggest bypassing guards, interlocks, lockout/tagout, or safety controls; "
        "never command machinery. Defer hazardous work to site procedures, manufacturer guidance, and a qualified engineer. "
        "Do not call a threshold alert a confirmed failure. If no reading exists, say so. Context: " + json.dumps(context, default=str))
    messages = [{"role": "system", "content": system}]
    for message in history[-8:]:
        if message.get("role") in {"assistant", "user"}:
            messages.append({"role": message["role"], "content": message.get("content", "")[:2000]})
    messages.append({"role": "user", "content": question})

    return messages


def stream_chat(machine_id: str, question: str, history: list[dict[str, str]]):
    messages = chat_messages(machine_id, question, history)
    try:
        client = Groq(api_key=os.environ["GROQ_API_KEY"], timeout=45.0, max_retries=1)
        completion = client.chat.completions.create(
            model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
            messages=messages,
            temperature=1,
            max_completion_tokens=2048,
            top_p=1,
            reasoning_effort="medium",
            stream=True,
            stop=None,
        )
        for chunk in completion:
            if not chunk.choices:
                continue
            content = chunk.choices[0].delta.content or ""
            if content:
                yield f"data: {json.dumps({'delta': content})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"
    except Exception as error:
        logger.warning("Chat provider unavailable: %s", type(error).__name__)
        yield f"data: {json.dumps({'error': 'Assistant provider is unavailable. Check the server key, model access, or network connection.'})}\n\n"


@app.post("/api/chat")
def chat(payload: ChatPayload):
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "Assistant not configured. Run start_api.ps1 and enter a newly rotated GROQ_API_KEY.")
    with database() as connection:
        if not connection.execute("SELECT 1 FROM devices WHERE machine_id=?", (payload.machine_id,)).fetchone():
            raise HTTPException(404, "Machine not found")
    return StreamingResponse(stream_chat(payload.machine_id, payload.question, payload.history),
        media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/assistant/status")
def assistant_status():
    return {"configured": bool(os.getenv("GROQ_API_KEY")),
            "model": os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
            "provider": "Groq OpenAI-compatible API"}


@app.websocket("/ws")
async def websocket_events(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    try:
        await websocket.send_json({"type": "snapshot", "data": dashboard_data()})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        clients.discard(websocket)


@app.get("/api/connections")
def get_connections():
    port = int(os.getenv("MAINTAINX_PORT", "8000"))
    host = os.getenv("MQTT_BROKER_HOST", "")
    mqtt_port = int(os.getenv("MQTT_BROKER_PORT", "8883" if os.getenv("MQTT_TLS", "1") == "1" else "1883"))
    configured = bool(host)
    return {"rest": {"name": "Authenticated REST ingest", "port": port,
                      "configured": bool(os.getenv("MAINTAINX_INGEST_TOKEN")),
                      "endpoint": f"http://127.0.0.1:{port}/api/ingest/v1/readings"},
            "mqtt": {**mqtt_state, "configured": configured, "host": host, "port": mqtt_port},
            "websocket": f"ws://127.0.0.1:{port}/ws"}


@app.get("/api/simulation")
def get_simulation():
    return connection_status()["simulation"]


@app.post("/api/simulation/{action}")
async def control_simulation(action: str):
    if action not in {"start", "pause", "reset"}:
        raise HTTPException(404, "Simulation action must be start, pause, or reset")
    if action == "reset":
        simulator.running = False
        simulator.reset()
        with database() as connection:
            demo_ids = list(DEMO_MACHINES)
            placeholders = ",".join("?" for _ in demo_ids)
            for table in ("events", "actions", "readings", "devices"):
                connection.execute(f"DELETE FROM {table} WHERE machine_id IN ({placeholders})", demo_ids)
            timestamp = datetime.now(timezone.utc).isoformat()
            connection.executemany("INSERT INTO devices(machine_id,machine_name,equipment_type,created_at) VALUES(?,?,?,?)",
                [(machine_id, machine_id, values["equipment_type"], timestamp) for machine_id, values in DEMO_MACHINES.items()])
        for raw in simulator.step():
            reading = persist_reading(SensorPayload.model_validate(raw), "synthetic-demo")
            await broadcast({"type": "reading", "data": reading})
    simulator.running = action != "pause"
    result = connection_status()["simulation"]
    await broadcast({"type": "simulation", "data": result})
    return result


@app.delete("/api/machines/{machine_id}")
async def remove_machine(machine_id: str, confirmation: str = Query(default="")):
    if confirmation != "DELETE":
        raise HTTPException(400, "Explicit confirmation=DELETE is required")
    with database() as connection:
        if not connection.execute("SELECT 1 FROM devices WHERE machine_id=?", (machine_id,)).fetchone():
            raise HTTPException(404, "Machine not found")
        for table in ("events", "actions", "readings", "devices"):
            connection.execute(f"DELETE FROM {table} WHERE machine_id=?", (machine_id,))
    if machine_id in DEMO_MACHINES:
        simulator.removed.add(machine_id)
    await broadcast({"type": "snapshot", "data": dashboard_data()})
    return {"removed": machine_id}