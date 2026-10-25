from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, confusion_matrix, f1_score, precision_score, recall_score
from sklearn.model_selection import train_test_split

FEATURES = ["air_temperature", "process_temperature", "rotational_speed", "torque", "tool_wear", "temperature_rise"]


def make_training_data(seed: int = 42, rows: int = 12000) -> tuple[pd.DataFrame, np.ndarray]:
    """Generate labels from synthetic stress combinations, without future or label inputs."""
    rng = np.random.default_rng(seed)
    air = rng.normal(25, 4.5, rows).clip(12, 42)
    process = rng.normal(47, 13, rows).clip(20, 95)
    rpm = rng.normal(1450, 260, rows).clip(650, 2300)
    torque = rng.normal(58, 19, rows).clip(12, 120)
    wear = rng.gamma(2.2, 62, rows).clip(0, 300)
    rise = process - air
    heat = np.maximum((process - 62) / 18, 0)
    load = np.maximum((torque - 72) / 35, 0)
    speed = np.maximum((np.abs(rpm - 1450) - 280) / 500, 0)
    wear_stress = np.maximum((wear - 145) / 155, 0)
    combined = 1.25 * heat * load + 0.65 * load * wear_stress
    stress = 0.9 * heat + 0.85 * load + 0.55 * speed + 0.9 * wear_stress + combined
    probability = 1 / (1 + np.exp(-4.2 * (stress - 1.05)))
    labels = (rng.random(rows) < probability).astype(int)
    frame = pd.DataFrame({"air_temperature": air, "process_temperature": process,
                          "rotational_speed": rpm, "torque": torque, "tool_wear": wear,
                          "temperature_rise": rise})
    return frame[FEATURES], labels


def train_and_evaluate(seed: int = 42, rows: int = 12000) -> tuple[RandomForestClassifier, dict]:
    features, labels = make_training_data(seed, rows)
    x_train, x_test, y_train, y_test = train_test_split(
        features, labels, test_size=0.25, random_state=seed, stratify=labels)
    classifier = RandomForestClassifier(n_estimators=180, min_samples_leaf=3,
        class_weight="balanced", random_state=seed, n_jobs=1)
    classifier.fit(x_train, y_train)
    probabilities = classifier.predict_proba(x_test)[:, 1]
    predictions = (probabilities >= 0.5).astype(int)
    matrix = confusion_matrix(y_test, predictions).tolist()
    metrics = {"precision": float(precision_score(y_test, predictions, zero_division=0)),
               "recall": float(recall_score(y_test, predictions, zero_division=0)),
               "f1": float(f1_score(y_test, predictions, zero_division=0)),
               "pr_auc": float(average_precision_score(y_test, probabilities)),
               "confusion_matrix": matrix, "test_rows": int(len(y_test)),
               "positive_rate": float(y_test.mean())}
    return classifier, metrics


def reading_features(reading: dict) -> pd.DataFrame:
    air, process = reading.get("air_temperature"), reading.get("process_temperature")
    values = {key: reading.get(key) for key in FEATURES if key != "temperature_rise"}
    values["temperature_rise"] = process - air if process is not None and air is not None else np.nan
    return pd.DataFrame([values], columns=FEATURES)


def trained_model(seed: int = 42, rows: int = 12000) -> tuple[RandomForestClassifier, dict]:
    classifier, metrics = train_and_evaluate(seed, rows)
    features, _ = make_training_data(seed, rows)
    classifier._maintain_x_min = features.min().to_numpy()
    classifier._maintain_x_max = features.max().to_numpy()
    classifier._maintain_x_median = features.median().to_numpy()
    return classifier, metrics


def predict_reading(classifier: RandomForestClassifier, reading: dict) -> tuple[float, dict[str, float], bool]:
    features = reading_features(reading)
    out_of_range = False
    for index, key in enumerate(FEATURES):
        low, high = classifier._maintain_x_min[index], classifier._maintain_x_max[index]
        value = features.iloc[0][key]
        if pd.isna(value):
            features.loc[0, key] = classifier._maintain_x_median[index]
        elif value < low or value > high:
            out_of_range = True
    probability = float(classifier.predict_proba(features)[0, 1])
    ablations = features.loc[features.index.repeat(len(FEATURES))].reset_index(drop=True)
    for index, key in enumerate(FEATURES):
        ablations.loc[index, key] = classifier._maintain_x_median[index]
    ablated_probabilities = classifier.predict_proba(ablations)[:, 1]
    contributions = {key: probability - float(ablated_probabilities[index])
                     for index, key in enumerate(FEATURES)}
    return probability, contributions, out_of_range