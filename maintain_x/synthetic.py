from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from .schemas import SensorReading


MACHINES = {
    "MX-101": {"type": "CNC Lathe", "air": 24.0, "process": 34.0, "rpm": 1540.0, "torque": 38.0, "wear": 42.0, "profile": "healthy"},
    "MX-204": {"type": "Hydraulic Press", "air": 26.0, "process": 48.0, "rpm": 1180.0, "torque": 52.0, "wear": 88.0, "profile": "rising_temperature"},
    "MX-317": {"type": "Conveyor Drive", "air": 25.0, "process": 42.0, "rpm": 1460.0, "torque": 66.0, "wear": 112.0, "profile": "excess_torque"},
    "MX-422": {"type": "CNC Mill", "air": 23.0, "process": 39.0, "rpm": 1720.0, "torque": 48.0, "wear": 184.0, "profile": "progressive_wear"},
    "MX-508": {"type": "Pump Assembly", "air": 27.0, "process": 54.0, "rpm": 1080.0, "torque": 78.0, "wear": 218.0, "profile": "combined_stress"},
}


class SyntheticSource:
    """Seeded demonstration source implementing the future sensor-source contract."""

    def __init__(self, seed: int = 42):
        self.seed = int(seed)
        self.rng = np.random.default_rng(self.seed)
        self.tick = 0
        self.wear = {machine_id: float(spec["wear"]) for machine_id, spec in MACHINES.items()}
        self.injections: dict[str, dict[str, int]] = {machine_id: {} for machine_id in MACHINES}

    def inject(self, machine_id: str, anomaly: str, ticks: int = 8) -> None:
        if machine_id not in MACHINES:
            raise ValueError(f"Unknown machine: {machine_id}")
        if anomaly not in {"high_temperature", "excess_torque", "wear", "sensor_fault"}:
            raise ValueError(f"Unknown anomaly: {anomaly}")
        self.injections[machine_id][anomaly] = max(1, int(ticks))
        if anomaly == "wear":
            self.wear[machine_id] = min(300.0, self.wear[machine_id] + 36.0)

    def step(self) -> list[SensorReading]:
        self.tick += 1
        now = datetime.now(timezone.utc)
        readings = []
        for machine_id, spec in MACHINES.items():
            profile = spec["profile"]
            phase = self.tick / 7.0
            wear_drift = 0.12 if profile in {"progressive_wear", "combined_stress"} else 0.025
            self.wear[machine_id] = min(300.0, self.wear[machine_id] + wear_drift)
            air = float(spec["air"] + 0.8 * np.sin(phase + len(machine_id)) + self.rng.normal(0, 0.22))
            temp_drift = (self.tick * 0.48 if profile == "rising_temperature" else 0.0)
            process = float(spec["process"] + temp_drift + 0.018 * self.wear[machine_id] + self.rng.normal(0, 0.65))
            rpm = float(spec["rpm"] + 18 * np.sin(phase) + self.rng.normal(0, 12))
            if profile == "combined_stress":
                rpm += 62 * np.sin(phase * 0.8)
            torque = float(spec["torque"] + self.rng.normal(0, 1.8) + 0.025 * max(process - 40, 0))
            injections = self.injections[machine_id]
            if "high_temperature" in injections:
                process += 18.0
            if "excess_torque" in injections:
                torque += 24.0
            quality = "good"
            if "sensor_fault" in injections:
                process = None
                quality = "missing_reading"
            readings.append(SensorReading(
                timestamp=now,
                machine_id=machine_id,
                air_temperature=round(air, 2),
                process_temperature=round(process, 2) if process is not None else None,
                rotational_speed=round(rpm, 1),
                torque=round(torque, 2),
                tool_wear=round(self.wear[machine_id], 1),
                operating_state="RUNNING",
                data_quality_status=quality,
            ))
            for anomaly in list(injections):
                injections[anomaly] -= 1
                if injections[anomaly] <= 0:
                    del injections[anomaly]
        return readings