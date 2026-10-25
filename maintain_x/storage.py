from __future__ import annotations

import sqlite3
from pathlib import Path


DEFAULT_DB = Path(__file__).resolve().parent / "maintain_x.db"


def connect(path: str | Path = DEFAULT_DB) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("""CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        condition TEXT NOT NULL,
        severity TEXT NOT NULL,
        probability REAL,
        recommended_action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Open',
        fingerprint TEXT NOT NULL UNIQUE
    )""")
    connection.execute("""CREATE TABLE IF NOT EXISTS maintenance_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        action TEXT NOT NULL,
        evidence TEXT NOT NULL
    )""")
    connection.commit()
    return connection


def record_event(event: dict, path: str | Path = DEFAULT_DB) -> bool:
    with connect(path) as connection:
        active = connection.execute(
            "SELECT 1 FROM events WHERE substr(fingerprint, 1, length(?)) = ? "
            "AND status != 'Resolved' LIMIT 1",
            (event["fingerprint"] + "|", event["fingerprint"] + "|"),
        ).fetchone()
        if active:
            return False
        stored_event = {**event, "fingerprint": f"{event['fingerprint']}|{event['timestamp']}"}
        cursor = connection.execute("""INSERT OR IGNORE INTO events
            (timestamp, machine_id, event_type, condition, severity, probability,
             recommended_action, status, fingerprint)
                VALUES (:timestamp, :machine_id, :event_type, :condition, :severity,
                    :probability, :recommended_action, 'Open', :fingerprint)""", stored_event)
        return cursor.rowcount == 1


def list_events(path: str | Path = DEFAULT_DB, machine_id: str | None = None,
                severity: str | None = None, status: str | None = None, limit: int = 100) -> list[dict]:
    clauses, values = [], []
    for column, value in (("machine_id", machine_id), ("severity", severity), ("status", status)):
        if value and value != "All":
            clauses.append(f"{column} = ?")
            values.append(value)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with connect(path) as connection:
        rows = connection.execute(f"SELECT * FROM events{where} ORDER BY id DESC LIMIT ?", (*values, limit)).fetchall()
    return [dict(row) for row in rows]


def set_event_status(event_id: int, status: str, path: str | Path = DEFAULT_DB) -> None:
    if status not in {"Acknowledged", "Resolved", "Open"}:
        raise ValueError("Unsupported event status")
    with connect(path) as connection:
        connection.execute("UPDATE events SET status = ? WHERE id = ?", (status, event_id))


def record_action(machine_id: str, action: str, evidence: str, timestamp: str,
                  path: str | Path = DEFAULT_DB) -> None:
    with connect(path) as connection:
        connection.execute("INSERT INTO maintenance_actions(timestamp,machine_id,action,evidence) VALUES(?,?,?,?)",
                           (timestamp, machine_id, action, evidence))


def list_actions(path: str | Path = DEFAULT_DB, limit: int = 50) -> list[dict]:
    with connect(path) as connection:
        rows = connection.execute("SELECT * FROM maintenance_actions ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(row) for row in rows]