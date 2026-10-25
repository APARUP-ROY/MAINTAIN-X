ENGINEERING_LIMITS = {"process_temperature": 70.0, "torque": 85.0,
                      "rotational_speed_low": 800.0, "rotational_speed_high": 2100.0,
                      "tool_wear": 240.0}


def classify_risk(probability: float, watch: float = 0.30, high: float = 0.65) -> str:
    if probability >= high:
        return "CRITICAL"
    if probability >= watch:
        return "ELEVATED"
    return "NORMAL"


def threshold_violations(reading: dict, limits: dict | None = None) -> list[str]:
    limits = limits or ENGINEERING_LIMITS
    violations = []
    temp, torque = reading.get("process_temperature"), reading.get("torque")
    rpm, wear = reading.get("rotational_speed"), reading.get("tool_wear")
    if temp is not None and temp > limits["process_temperature"]:
        violations.append(f"Process temperature {temp:.1f} C exceeds demo limit {limits['process_temperature']:g} C")
    if torque is not None and torque > limits["torque"]:
        violations.append(f"Torque {torque:.1f} Nm exceeds demo limit {limits['torque']:g} Nm")
    if rpm is not None and not limits["rotational_speed_low"] <= rpm <= limits["rotational_speed_high"]:
        violations.append(f"Speed {rpm:.0f} rpm is outside demo band {limits['rotational_speed_low']:g}-{limits['rotational_speed_high']:g} rpm")
    if wear is not None and wear > limits["tool_wear"]:
        violations.append(f"Wear {wear:.1f} exceeds demo indicator limit {limits['tool_wear']:g}")
    if reading.get("data_quality_status", "good") != "good":
        violations.append("Sensor reading is missing or flagged for quality review")
    return violations


def recommendation(reading: dict, probability: float, risk: str,
                   limits: dict | None = None) -> tuple[str, str]:
    limits = limits or ENGINEERING_LIMITS
    violations = threshold_violations(reading, limits)
    evidence = "; ".join(violations)
    if reading.get("data_quality_status", "good") != "good":
        return "Verify sensor readings", evidence
    if reading.get("process_temperature") is not None and reading["process_temperature"] > limits["process_temperature"]:
        return "Inspect cooling system", evidence
    if reading.get("torque") is not None and reading["torque"] > limits["torque"]:
        return "Check for excessive load", evidence
    if reading.get("tool_wear") is not None and reading["tool_wear"] > limits["tool_wear"]:
        return "Investigate abnormal wear", evidence
    if risk == "CRITICAL":
        return "Escalate for qualified engineering review", "Model risk exceeds the configured critical threshold."
    if risk == "ELEVATED":
        return "Schedule an inspection", "Model-estimated risk exceeds the configured watch threshold."
    return "Continue monitoring", "No configured threshold violation; continue synthetic monitoring."


def priority_score(probability: float, consequence: float, criticality: float, urgency: float) -> float:
    if any(not 0 <= float(value) <= 1 for value in (probability, consequence, criticality, urgency)):
        raise ValueError("Priority inputs must be between 0 and 1")
    return round(100 * probability * consequence * criticality * urgency, 1)


def cost_scenario(probability: float, maintenance_cost: float, consequence_cost: float, downtime_cost: float) -> dict[str, float]:
    if min(maintenance_cost, consequence_cost, downtime_cost) < 0:
        raise ValueError("Costs cannot be negative")
    expected_loss = probability * (consequence_cost + downtime_cost)
    return {"expected_loss": round(expected_loss, 2), "maintenance_cost": round(maintenance_cost, 2),
            "illustrative_net_exposure": round(expected_loss - maintenance_cost, 2)}