# MAINTAIN-X

<p align="center">
  <img src="web/public/maintain-x-logo.png" alt="MAINTAIN-X logo" width="160" />
</p>

<p align="center">
  <strong>Industrial asset intelligence for a more reliable operation.</strong><br />
  Monitor machine health, investigate events, and connect sensor gateways from one live dashboard.
</p>

<p align="center">
  <img alt="Python 3.11+" src="https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="FastAPI" src="https://img.shields.io/badge/API-FastAPI-009688?logo=fastapi&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/Frontend-TypeScript-3178C6?logo=typescript&logoColor=white" />
</p>

MAINTAIN-X is a maintenance monitoring and analytics application for industrial equipment. A FastAPI service receives and validates machine readings, SQLite stores local operational history, and a React dashboard presents fleet health, rule-based alerts, events, and planning scenarios.

> **Demo data is not sensor data.** The optional simulator generates clearly labeled demonstration signals; it does not represent physical measurements or predict equipment failure.

## At a glance

- Live dashboard for assets, readings, recent events, and connection status
- Authenticated REST ingestion and optional MQTT gateway integration
- Shared alert thresholds and engineering-referenced machine-specific limits
- Reading validation, data-quality flags, and deduplicated threshold events
- Corrective-action notes, event exports, printable reports, and downtime scenarios
- Optional Groq-powered assistant, configured and called by the backend

## Stack

| Layer | Technologies |
| --- | --- |
| Dashboard | React 19, TypeScript, Vite, Recharts |
| API | Python, FastAPI, Pydantic, Uvicorn |
| Local storage | SQLite |
| Analytics | pandas, NumPy, scikit-learn |
| Device messaging | REST; optional MQTT via paho-mqtt |
| Assistant | Optional Groq OpenAI-compatible API |

## Project structure

```text
maintain_x/    API, persistence, validation, risk rules, and simulation
web/           React dashboard and static assets
tests/         Backend and API tests
requirements.txt
start_api.ps1  Windows API launcher with hidden secret prompts
```

## Get started

### Requirements

- Python 3.11 or newer
- Node.js 20 or newer
- Windows PowerShell for the included API launcher

### Install

From the project root:

```powershell
python -m pip install -r requirements.txt
npm install --prefix web
```

### Run the API

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File start_api.ps1
```

The launcher asks for a sensor-ingest token and an optional Groq API key using hidden input. Leave the token blank to keep device ingestion disabled; leave the Groq key blank to disable assistant chat. The API listens on `127.0.0.1:8000`.

### Run the dashboard

Open a second terminal in the project root:

```powershell
npm run dev --prefix web
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies API and WebSocket traffic to the local backend.

### Run the API without the launcher

Set secrets in the API process environment, then run Uvicorn:

```powershell
$env:MAINTAINX_INGEST_TOKEN = "replace-with-a-long-random-secret"
$env:GROQ_API_KEY = "your-groq-api-key"
$env:GROQ_MODEL = "openai/gpt-oss-120b"
python -m uvicorn maintain_x.live_api:app --host 127.0.0.1 --port 8000
```

The Groq variables are optional. Never put credentials in frontend environment variables, QR labels, source control, or sensor payloads.

## Connect a machine

1. In the dashboard, choose **Add machine** and provide a machine ID, display name, equipment type, and criticality.
2. Optionally configure machine-specific limits for process temperature, torque, RPM, and tool wear. Otherwise, the machine uses the shared limits.
3. For custom limits, cite a manufacturer document or site-engineering reference. These limits trigger dashboard alerts; they are **not machine controls**.
4. Configure the trusted gateway with the ingest token supplied to the API process.

### REST ingestion

Send a JSON `POST` request to:

```text
http://127.0.0.1:8000/api/ingest/v1/readings
```

Required headers:

```text
Authorization: Bearer <YOUR_INGEST_TOKEN>
Content-Type: application/json
```

Example body:

```json
{
  "machine_id": "PRESS-01",
  "equipment_type": "Hydraulic press",
  "air_temperature": 28.0,
  "process_temperature": 71.2,
  "rotational_speed": 1480,
  "torque": 82,
  "tool_wear": 140,
  "operating_state": "RUNNING"
}
```

At least one numeric measurement is required. Supported measurements are `air_temperature`, `process_temperature`, `rotational_speed`, `torque`, and `tool_wear`. `timestamp` and `operating_state` are optional. Send actual available measurements; missing values are treated as data-quality gaps, not estimated values. Use a consistent `machine_id` to associate incoming readings with the dashboard asset.

The API accepts readings only when `MAINTAINX_INGEST_TOKEN` is configured and the bearer token matches. A successful `200` response indicates the reading was accepted.

### MQTT ingestion

MQTT is optional and starts only when `MQTT_BROKER_HOST` is set. Configure the broker, topic, and any credentials in the backend environment. TLS port `8883` is the default. MQTT messages use the same JSON fields and machine-ID mapping as REST.

## Assistant, events, and reports

The optional assistant uses the Groq OpenAI-compatible API from the backend. It can use the selected machine's readings, configured rules, and recent events as context. Its responses are suggestions only; follow site procedures and qualified engineering review.

Critical and attention states are based on configured threshold rules, not a live-trained failure model. Downtime costs are editable planning scenarios based on hourly-cost, repair-duration, and criticality assumptions; they are not known costs or guarantees. Reports include recorded events and corrective-action notes.

## QR labels

To make QR links open from a phone, set `VITE_PUBLIC_DASHBOARD_URL` in `web/.env.local` to a dashboard address reachable from that device before starting Vite. The QR code opens an asset view only. It does not pair hardware, authenticate a sensor, or contain credentials.

## Configuration

Examples are provided in the root `.env.example` and `web/.env.example`. Configure secrets only in the backend environment. Useful optional backend settings include:

| Variable | Purpose |
| --- | --- |
| `MAINTAINX_INGEST_TOKEN` | Enables authenticated REST ingestion |
| `MAINTAINX_CORS_ORIGINS` | Allowed browser origins |
| `MAINTAINX_LIVE_DB` | SQLite database location |
| `MAINTAINX_SIMULATION_ENABLED` | Enables/disables generated demo signals |
| `GROQ_API_KEY`, `GROQ_MODEL` | Optional assistant provider configuration |
| `MQTT_BROKER_HOST` and `MQTT_*` | Optional MQTT broker configuration |

## Verify

Run the backend tests and frontend production build:

```powershell
python -m pytest -q
npm run build --prefix web
```

## Security and network notes

- The development API binds to loopback by default and is intended for local development.
- `127.0.0.1` is reachable only from the same computer. A remote gateway needs a deliberately configured private network or VPN, firewall rules, and transport protection.
- Do not expose this development API directly to the public internet.
- Keep ingest and provider credentials out of browser code, QR codes, payloads, and committed files.
- Restart the API process after changing its environment secrets.
