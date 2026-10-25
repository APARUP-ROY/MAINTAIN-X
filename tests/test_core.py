from maintain_x.model import make_training_data, predict_reading, trained_model
from maintain_x.risk import classify_risk, cost_scenario, priority_score, threshold_violations
from maintain_x.storage import list_events, record_event, set_event_status
from maintain_x.synthetic import MACHINES, SyntheticSource
from maintain_x.validation import validate_reading


def test_synthetic_profiles_and_real_injections():
    source = SyntheticSource(seed=17)
    first = {reading.machine_id: reading for reading in source.step()}
    assert set(first) == set(MACHINES)
    assert len({round(reading.process_temperature, 1) for reading in first.values()}) > 1
    source.inject("MX-101", "excess_torque")
    assert next(reading for reading in source.step() if reading.machine_id == "MX-101").torque > first["MX-101"].torque + 15
    source.inject("MX-101", "sensor_fault")
    fault = next(reading for reading in source.step() if reading.machine_id == "MX-101")
    assert fault.process_temperature is None
    assert fault.data_quality_status == "missing_reading"


def test_training_data_and_model_inference_are_reproducible():
    x1, y1 = make_training_data(13, 1200)
    x2, y2 = make_training_data(13, 1200)
    assert x1.equals(x2)
    assert (y1 == y2).all()
    model, metrics = trained_model(13, 1200)
    reading = SyntheticSource(13).step()[0].as_dict()
    probability, importance, outside = predict_reading(model, reading)
    assert 0 <= probability <= 1
    assert set(importance) == set(x1.columns)
    assert isinstance(outside, bool)
    assert metrics["test_rows"] == 300
    assert 0 <= metrics["pr_auc"] <= 1


def test_rule_risk_recommendation_inputs_and_costs():
    reading = {"process_temperature": 80, "torque": 90, "rotational_speed": 1450,
               "tool_wear": 250, "data_quality_status": "good"}
    violations = threshold_violations(reading)
    assert len(violations) == 3
    assert classify_risk(0.3) == "ELEVATED"
    assert classify_risk(0.65) == "CRITICAL"
    assert priority_score(0.5, 0.8, 0.5, 1.0) == 20
    assert cost_scenario(0.5, 100, 1000, 200)["expected_loss"] == 600
    custom_limits = {"process_temperature": 60, "torque": 80, "rotational_speed_low": 800,
                     "rotational_speed_high": 2100, "tool_wear": 240}
    assert threshold_violations({"process_temperature": 65, "torque": 70}, custom_limits)


def test_sensor_validation_normalizes_missing_and_implausible_values():
    reading = SyntheticSource(3).step()[0].as_dict()
    normalized, warnings = validate_reading(reading)
    assert warnings == []
    assert normalized["data_quality_status"] == "good"
    reading["torque"] = "bad sensor payload"
    normalized, warnings = validate_reading(reading)
    assert normalized["torque"] is None
    assert normalized["data_quality_status"] == "invalid_reading"
    assert warnings
    reading["torque"] = 50
    reading["data_quality_status"] = "sensor_stale"
    normalized, warnings = validate_reading(reading)
    assert normalized["data_quality_status"] == "sensor_stale"
    assert warnings


def test_event_deduplication_and_status(tmp_path):
    database = tmp_path / "events.sqlite"
    event = {"timestamp": "2026-10-25T12:00:00+00:00", "machine_id": "MX-101",
             "event_type": "Engineering rule", "condition": "hot", "severity": "High",
             "probability": 0.42, "recommended_action": "Inspect", "fingerprint": "MX-101|hot"}
    assert record_event(event, database)
    assert not record_event(event, database)
    rows = list_events(database, status="Open")
    assert len(rows) == 1
    set_event_status(rows[0]["id"], "Acknowledged", database)
    assert list_events(database, status="Open") == []
    assert list_events(database, status="Acknowledged")[0]["condition"] == "hot"
    set_event_status(rows[0]["id"], "Resolved", database)
    event["timestamp"] = "2026-10-25T12:05:00+00:00"
    assert record_event(event, database)
    assert len(list_events(database, status="Open")) == 1