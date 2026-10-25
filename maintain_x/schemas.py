from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any


@dataclass
class SensorReading:
    timestamp: datetime
    machine_id: str
    air_temperature: float | None
    process_temperature: float | None
    rotational_speed: float | None
    torque: float | None
    tool_wear: float | None
    operating_state: str
    source: str = "synthetic"
    data_quality_status: str = "good"

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)