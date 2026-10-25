from types import SimpleNamespace

from fastapi.testclient import TestClient

from maintain_x import live_api


def test_live_dashboard_ingestion_alert_dedup_and_recovery(tmp_path, monkeypatch):
    monkeypatch.setattr(live_api, "DB_PATH", tmp_path / "live.sqlite")
    monkeypatch.setenv("MAINTAINX_INGEST_TOKEN", "test-ingest-token")
    monkeypatch.setenv("MAINTAINX_SIMULATION_ENABLED", "0")
    live_api.simulator.running = False
    live_api.simulator.reset()
    with TestClient(live_api.app) as client:
        initial = client.get("/api/dashboard").json()
        assert initial["machines"] == []
        assert initial["metrics"]["total"] == 0

        payload = {"machine_id": "PRESS-01", "equipment_type": "Hydraulic press",
                   "air_temperature": 28, "process_temperature": 92,
                   "rotational_speed": 1500, "torque": 112, "tool_wear": 70}
        assert client.post("/api/ingest/v1/readings", json=payload).status_code == 401
        headers = {"Authorization": "Bearer test-ingest-token"}
        reading = client.post("/api/ingest/v1/readings", json=payload, headers=headers)
        assert reading.status_code == 200
        assert reading.json()["assessment"]["risk"] == "Critical"
        assert "process_temperature" in reading.json()["assessment"]["condition_codes"]

        dashboard = client.get("/api/dashboard").json()
        assert dashboard["metrics"]["critical"] == 1
        events = client.get("/api/events", params={"status": "Open"}).json()
        assert len(events) == 2
        client.post("/api/ingest/v1/readings", json=payload, headers=headers)
        assert len(client.get("/api/events", params={"status": "Open"}).json()) == 2

        recovered = {**payload, "process_temperature": 48, "torque": 50}
        client.post("/api/ingest/v1/readings", json=recovered, headers=headers)
        assert client.get("/api/events", params={"status": "Open"}).json() == []
        assert len(client.get("/api/events", params={"status": "Resolved"}).json()) == 2


def test_live_settings_report_and_chat_configuration(tmp_path, monkeypatch):
    monkeypatch.setattr(live_api, "DB_PATH", tmp_path / "live.sqlite")
    monkeypatch.setenv("MAINTAINX_INGEST_TOKEN", "test-ingest-token")
    monkeypatch.setenv("MAINTAINX_SIMULATION_ENABLED", "0")
    live_api.simulator.running = False
    live_api.simulator.reset()
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with TestClient(live_api.app) as client:
        assert client.put("/api/settings", json={"process_temperature": 62, "torque": 80,
            "rotational_speed_low": 700, "rotational_speed_high": 2200, "tool_wear": 230}).status_code == 200
        assert client.put("/api/settings", json={"process_temperature": 62, "torque": 80,
            "rotational_speed_low": 2300, "rotational_speed_high": 2200, "tool_wear": 230}).status_code == 422
        client.post("/api/machines", json={"machine_id": "MILL-04", "equipment_type": "Mill"})
        report = client.get("/api/reports/MILL-04")
        assert report.status_code == 200
        assert report.json()["readings"] == []
        chat = client.post("/api/chat", json={"machine_id": "MILL-04", "question": "Why is this machine critical?"})
        assert chat.status_code == 503


def test_simulation_controls_and_confirmed_device_removal(tmp_path, monkeypatch):
    monkeypatch.setattr(live_api, "DB_PATH", tmp_path / "live.sqlite")
    monkeypatch.setenv("MAINTAINX_SIMULATION_ENABLED", "0")
    live_api.simulator.running = False
    live_api.simulator.reset()
    with TestClient(live_api.app) as client:
        assert client.post("/api/simulation/start").json()["enabled"] is True
        assert client.post("/api/simulation/pause").json()["enabled"] is False
        reset = client.post("/api/simulation/reset").json()
        assert reset["enabled"] is True
        assert reset["tick"] == 1
        assert len(client.get("/api/dashboard").json()["machines"]) == 5
        assert client.delete("/api/machines/SIM-101").status_code == 400
        assert client.delete("/api/machines/SIM-101?confirmation=DELETE").status_code == 200
        assert len(client.get("/api/dashboard").json()["machines"]) == 4
        assert "SIM-101" in live_api.simulator.removed


def test_threshold_hysteresis_prevents_second_alert_on_boundary_noise(tmp_path, monkeypatch):
    monkeypatch.setattr(live_api, "DB_PATH", tmp_path / "live.sqlite")
    monkeypatch.setenv("MAINTAINX_INGEST_TOKEN", "test-ingest-token")
    monkeypatch.setenv("MAINTAINX_SIMULATION_ENABLED", "0")
    live_api.simulator.running = False
    live_api.simulator.reset()
    headers = {"Authorization": "Bearer test-ingest-token"}
    base = {"machine_id": "THERMAL-01", "process_temperature": 70.5,
            "air_temperature": 25, "rotational_speed": 1400, "torque": 40, "tool_wear": 20}
    with TestClient(live_api.app) as client:
        first = client.post("/api/ingest/v1/readings", json=base, headers=headers)
        assert first.status_code == 200
        events = client.get("/api/events", params={"status": "Open"}).json()
        assert len(events) == 1
        noisy = {**base, "process_temperature": 69.8}
        client.post("/api/ingest/v1/readings", json=noisy, headers=headers)
        assert len(client.get("/api/events", params={"status": "Open"}).json()) == 1
        recovered = {**base, "process_temperature": 68.5}
        client.post("/api/ingest/v1/readings", json=recovered, headers=headers)
        assert len(client.get("/api/events", params={"status": "Open"}).json()) == 0
        assert len(client.get("/api/events", params={"status": "Resolved"}).json()) == 1


def test_chat_uses_server_side_key_and_requested_model(tmp_path, monkeypatch):
    monkeypatch.setattr(live_api, "DB_PATH", tmp_path / "live.sqlite")
    monkeypatch.setenv("MAINTAINX_SIMULATION_ENABLED", "0")
    monkeypatch.setenv("GROQ_API_KEY", "unit-test-key")
    monkeypatch.setenv("GROQ_MODEL", "openai/gpt-oss-120b")
    live_api.simulator.running = False
    live_api.simulator.reset()
    captured = {}

    class FakeGroq:
        def __init__(self, api_key, **options):
            captured["api_key"] = api_key
            captured["client_options"] = options
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

        def create(self, **options):
            captured["options"] = options
            return iter([
                SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Mock "))]),
                SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="streamed response"))]),
            ])

    monkeypatch.setattr(live_api, "Groq", FakeGroq)
    with TestClient(live_api.app) as client:
        client.post("/api/machines", json={"machine_id": "ASSIST-01", "equipment_type": "Press"})
        status = client.get("/api/assistant/status").json()
        answer = client.post("/api/chat", json={"machine_id": "ASSIST-01", "question": "What should be checked?"})
        assert status["configured"] is True
        assert answer.status_code == 200
        assert answer.headers["content-type"].startswith("text/event-stream")
        assert '"delta": "Mock "' in answer.text
        assert '"delta": "streamed response"' in answer.text
        assert captured["api_key"] == "unit-test-key"
        assert captured["options"]["model"] == "openai/gpt-oss-120b"
        assert captured["options"]["temperature"] == 1
        assert captured["options"]["max_completion_tokens"] == 2048
        assert captured["options"]["top_p"] == 1
        assert captured["options"]["reasoning_effort"] == "medium"
        assert captured["options"]["stream"] is True
        assert captured["options"]["stop"] is None


def test_machine_threshold_profiles_are_independent_and_reassessed(tmp_path, monkeypatch):
    monkeypatch.setattr(live_api, "DB_PATH", tmp_path / "live.sqlite")
    monkeypatch.setenv("MAINTAINX_INGEST_TOKEN", "test-ingest-token")
    monkeypatch.setenv("MAINTAINX_SIMULATION_ENABLED", "0")
    live_api.simulator.running = False
    live_api.simulator.reset()
    headers = {"Authorization": "Bearer test-ingest-token"}
    reading = {"equipment_type": "Press", "process_temperature": 65,
               "air_temperature": 25, "rotational_speed": 1400, "torque": 50, "tool_wear": 40}
    custom = {"mode": "custom", "process_temperature": 60, "torque": 80,
              "rotational_speed_low": 900, "rotational_speed_high": 1800,
              "tool_wear": 180, "source": "manufacturer", "reference": "Manual section 4.2"}
    with TestClient(live_api.app) as client:
        client.post("/api/machines", json={"machine_id": "PRESS-A", "equipment_type": "Press A"})
        client.post("/api/machines", json={"machine_id": "PRESS-B", "equipment_type": "Press B"})
        for machine_id in ("PRESS-A", "PRESS-B"):
            client.post("/api/ingest/v1/readings", json={**reading, "machine_id": machine_id}, headers=headers)
        assert client.get("/api/machines/PRESS-A/limits").json()["mode"] == "inherit"
        assert client.put("/api/machines/PRESS-A/limits", json=custom).status_code == 200
        dashboard = client.get("/api/dashboard").json()
        assets = {machine["machine_id"]: machine for machine in dashboard["machines"]}
        assert assets["PRESS-A"]["risk"] == "Attention"
        assert assets["PRESS-A"]["limit_profile"]["reference"] == "Manual section 4.2"
        assert assets["PRESS-B"]["risk"] == "Normal"
        assert len(client.get("/api/events", params={"machine_id": "PRESS-A", "status": "Open"}).json()) == 1
        assert client.put("/api/machines/PRESS-A/limits", json={"mode": "inherit"}).status_code == 200
        recovered = client.get("/api/dashboard").json()
        assert next(machine for machine in recovered["machines"] if machine["machine_id"] == "PRESS-A")["risk"] == "Normal"
        assert client.get("/api/events", params={"machine_id": "PRESS-A", "status": "Open"}).json() == []
        assert client.get("/api/events", params={"machine_id": "PRESS-A", "status": "Resolved"}).json()


def test_machine_registration_saves_name_and_custom_limits(tmp_path, monkeypatch):
    monkeypatch.setattr(live_api, "DB_PATH", tmp_path / "live.sqlite")
    monkeypatch.setenv("MAINTAINX_INGEST_TOKEN", "test-ingest-token")
    monkeypatch.setenv("MAINTAINX_SIMULATION_ENABLED", "0")
    live_api.simulator.running = False
    live_api.simulator.reset()
    profile = {"mode": "custom", "process_temperature": 60, "torque": 80,
               "rotational_speed_low": 900, "rotational_speed_high": 1800,
               "tool_wear": 180, "source": "manufacturer", "reference": "Press manual rev 2, page 8"}
    with TestClient(live_api.app) as client:
        registered = client.post("/api/machines", json={
            "machine_id": "PRESS-NEW", "machine_name": "North Line Press",
            "equipment_type": "Hydraulic press", "criticality": 2, "limits": profile,
        })
        assert registered.status_code == 201
        assert registered.json()["machine_name"] == "North Line Press"
        assert registered.json()["limit_profile"]["mode"] == "custom"
        assert registered.json()["limit_profile"]["reference"] == profile["reference"]

        reading = client.post("/api/ingest/v1/readings", headers={"Authorization": "Bearer test-ingest-token"}, json={
            "machine_id": "PRESS-NEW", "equipment_type": "Hydraulic press",
            "air_temperature": 25, "process_temperature": 65,
            "rotational_speed": 1400, "torque": 50, "tool_wear": 40,
        })
        assert reading.status_code == 200
        machine = next(item for item in client.get("/api/dashboard").json()["machines"]
                       if item["machine_id"] == "PRESS-NEW")
        assert machine["machine_name"] == "North Line Press"
        assert machine["risk"] == "Attention"
