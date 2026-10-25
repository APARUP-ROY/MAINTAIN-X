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

## Connect sensors to the dashboard

MAINTAIN-X does not connect directly to a sensor or translate a vendor-specific protocol. The data path is:

```text
Sensor → PLC / vendor gateway / edge adapter → MAINTAIN-X API → SQLite → dashboard
```

The gateway or adapter must read the physical sensor values, map them to the MAINTAIN-X JSON fields, and send readings using **REST** or publish them to an **MQTT broker** that MAINTAIN-X can reach. Browser WebSockets are only used to refresh the dashboard; sensors must not send data to the browser or `/ws`.

### 1. Register the machine

In the dashboard, select **Add machine** and enter:

- A unique machine ID, such as `PRESS-01`
- A display name, such as `North line hydraulic press`
- Equipment type and criticality
- Optionally, machine-specific alert limits supported by a manufacturer document or site-engineering reference

The gateway must send the same machine ID with every reading. It is the identifier used to associate measurements with the asset. Registering the asset first lets you set its display name, criticality, and limits before readings arrive. If a reading arrives for an unregistered ID, the API may create an asset using that ID as its initial name; register it in the dashboard afterward to manage its metadata.

Limits only generate dashboard alerts; they are **not machine controls**. Use engineering-approved values. Otherwise, the asset inherits the shared dashboard limits.

### 2. Choose how the gateway sends readings

| Method | Data path | Use it when |
| --- | --- | --- |
| REST | Gateway sends an authenticated HTTP `POST` directly to the MAINTAIN-X API | You want a direct, request/response integration |
| MQTT | Gateway publishes to a broker; MAINTAIN-X subscribes to the broker | Your site already uses MQTT or multiple consumers need the same stream |

Choose one or both methods. For either method, the gateway must be on the same host/network path as the API or broker, and its machine IDs and measurement names must match the examples below.

### REST: send readings over HTTP

#### Configure ingestion

Start the API with a strong `MAINTAINX_INGEST_TOKEN`. The Windows launcher asks for it using hidden input. **Do not press Enter at this prompt** if you want to accept device readings; a blank token leaves ingestion disabled. Give the same token to the trusted gateway using its secure secret store, not a source file or sensor payload. Restart the API after changing the token.

The local development endpoint is:

```text
POST http://127.0.0.1:8000/api/ingest/v1/readings
Authorization: Bearer <YOUR_INGEST_TOKEN>
Content-Type: application/json
```

`127.0.0.1` means “this computer.” It works only when the gateway runs on the same computer as the API. For a gateway on another host, place the API behind a secured private network or VPN and deliberately configure a reachable private interface, firewall rules, and HTTPS/transport protection. Do not expose the development server directly to the public internet. Use the full API address reachable from the gateway in place of `127.0.0.1`.

#### Send a test reading from PowerShell

With the API running, replace the sample ID and enter the same ingest token configured at API startup:

```powershell
$token = Read-Host "Sensor ingest token"
$headers = @{ Authorization = "Bearer $token" }
$body = @{
  machine_id = "PRESS-01"
  equipment_type = "Hydraulic press"
  air_temperature = 28.0
  process_temperature = 71.2
  rotational_speed = 1480
  torque = 82
  tool_wear = 140
  operating_state = "RUNNING"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8000/api/ingest/v1/readings" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

An accepted reading returns HTTP `200` and a JSON record. The API stores it and notifies the dashboard; a REST source indicator and the latest values should appear for the matching asset.

#### Payload reference

```json
{
  "machine_id": "PRESS-01",
  "equipment_type": "Hydraulic press",
  "timestamp": "2026-10-25T12:00:00Z",
  "air_temperature": 28.0,
  "process_temperature": 71.2,
  "rotational_speed": 1480,
  "torque": 82,
  "tool_wear": 140,
  "operating_state": "RUNNING"
}
```

`machine_id` is required. At least one numeric sensor value is also required. `equipment_type` defaults to `Industrial equipment`; `timestamp` and `operating_state` are optional. The supported numeric fields are:

| JSON field | Meaning | Example unit |
| --- | --- | --- |
| `air_temperature` | Ambient air temperature | °C |
| `process_temperature` | Machine/process temperature | °C |
| `rotational_speed` | Rotational speed | RPM |
| `torque` | Torque | Nm |
| `tool_wear` | Tool-wear index | Application-specific |

Send numbers (or `null` where no reading is available), not formatted strings with units. Include a timestamp when the gateway has one; the API uses its receipt time if it is omitted. Do not fabricate values for disconnected or unavailable sensors. Missing and invalid measurements are handled as data-quality issues.

### MQTT: publish readings through a broker

In MQTT mode, the MAINTAIN-X API is the **broker client/subscriber**; the gateway publishes to your broker. Configure these values in the **API server's process environment** before starting it:

| Variable | Description | Default |
| --- | --- | --- |
| `MQTT_BROKER_HOST` | Reachable broker hostname/IP; enables MQTT | Not configured |
| `MQTT_BROKER_PORT` | Broker port | `8883` with TLS; otherwise `1883` |
| `MQTT_TLS` | Enable TLS when set to `1` | `1` |
| `MQTT_USERNAME` | Optional broker username | Empty |
| `MQTT_PASSWORD` | Optional broker password | Empty |
| `MQTT_CLIENT_ID` | MAINTAIN-X subscriber client ID | `maintain-x-dashboard` |
| `MQTT_TOPIC` | Topic MAINTAIN-X subscribes to | `maintain-x/+/readings` |

Set the broker hostname and any credentials in the backend process environment; never place MQTT credentials in frontend settings. Restart the API after changing MQTT configuration. The dashboard's **Connections** view reports whether a broker is configured and connected.

Configure the gateway to publish the same JSON body as the REST example to a topic matching the subscriber filter. With the default filter, a topic such as `maintain-x/PRESS-01/readings` matches. The MQTT topic does not replace the required `machine_id` in the JSON body: both should identify the same asset. MQTT messages do not use the REST bearer header; secure MQTT access with broker authentication, TLS, and network policy. The API subscribes at QoS 1.

### 3. Confirm the data is flowing

1. Keep the API process running and open the dashboard.
2. Check the **Connections** view for the REST token status or MQTT broker connection.
3. Send a test reading with the exact registered machine ID.
4. Confirm the machine's latest timestamp, measurements, and source (`REST` or `MQTT`) update.
5. Send a reading beyond a configured alert threshold to verify the dashboard event flow, if safe and appropriate for your test data.

Simulation profiles are separate demonstration assets and update independently. Pause simulation in the dashboard if you want to focus on real-device readings.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| REST returns `503` | The API has no `MAINTAINX_INGEST_TOKEN`; restart it and enter a token at the hidden prompt. |
| REST returns `401` | The gateway's bearer token does not exactly match the API token. |
| REST returns `422` | Check required `machine_id`, JSON syntax/types, field names, and that at least one numeric measurement is present. |
| REST cannot connect | Confirm the API is running on port `8000`. `127.0.0.1` only works for a gateway on the API host; check private routing and firewall rules for remote gateways. |
| MQTT says “Not configured” | `MQTT_BROKER_HOST` is missing from the API process environment; restart after setting it. |
| MQTT cannot connect | Check broker address/port, TLS setting, credentials, certificate trust, broker logs, and network/firewall access. |
| Reading is on a different asset or a duplicate-looking row appears | Ensure the JSON `machine_id` exactly matches the dashboard asset ID on every message. |
| No current/connected indication | Check that readings continue arriving and that gateway timestamps are valid/current; old readings can be marked stale. |

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
