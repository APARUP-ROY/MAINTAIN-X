from __future__ import annotations

import math


SENSOR_BOUNDS = {
    "air_temperature": (-40.0, 100.0),
    "process_temperature": (-40.0, 200.0),
    "rotational_speed": (0.0, 10000.0),
    "torque": (0.0, 500.0),
    "tool_wear": (0.0, 1000.0),
}


def validate_reading(reading: dict) -> tuple[dict, list[str]]:
    """Normalize one source record and flag missing or implausible sensor values."""
    normalized = dict(reading)
    warnings = []
    source_quality = normalized.get("data_quality_status", "good")
    if not normalized.get("machine_id"):
        warnings.append("Missing machine identifier")
    if source_quality != "good":
        warnings.append(f"Source quality flag: {source_quality}")
    for field, (minimum, maximum) in SENSOR_BOUNDS.items():
        value = normalized.get(field)
        if value is None:
            warnings.append(f"Missing {field.replace('_', ' ')}")
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            normalized[field] = None
            warnings.append(f"Invalid {field.replace('_', ' ')}")
            continue
        if not math.isfinite(numeric) or not minimum <= numeric <= maximum:
            normalized[field] = None
            warnings.append(f"{field.replace('_', ' ').title()} outside accepted ingestion range")
        else:
            normalized[field] = numeric
    if any("Invalid" in note or "outside accepted" in note for note in warnings):
        normalized["data_quality_status"] = "invalid_reading"
    elif source_quality != "good":
        normalized["data_quality_status"] = source_quality
    elif warnings:
        normalized["data_quality_status"] = "missing_reading"
    else:
        normalized["data_quality_status"] = "good"
    normalized.setdefault("source", "unknown")
    return normalized, warnings