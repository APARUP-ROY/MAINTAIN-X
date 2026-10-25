from __future__ import annotations

from datetime import datetime, timezone

import numpy as np


DEMO_MACHINES = {
    "SIM-101": {"equipment_type": "CNC Lathe", "air": 24.0, "process": 43.0, "rpm": 1480.0, "torque": 44.0, "wear": 38.0, "profile": "healthy"},
    "SIM-204": {"equipment_type": "Hydraulic Press", "air": 27.0, "process": 68.0, "rpm": 1180.0, "torque": 62.0, "wear": 92.0, "profile": "thermal"},
    "SIM-317": {"equipment_type": "Conveyor Drive", "air": 25.0, "process": 51.0, "rpm": 1460.0, "torque": 89.0, "wear": 116.0, "profile": "load"},
    "SIM-422": {"equipment_type": "CNC Mill", "air": 23.0, "process": 48.0, "rpm": 1710.0, "torque": 54.0, "wear": 250.0, "profile": "wear"},
    "SIM-508": {"equipment_type": "Pump Assembly", "air": 28.0, "process": 83.0, "rpm": 1120.0, "torque": 111.0, "wear": 286.0, "profile": "combined"},
}


class OneSecondSimulation:
    """Deterministic, explicitly synthetic sensor stream for UI demonstrations."""

    def __init__(self, seed: int = 42):
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.tick = 0
        self.running = False
        self.removed: set[str] = set()
        self.wear = {machine_id: values["wear"] for machine_id, values in DEMO_MACHINES.items()}

    def step(self) -> list[dict]:
        self.tick += 1
        timestamp = datetime.now(timezone.utc).isoformat()
        result = []
        for index, (machine_id, spec) in enumerate(DEMO_MACHINES.items()):
            if machine_id in self.removed:
                continue
            profile = spec["profile"]
            phase = self.tick / 8 + index
            process = spec["process"] + 0.8 * np.sin(phase) + self.rng.normal(0, 0.24)
            torque = spec["torque"] + 1.2 * np.sin(phase / 2) + self.rng.normal(0, 0.8)
            rpm = spec["rpm"] + 14 * np.sin(phase) + self.rng.normal(0, 7)
            if profile == "thermal":
                process += 4.0 + 1.4 * np.sin(self.tick / 12)
                torque += 0.13 * max(process - 60, 0)
            if profile == "load":
                torque += 1.5 + 1.5 * np.sin(self.tick / 10)
            if profile == "wear":
                self.wear[machine_id] = min(300, self.wear[machine_id] + 0.12)
                process += 0.035 * (self.wear[machine_id] - spec["wear"])
                torque += 0.02 * (self.wear[machine_id] - spec["wear"])
            if profile == "combined":
                process += 1.6 * np.sin(self.tick / 15)
                torque += 1.8 * np.sin(self.tick / 11)
                rpm += 28 * np.sin(self.tick / 9)
            result.append({
                "timestamp": timestamp,
                "machine_id": machine_id,
                "equipment_type": spec["equipment_type"],
                "air_temperature": round(float(spec["air"] + 0.5 * np.sin(phase / 2) + self.rng.normal(0, 0.1)), 2),
                "process_temperature": round(float(process), 2),
                "rotational_speed": round(float(rpm), 1),
                "torque": round(float(torque), 2),
                "tool_wear": round(float(self.wear[machine_id]), 2),
                "operating_state": "RUNNING",
            })
        return result

    def reset(self) -> None:
        self.tick = 0
        self.rng = np.random.default_rng(self.seed)
        self.wear = {machine_id: values["wear"] for machine_id, values in DEMO_MACHINES.items()}
        self.removed.clear()