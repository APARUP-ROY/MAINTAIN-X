import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity, AlertCircle, AlertTriangle, Anchor, ArrowDownToLine, ArrowLeft, ArrowRight,
  Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3,
  Code, Copy, Cpu, Download, Gauge, HardDrive, Link2,
  LoaderCircle, MessageSquare, Plus, Printer, QrCode, Radio, RefreshCw,
  Search, Send, Settings2, ShieldCheck, Sliders, Terminal, Thermometer,
  Wrench, X, Zap,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

const API = import.meta.env.VITE_API_BASE ?? ''
const QR_DASHBOARD_URL = import.meta.env.VITE_PUBLIC_DASHBOARD_URL ?? window.location.origin

type Assessment = {
  risk: 'Critical' | 'Attention' | 'Normal' | 'No data'
  violations: string[]
  condition_codes: string[]
  recommended_action: string
}
type Machine = {
  machine_id: string
  machine_name: string
  equipment_type: string
  criticality: number
  created_at: string
  id?: number | null
  timestamp?: string | null
  air_temperature?: number | null
  process_temperature?: number | null
  rotational_speed?: number | null
  torque?: number | null
  tool_wear?: number | null
  operating_state?: string | null
  source?: string | null
  data_quality_status?: string | null
  risk: Assessment['risk']
  assessment: Assessment
  downtime_scenario?: { rate_per_hour: number; repair_hours: number; estimated_cost: number }
  limit_profile?: MachineLimitProfile
}
type Event = {
  id: number
  machine_id: string
  timestamp: string
  event_type: string
  condition: string
  severity: string
  status: string
  recommended_action: string
}
type Dashboard = {
  machines: Machine[]
  events: Event[]
  metrics: { total: number; critical: number; attention: number; normal: number; real_connected: number; simulation_assets: number; actions_due: number; open_events: number }
  connections: { rest: { name: string; port: number; configured: boolean; endpoint: string }; mqtt: { configured: boolean; connected: boolean; detail: string; host: string; port: number }; websocket: string; simulation: { enabled: boolean; source: string; tick: number; interval_seconds: number; machines: number } }
}
type Limits = { process_temperature: number; torque: number; rotational_speed_low: number; rotational_speed_high: number; tool_wear: number; downtime_cost_per_hour: number; estimated_repair_hours: number }
type MachineLimitProfile = Pick<Limits, 'process_temperature' | 'torque' | 'rotational_speed_low' | 'rotational_speed_high' | 'tool_wear'> & {
  mode: 'inherit' | 'custom'
  source: 'manufacturer' | 'site_engineering' | 'inherited_default'
  reference: string
  updated_at?: string | null
}
type ChatMessage = { role: 'user' | 'assistant'; content: string }
type View = 'Fleet' | 'Events' | 'Connections'

const fallbackLimits: Limits = { process_temperature: 70, torque: 85, rotational_speed_low: 800, rotational_speed_high: 2100, tool_wear: 240, downtime_cost_per_hour: 350, estimated_repair_hours: 3 }
const riskLabels = ['All risks', 'Critical', 'Attention', 'Normal', 'No data']

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(detail.detail ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function fmt(value: number | null | undefined, unit = '') {
  return value == null ? 'No reading' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ''}`
}

function relativeTime(value?: string | null) {
  if (!value) return 'Awaiting first reading'
  const date = new Date(value)
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 5) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return date.toLocaleString()
}

function useLiveDashboard() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true
    let socket: WebSocket | undefined
    let retryTimer: number | undefined
    let retryDelay = 1200
    const refresh = async () => {
      try {
        const next = await request<Dashboard>('/api/dashboard')
        if (mounted) { setData(next); setError('') }
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : 'API unavailable')
      }
    }
    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${scheme}//${window.location.host}/ws`)
      socket.onopen = () => { retryDelay = 1200; if (mounted) setConnected(true) }
      socket.onmessage = () => { void refresh() }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        if (!mounted) return
        setConnected(false)
        retryTimer = window.setTimeout(connect, retryDelay)
        retryDelay = Math.min(retryDelay * 1.7, 12000)
      }
    }
    void refresh()
    connect()
    const poll = window.setInterval(() => { if (!socket || socket.readyState !== WebSocket.OPEN) void refresh() }, 12000)
    return () => {
      mounted = false
      window.clearInterval(poll)
      if (retryTimer) window.clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  const refresh = async () => {
    try { setData(await request<Dashboard>('/api/dashboard')); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'API unavailable') }
  }
  return { data, connected, error, refresh }
}

function IconButton({ label, children, onClick, className = '' }: { label: string; children: React.ReactNode; onClick: () => void; className?: string }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick}>{children}</button>
}

function RiskPill({ risk }: { risk: string }) {
  return <span className={`risk-pill risk-${risk.toLowerCase().replaceAll(' ', '-')}`}><i />{risk}</span>
}

function EmptyFleet({ onRegister, onConnections }: { onRegister: () => void; onConnections: () => void }) {
  return <section className="empty-fleet">
    <div className="empty-glyph"><Radio size={24} strokeWidth={1.6} /></div>
    <p className="eyebrow">LIVE ASSET NETWORK</p>
    <h2>Ready for your first machine.</h2>
    <p className="empty-copy">The fleet will populate when equipment sends a reading. Register an asset, then connect a gateway over authenticated REST or MQTT.</p>
    <div className="empty-actions"><button className="button-primary" onClick={onRegister}><Plus size={16} /> Register asset</button><button className="button-secondary" onClick={onConnections}><Link2 size={15} /> Connection setup</button></div>
    <div className="connection-snippet"><span className="snippet-label"><span className="online-dot" /> REST INGEST · PORT 8000</span><code>POST /api/ingest/v1/readings</code><span className="snippet-note">Waiting for an authenticated device payload</span></div>
  </section>
}

function AddMachineModal({ close, onCreated, shared }: { close: () => void; onCreated: () => void; shared: Limits }) {
  const [machine, setMachine] = useState('')
  const [name, setName] = useState('')
  const [equipment, setEquipment] = useState('')
  const [criticality, setCriticality] = useState('1')
  const [customLimits, setCustomLimits] = useState(false)
  const [profile, setProfile] = useState<MachineLimitProfile>({
    mode: 'custom', ...shared, source: 'site_engineering', reference: '',
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await request('/api/machines', { method: 'POST', body: JSON.stringify({
        machine_id: machine.trim(), machine_name: name.trim(),
        equipment_type: equipment.trim() || 'Industrial equipment',
        criticality: Number(criticality),
        ...(customLimits ? { limits: profile } : {}),
      }) })
      onCreated(); close()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not register asset') }
    finally { setBusy(false) }
  }
  function setNumber(key: keyof Pick<MachineLimitProfile, 'process_temperature' | 'torque' | 'rotational_speed_low' | 'rotational_speed_high' | 'tool_wear'>, value: number) {
    setProfile(current => ({ ...current, [key]: value }))
  }
  return <Modal title="Register a machine" close={close} wide>
    <p className="modal-intro">Give the machine a recognizable name and ID, then optionally enter its equipment-specific alert limits. It will await its first sensor reading after registration.</p>
    <form className="form-stack machine-registration" onSubmit={submit}>
      <div className="registration-fields">
        <label>Machine name<input required value={name} onChange={event => setName(event.target.value)} placeholder="e.g. North Line Hydraulic Press" maxLength={120} /></label>
        <label>Machine ID<input required value={machine} onChange={event => setMachine(event.target.value)} placeholder="e.g. PRESS-01" maxLength={128} /></label>
        <label>Equipment type<input value={equipment} onChange={event => setEquipment(event.target.value)} placeholder="Hydraulic press" maxLength={120} /></label>
        <label>Relative machine criticality<select value={criticality} onChange={event => setCriticality(event.target.value)}><option value="0.5">0.5 · Standard</option><option value="1">1.0 · Standard</option><option value="2">2.0 · Important</option><option value="3">3.0 · High consequence</option><option value="5">5.0 · Essential process</option></select></label>
      </div>
      <section className="registration-limits">
        <label className="custom-limits-toggle"><input type="checkbox" checked={customLimits} onChange={event => setCustomLimits(event.target.checked)} /><span><strong>Set machine-specific alert limits</strong><small>Otherwise this machine inherits the shared limits in Connections.</small></span></label>
        {customLimits && <>
          <p className="profile-current-note">Enter limits approved for this machine. These determine dashboard alerts; they do not control or stop the equipment.</p>
          <div className="machine-profile-fields">
            <LimitInput label="Process temperature" unit="°C" value={profile.process_temperature} onChange={value => setNumber('process_temperature', value)} />
            <LimitInput label="Torque" unit="Nm" value={profile.torque} onChange={value => setNumber('torque', value)} />
            <LimitInput label="RPM lower" unit="rpm" value={profile.rotational_speed_low} onChange={value => setNumber('rotational_speed_low', value)} />
            <LimitInput label="RPM upper" unit="rpm" value={profile.rotational_speed_high} onChange={value => setNumber('rotational_speed_high', value)} />
            <LimitInput label="Wear indicator" unit="index" value={profile.tool_wear} onChange={value => setNumber('tool_wear', value)} />
          </div>
          <div className="provenance-fields">
            <label>Threshold source<select value={profile.source === 'manufacturer' ? 'manufacturer' : 'site_engineering'} onChange={event => setProfile({ ...profile, source: event.target.value as 'manufacturer' | 'site_engineering' })}><option value="manufacturer">Manufacturer manual / data sheet</option><option value="site_engineering">Site engineering approval</option></select></label>
            <label>Reference<input required value={profile.reference} onChange={event => setProfile({ ...profile, reference: event.target.value })} placeholder="Document title, revision, page, approval ID" maxLength={300} /></label>
          </div>
        </>}
      </section>
      {error && <p className="form-error">{error}</p>}
      <button className="button-primary form-submit" disabled={busy || (customLimits && profile.rotational_speed_high <= profile.rotational_speed_low)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Register machine</button>
    </form>
  </Modal>
}

function LogActionModal({ machine, close, onSaved }: { machine: Machine; close: () => void; onSaved: () => void }) {
  const [action, setAction] = useState(machine.assessment.recommended_action)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await request('/api/actions', { method: 'POST', body: JSON.stringify({ machine_id: machine.machine_id, action, notes }) })
      onSaved(); close()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save action') }
    finally { setBusy(false) }
  }
  return <Modal title={`Log maintenance action · ${machine.machine_id}`} close={close}>
    <p className="modal-intro">Record work completed or an approved follow-up. This log does not issue commands to the equipment.</p>
    <form className="form-stack" onSubmit={submit}>
      <label>Action taken<input required value={action} onChange={event => setAction(event.target.value)} maxLength={180} /></label>
      <label>Notes<textarea rows={4} value={notes} onChange={event => setNotes(event.target.value)} placeholder="What was inspected? What was observed?" maxLength={2000} /></label>
      {error && <p className="form-error">{error}</p>}
      <button className="button-primary form-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save action</button>
    </form>
  </Modal>
}

function RemoveMachineModal({ machine, close, onRemoved }: { machine: Machine; close: () => void; onRemoved: () => void }) {
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    setBusy(true); setError('')
    try {
      await request(`/api/machines/${encodeURIComponent(machine.machine_id)}?confirmation=DELETE`, { method: 'DELETE' })
      onRemoved(); close()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove asset') }
    finally { setBusy(false) }
  }
  return <Modal title={`Remove ${machine.machine_id}?`} close={close}>
    <p className="modal-intro">This permanently deletes the asset’s readings, threshold events, and action notes from this local database. It does not delete or disconnect the physical sensor.</p>
    {machine.source === 'synthetic-demo' && <p className="modal-intro">Removing a demo asset also excludes it from subsequent simulation ticks. Resetting the demo restores the five starting profiles.</p>}
    <label className="confirm-delete">Type <strong>{machine.machine_id}</strong> to confirm<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
    {error && <p className="form-error">{error}</p>}
    <button className="button-danger" disabled={confirmation !== machine.machine_id || busy} onClick={() => void remove()}>{busy ? <LoaderCircle className="spin" size={15} /> : <X size={15} />} Permanently remove asset</button>
  </Modal>
}

function Modal({ title, close, children, wide = false, className = '' }: { title: string; close: () => void; children: React.ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [close])
  return <div className={`modal-backdrop ${className}`} onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><h2>{title}</h2><IconButton label="Close dialog" onClick={close}><X size={18} /></IconButton></header>{children}
    </section>
  </div>
}

function QRModal({ machines, sharedLimits, close, onConnect }: { machines: Machine[]; sharedLimits: Limits; close: () => void; onConnect: (machine: Machine) => void }) {
  const [copied, setCopied] = useState('')
  const [qrMode, setQrMode] = useState<'url' | 'provisioning'>('url')

  const handlePrint = () => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'visible'
    window.print()
    window.setTimeout(() => { document.body.style.overflow = prev }, 600)
  }

  async function copy(value: string, id: string) {
    await navigator.clipboard.writeText(value)
    setCopied(id)
    window.setTimeout(() => setCopied(''), 1500)
  }

  return <Modal title="Machine identification & sensor labels" close={close} wide className="qr-modal">
    <div className="qr-print-header">
      <h2>MAINTAIN-X ASSET IDENTIFICATION &amp; OPERATING SPECIFICATIONS</h2>
      <p>Scan with a smartphone or barcode gateway to view live telemetry and sensor firmware code. Printed: {new Date().toLocaleDateString()} {new Date().toLocaleTimeString()}</p>
    </div>
    <div className="no-print">
      <p className="modal-intro">Each QR label encodes this machine’s deep link at <code>{QR_DASHBOARD_URL}</code> or direct provisioning credentials. Print labels for equipment chassis or scan with a smartphone camera to view live sensor code and connection instructions.</p>
      <div className="qr-mode-switch">
        <button className={qrMode === 'url' ? 'active' : ''} onClick={() => setQrMode('url')}>Mobile Web Link QR</button>
        <button className={qrMode === 'provisioning' ? 'active' : ''} onClick={() => setQrMode('provisioning')}>Direct Gateway Provisioning JSON</button>
      </div>
    </div>
    {machines.length === 0 ? <p className="empty-note">Register an asset before creating its label.</p> : <div className="qr-grid">{machines.map(machine => {
      const url = `${QR_DASHBOARD_URL}/?connect=${encodeURIComponent(machine.machine_id)}`
      const provJson = JSON.stringify({ schema: 'maintain-x/v1', machine_id: machine.machine_id, equipment_type: machine.equipment_type })
      const qrVal = qrMode === 'url' ? url : provJson
      const prof = machine.limit_profile?.mode === 'custom' ? machine.limit_profile : sharedLimits

      return <article className="qr-label" key={machine.machine_id}>
        <QRCodeSVG value={qrVal} size={116} level="M" includeMargin />
        <div>
          <p className="eyebrow">EQUIPMENT ID</p>
          <h3>{machine.machine_name || machine.machine_id}</h3>
          <p>{machine.machine_id} · {machine.equipment_type} · ×{machine.criticality.toFixed(1)}</p>
          <div className="qr-label-limits">
            <span>Temp max: {prof.process_temperature}°C</span>
            <span>Torque max: {prof.torque} Nm</span>
            <span>Speed: {prof.rotational_speed_low}–{prof.rotational_speed_high} rpm</span>
            <span>Wear max: {prof.tool_wear}</span>
          </div>
          <div className="no-print" style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <button className="button-primary small-button" onClick={() => onConnect(machine)}>
              <Radio size={13} /> Connect sensor
            </button>
            <button className="button-secondary small-button" onClick={() => void copy(url, machine.machine_id)}>
              {copied === machine.machine_id ? <Check size={13} /> : <Copy size={13} />}
              {copied === machine.machine_id ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      </article>
    })}</div>}
    <div className="modal-footer no-print">
      <button className="button-secondary" onClick={handlePrint}><Printer size={15} /> Print labels</button>
    </div>
  </Modal>
}

function SensorConnectModal({
  machine,
  shared,
  connections,
  close,
  onReadingSent,
}: {
  machine: Machine
  shared: Limits
  connections: Dashboard['connections']
  close: () => void
  onReadingSent: () => void
}) {
  const [activeTab, setActiveTab] = useState<'esp32' | 'python' | 'curl' | 'json'>('esp32')
  const [qrMode, setQrMode] = useState<'url' | 'provisioning'>('url')
  const [gatewayHost, setGatewayHost] = useState(window.location.hostname || '127.0.0.1')
  const [token, setToken] = useState('replace-with-a-long-random-secret')
  const [copied, setCopied] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ status: 'success' | 'error'; text: string } | null>(null)

  const limits = machine.limit_profile?.mode === 'custom' ? machine.limit_profile : shared
  const ingestUrl = `http://${gatewayHost}:${connections.rest.port}/api/ingest/v1/readings`
  const connectUrl = `${QR_DASHBOARD_URL}/?connect=${encodeURIComponent(machine.machine_id)}`
  const provJson = JSON.stringify({
    schema: 'maintain-x/v1',
    machine_id: machine.machine_id,
    equipment_type: machine.equipment_type,
    ingest_url: ingestUrl,
    token: token,
  }, null, 2)
  const qrValue = qrMode === 'url' ? connectUrl : provJson

  const esp32Code = `/*
 * MAINTAIN-X Sensor Transmitter for ${machine.machine_name || machine.machine_id}
 * Machine ID: ${machine.machine_id}
 * Target: ESP32 / Arduino WiFi
 */
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* INGEST_URL = "${ingestUrl}";
const char* INGEST_TOKEN = "${token}";
const char* MACHINE_ID = "${machine.machine_id}";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\\nWiFi Connected! IP: " + WiFi.localIP().toString());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(INGEST_URL);
    http.addHeader("Content-Type", "application/json");
    if (strlen(INGEST_TOKEN) > 0) {
      http.addHeader("Authorization", String("Bearer ") + INGEST_TOKEN);
    }

    // Read your physical sensors (MAX6675, CT clamp, optical tachometer):
    float process_temp = 68.2;  // Usable limit: ${limits.process_temperature} C
    float rpm = 1480.0;         // Usable band: ${limits.rotational_speed_low}-${limits.rotational_speed_high} rpm
    float torque = 74.5;        // Usable limit: ${limits.torque} Nm
    float tool_wear = 120.0;    // Indicator limit: ${limits.tool_wear}

    String json = "{\\"machine_id\\":\\"" + String(MACHINE_ID) + "\\","
      + "\\"equipment_type\\":\\"${machine.equipment_type}\\","
      + "\\"process_temperature\\":" + String(process_temp, 2) + ","
      + "\\"rotational_speed\\":" + String(rpm, 1) + ","
      + "\\"torque\\":" + String(torque, 2) + ","
      + "\\"tool_wear\\":" + String(tool_wear, 1) + ","
      + "\\"operating_state\\":\\"RUNNING\\"}";

    int code = http.POST(json);
    Serial.printf("[HTTP] POST code: %d\\n", code);
    http.end();
  }
  delay(2000);
}`

  const pythonCode = `"""
MAINTAIN-X Industrial Sensor Station
Machine: ${machine.machine_name || machine.machine_id} (${machine.machine_id})
Target: Raspberry Pi / Linux Gateway / Edge PC
"""
import time
import requests

INGEST_URL = "${ingestUrl}"
INGEST_TOKEN = "${token}"
MACHINE_ID = "${machine.machine_id}"
EQUIPMENT_TYPE = "${machine.equipment_type}"

def read_hardware_sensors():
    # Replace with real ADC / GPIO / I2C / SPI sensor reading calls:
    return {
        "process_temperature": 68.5,  # Usable limit: ${limits.process_temperature} C
        "air_temperature": 26.0,
        "rotational_speed": 1490.0,   # Usable band: ${limits.rotational_speed_low} - ${limits.rotational_speed_high} rpm
        "torque": 76.2,               # Usable limit: ${limits.torque} Nm
        "tool_wear": 125.0,           # Indicator limit: ${limits.tool_wear}
        "operating_state": "RUNNING",
    }

def main():
    print(f"Starting MAINTAIN-X stream for {MACHINE_ID} -> {INGEST_URL}")
    headers = {"Content-Type": "application/json"}
    if INGEST_TOKEN:
        headers["Authorization"] = f"Bearer {INGEST_TOKEN}"

    while True:
        try:
            payload = {
                "machine_id": MACHINE_ID,
                "equipment_type": EQUIPMENT_TYPE,
                **read_hardware_sensors(),
            }
            res = requests.post(INGEST_URL, json=payload, headers=headers, timeout=5)
            print(f"[{res.status_code}] Delivered: Risk={res.json().get('assessment', {}).get('risk')}")
        except Exception as e:
            print(f"[FAIL] Error posting reading: {e}")
        time.sleep(2.0)

if __name__ == "__main__":
    main()`

  const curlCode = `curl -X POST ${ingestUrl} \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"machine_id":"${machine.machine_id}","equipment_type":"${machine.equipment_type}","process_temperature":68.5,"rotational_speed":1480,"torque":75.0,"tool_wear":120,"operating_state":"RUNNING"}'`

  const activeCode = activeTab === 'esp32' ? esp32Code : activeTab === 'python' ? pythonCode : activeTab === 'curl' ? curlCode : provJson

  const copyCode = async () => {
    await navigator.clipboard.writeText(activeCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const sendTestPacket = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const payload = {
        machine_id: machine.machine_id,
        equipment_type: machine.equipment_type,
        process_temperature: Number((limits.process_temperature * 0.9).toFixed(1)),
        rotational_speed: Number(((limits.rotational_speed_low + limits.rotational_speed_high) / 2).toFixed(1)),
        torque: Number((limits.torque * 0.85).toFixed(1)),
        tool_wear: Number((limits.tool_wear * 0.5).toFixed(1)),
        operating_state: 'RUNNING',
      }
      const response = await fetch(`${API}/api/ingest/v1/readings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: response.statusText }))
        throw new Error(err.detail ?? `HTTP ${response.status}`)
      }
      const data = await response.json()
      setTestResult({
        status: 'success',
        text: `✓ Live reading delivered! Evaluated risk: "${data?.assessment?.risk ?? 'Normal'}". Machine is now active on the dashboard.`,
      })
      onReadingSent()
    } catch (err) {
      setTestResult({
        status: 'error',
        text: `✗ Ingest failed: ${err instanceof Error ? err.message : 'Could not deliver telemetry.'} Check your INGEST_TOKEN in server settings.`,
      })
    } finally {
      setTesting(false)
    }
  }

  return <Modal title={`Connect Sensor · ${machine.machine_name || machine.machine_id}`} close={close} wide className="qr-modal">
    <div className="no-print">
      <p className="modal-intro">
        Flash or execute this pre-configured sensor firmware on your microcontroller or edge gateway. Scanning the QR code from any camera opens this machine setup page instantly.
      </p>

      {/* Machine & Usable Limits Summary */}
      <div className="sensor-connect-summary">
        <div><span className="eyebrow">EQUIPMENT</span><strong>{machine.machine_name || machine.machine_id}</strong><span>ID: {machine.machine_id}</span></div>
        <div><span className="eyebrow">EQUIPMENT TYPE</span><strong>{machine.equipment_type}</strong><span>Criticality ×{machine.criticality.toFixed(1)}</span></div>
        <div><span className="eyebrow">USABLE TEMP LIMIT</span><strong>{limits.process_temperature} °C</strong><span>Max threshold</span></div>
        <div><span className="eyebrow">USABLE TORQUE LIMIT</span><strong>{limits.torque} Nm</strong><span>Max threshold</span></div>
        <div><span className="eyebrow">USABLE SPEED BAND</span><strong>{limits.rotational_speed_low}–{limits.rotational_speed_high} rpm</strong><span>Operating envelope</span></div>
        <div><span className="eyebrow">TOOL WEAR LIMIT</span><strong>{limits.tool_wear} index</strong><span>Inspection trigger</span></div>
      </div>

      {/* QR Code and Gateway Config Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '16px', margin: '14px 0', alignItems: 'center', padding: '14px', border: '1px solid var(--mist)', borderRadius: '8px', background: 'var(--paper)' }}>
        <div style={{ display: 'grid', justifyItems: 'center', gap: '6px' }}>
          <QRCodeSVG value={qrValue} size={110} level="M" includeMargin />
          <div className="qr-mode-switch" style={{ margin: 0 }}>
            <button className={qrMode === 'url' ? 'active' : ''} onClick={() => setQrMode('url')}>Link</button>
            <button className={qrMode === 'provisioning' ? 'active' : ''} onClick={() => setQrMode('provisioning')}>JSON</button>
          </div>
        </div>
        <div style={{ display: 'grid', gap: '10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
            <label style={{ display: 'grid', gap: '4px', fontSize: '10px', fontWeight: 600, color: 'var(--graphite)' }}>
              Gateway / Server Host IP
              <input value={gatewayHost} onChange={e => setGatewayHost(e.target.value)} placeholder="192.168.1.100 or 127.0.0.1" style={{ height: '32px', padding: '4px 8px', border: '1px solid var(--mist)', borderRadius: '4px', fontSize: '11px' }} />
            </label>
            <label style={{ display: 'grid', gap: '4px', fontSize: '10px', fontWeight: 600, color: 'var(--graphite)' }}>
              Ingest Token (Bearer)
              <input value={token} onChange={e => setToken(e.target.value)} placeholder="MAINTAINX_INGEST_TOKEN" style={{ height: '32px', padding: '4px 8px', border: '1px solid var(--mist)', borderRadius: '4px', fontSize: '11px' }} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button className="button-primary small-button" onClick={sendTestPacket} disabled={testing}>
              {testing ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}
              Send live test reading
            </button>
            <span style={{ fontSize: '10px', color: 'var(--slate)' }}>Verify endpoint connectivity directly from browser</span>
          </div>
          {testResult && (
            <div className={`tester-response ${testResult.status}`}>
              {testResult.text}
            </div>
          )}
        </div>
      </div>

      {/* Code Viewer */}
      <div className="code-generator-section">
        <div className="code-lang-tabs">
          <button className={`code-lang-tab ${activeTab === 'esp32' ? 'active' : ''}`} onClick={() => setActiveTab('esp32')}><Cpu size={13} style={{ marginRight: 4 }} /> ESP32 / Arduino (C++)</button>
          <button className={`code-lang-tab ${activeTab === 'python' ? 'active' : ''}`} onClick={() => setActiveTab('python')}><Terminal size={13} style={{ marginRight: 4 }} /> Raspberry Pi / Python</button>
          <button className={`code-lang-tab ${activeTab === 'curl' ? 'active' : ''}`} onClick={() => setActiveTab('curl')}><Code size={13} style={{ marginRight: 4 }} /> cURL Command</button>
          <button className={`code-lang-tab ${activeTab === 'json' ? 'active' : ''}`} onClick={() => setActiveTab('json')}><Sliders size={13} style={{ marginRight: 4 }} /> Raw JSON</button>
        </div>
        <div className="code-display-wrap">
          <div className="code-display-actions">
            <button className="code-copy-btn" onClick={copyCode}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied code' : 'Copy code'}
            </button>
          </div>
          <pre><code>{activeCode}</code></pre>
        </div>
      </div>
    </div>
  </Modal>
}

function ConnectionModal({ connections, close }: { connections: Dashboard['connections']; close: () => void }) {
  const [copied, setCopied] = useState(false)
  const endpoint = `http://127.0.0.1:${connections.rest.port}/api/ingest/v1/readings`
    const snippet = `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer $MAINTAINX_INGEST_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"machine_id":"PRESS-01","equipment_type":"Hydraulic press","air_temperature":28,"process_temperature":71.2,"rotational_speed":1480,"torque":82,"tool_wear":140,"operating_state":"RUNNING"}'`
  const tokenizedSnippet = snippet.replace('Authorization: ******', 'Authorization: Bearer REPLACE_WITH_INGEST_TOKEN')
  async function copySnippet() { await navigator.clipboard.writeText(tokenizedSnippet); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
  return <Modal title="Equipment connections" close={close} wide>
    <div className="connection-status-grid">
      <article className="connection-status"><span className="connection-icon"><Link2 size={18} /></span><div><h3>REST sensor gateway</h3><p>Listen port {connections.rest.port} · authenticated HTTP ingest</p></div><span className={`connection-badge ${connections.rest.configured ? 'is-active' : ''}`}>{connections.rest.configured ? 'READY' : 'TOKEN REQUIRED'}</span></article>
      <article className="connection-status"><span className="connection-icon"><Radio size={18} /></span><div><h3>MQTT broker</h3><p>{connections.mqtt.configured ? `${connections.mqtt.host}:${connections.mqtt.port} · ${connections.mqtt.detail}` : 'Not configured · TLS port 8883 by default'}</p></div><span className={`connection-badge ${connections.mqtt.connected ? 'is-active' : ''}`}>{connections.mqtt.connected ? 'CONNECTED' : connections.mqtt.configured ? 'DISCONNECTED' : 'OPTIONAL'}</span></article>
      <article className="connection-status"><span className="connection-icon"><Activity size={18} /></span><div><h3>Browser live updates</h3><p>WebSocket broadcast · port {connections.rest.port}</p></div><span className="connection-badge is-active">ENABLED</span></article>
    </div>
    <div className="code-panel"><div className="code-panel-heading"><span>REST SENSOR PAYLOAD</span><IconButton label="Copy connection command" onClick={() => void copySnippet()}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton></div><pre><code>{tokenizedSnippet}</code></pre></div>
    <p className="security-note"><ShieldCheck size={15} /> Set <code>MAINTAINX_INGEST_TOKEN</code> at API startup and use the same value in your secured gateway. Replace the example machine ID with the registered ID. Never bundle credentials into QR labels or browser code. The API binds to loopback by default; remote gateways need an intentionally secured private-network/VPN setup.</p>
    <div className="mqtt-env"><span className="eyebrow">OPTIONAL MQTT SERVER SETTINGS</span><code>MQTT_BROKER_HOST · MQTT_BROKER_PORT · MQTT_USERNAME · MQTT_PASSWORD · MQTT_TLS · MQTT_TOPIC</code></div>
  </Modal>
}

function MachineDetail({ machine, onBack, onReport, onChat, onQR, onLogAction, onRemove, onConnect }: { machine: Machine; onBack: () => void; onReport: () => void; onChat: () => void; onQR: () => void; onLogAction: () => void; onRemove: () => void; onConnect: () => void }) {
  const [history, setHistory] = useState<Record<string, number | string | null>[]>([])
  useEffect(() => { void request<Record<string, number | string | null>[]>(`/api/machines/${encodeURIComponent(machine.machine_id)}/history?limit=90`).then(setHistory).catch(() => setHistory([])) }, [machine.machine_id, machine.timestamp])
  const series = history.map(row => ({ ...row, time: row.timestamp ? new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '' }))
  return <section className="detail-view">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Fleet overview</button>
    <div className="detail-title"><div><p className="eyebrow">ASSET INTELLIGENCE / {machine.equipment_type.toUpperCase()}</p><h1>{machine.machine_name || machine.machine_id}</h1><p className="detail-subtitle">ID: {machine.machine_id} <span>·</span> {machine.equipment_type} <span>·</span> Criticality ×{machine.criticality.toFixed(1)} <span>·</span> {machine.operating_state ?? 'Awaiting data'}</p></div><div className="detail-actions"><RiskPill risk={machine.risk} /><button className="button-primary" onClick={onConnect}><Radio size={14} /> Connect sensor</button><button className="button-secondary" onClick={onReport}><ArrowDownToLine size={15} /> Report</button><button className="button-secondary" onClick={onLogAction}><Wrench size={15} /> Log action</button><button className="button-secondary" onClick={onQR}><QrCode size={15} /> QR label</button><button className="button-primary" onClick={onChat}><MessageSquare size={15} /> Ask assistant</button></div></div>
    <div className="asset-detail-toolbar"><span className={`source-tag source-${machine.source ?? 'waiting'}`}>{machine.source === 'synthetic-demo' ? 'SIMULATED · 1 SECOND' : machine.source ? `DEVICE · ${machine.source.toUpperCase()}` : 'WAITING FOR DATA'}</span><span className="source-explainer">{machine.source === 'synthetic-demo' ? 'Generated demonstration readings; not from a physical sensor.' : machine.source ? 'Latest source: connected gateway.' : 'No sensor has reported for this registered asset.'}</span><button className="button-secondary small-button remove-device" onClick={onRemove}><X size={13} /> Remove asset</button></div>
    {!machine.id ? <div className="no-reading-banner"><Clock3 size={18} /><div><strong>No readings received.</strong><p>This asset is registered and awaiting a connected gateway or an explicitly enabled demo stream.</p></div></div> : <>
      <div className="sensor-grid">
        <SensorMetric icon={<Thermometer size={16} />} label="Process temperature" value={fmt(machine.process_temperature, '°C')} limit={machine.source === 'synthetic-demo' ? 'Demo threshold' : 'Configured threshold'} />
        <SensorMetric icon={<Gauge size={16} />} label="Rotational speed" value={fmt(machine.rotational_speed, 'rpm')} limit="Configured band" />
        <SensorMetric icon={<Zap size={16} />} label="Torque" value={fmt(machine.torque, 'Nm')} limit={machine.source === 'synthetic-demo' ? 'Demo threshold' : 'Configured threshold'} />
        <SensorMetric icon={<Activity size={16} />} label="Tool wear" value={fmt(machine.tool_wear)} limit="Indicator" />
      </div>
      <div className="detail-grid">
        <section className="panel trend-panel"><div className="panel-heading"><div><p className="eyebrow">RECENT SENSOR HISTORY</p><h2>Operating envelope</h2></div><span className="live-caption"><span className="online-dot" /> Updated {relativeTime(machine.timestamp)}</span></div>
          {series.length < 2 ? <div className="chart-empty"><Activity size={18} /> Trend appears as readings arrive.</div> : <div className="trend-grid"><TrendLine data={series} field="process_temperature" label="Process temperature" unit="°C" color="#0d9488" /><TrendLine data={series} field="torque" label="Torque" unit="Nm" color="#718096" /><TrendLine data={series} field="tool_wear" label="Tool wear" unit="index" color="#b2a06b" /></div>}
        </section>
        <section className="panel assessment-panel"><div className="panel-heading"><div><p className="eyebrow">RULE-BASED HEALTH CHECK</p><h2>Why this status</h2></div><RiskPill risk={machine.risk} /></div>
          {machine.assessment.violations.length ? <ul className="violation-list">{machine.assessment.violations.map((item, index) => <li key={`${item}-${index}`}><AlertTriangle size={15} /><span>{item}</span></li>)}</ul> : <div className="clear-state"><CheckCircle2 size={18} /><span>No configured threshold exceeded in the latest reading.</span></div>}
          <div className="recommendation"><span className="recommendation-mark"><Wrench size={15} /></span><div><span className="eyebrow">SUGGESTED NEXT STEP</span><p>{machine.assessment.recommended_action}</p></div></div>
          <p className="caveat">Rule-based flag, not a confirmed failure diagnosis. Follow site procedures and manufacturer guidance.</p>
        </section>
      </div>
      <section className="downtime-callout"><div><p className="eyebrow">PLANNING SCENARIO · NOT A QUOTATION</p><h2>Estimated downtime exposure</h2><p>Editable assumptions multiplied by this asset’s relative criticality.</p></div><div><strong>${(machine.downtime_scenario?.estimated_cost ?? 0).toLocaleString()}</strong><span>{machine.downtime_scenario?.repair_hours ?? 0} h × ${machine.downtime_scenario?.rate_per_hour.toLocaleString() ?? 0}/h × {machine.criticality.toFixed(1)} criticality</span></div></section>
    </>}
  </section>
}

function SensorMetric({ icon, label, value, limit }: { icon: React.ReactNode; label: string; value: string; limit: string }) {
  return <article className="sensor-metric"><span className="sensor-icon">{icon}</span><p>{label}</p><strong>{value}</strong><span>{limit}</span></article>
}

function TrendLine({ data, field, label, unit, color }: { data: Record<string, number | string | null>[]; field: string; label: string; unit: string; color: string }) {
  return <article className="trend-mini"><div><strong>{label}</strong><span>{unit}</span></div><ResponsiveContainer width="100%" height={115}><LineChart data={data} margin={{ top: 7, right: 8, left: -22, bottom: 0 }}><CartesianGrid stroke="#e2e8f0" strokeDasharray="2 4" vertical={false} /><XAxis dataKey="time" tick={{ fill: '#718096', fontSize: 8 }} axisLine={{ stroke: '#e2e8f0' }} tickLine={false} minTickGap={24} /><YAxis tick={{ fill: '#718096', fontSize: 8 }} axisLine={false} tickLine={false} width={38} /><Tooltip contentStyle={{ border: '1px solid #e2e8f0', borderRadius: 5, fontSize: 10 }} /><Line type="monotone" dataKey={field} name={`${label} (${unit})`} stroke={color} dot={false} strokeWidth={2} connectNulls /></LineChart></ResponsiveContainer></article>
}

function FleetTable({ machines, selected, select }: { machines: Machine[]; selected: string; select: (id: string) => void }) {
  if (!machines.length) return <div className="empty-table">No assets match this risk filter.</div>
  return <div className="table-scroll"><table className="machine-table"><thead><tr><th>Machine</th><th>Equipment</th><th>Health</th><th>Process °C</th><th>RPM</th><th>Torque Nm</th><th>Tool wear</th><th>Source</th><th>Latest update</th><th /></tr></thead><tbody>{machines.map(machine => <tr key={machine.machine_id} className={machine.machine_id === selected ? 'selected-row' : ''} onClick={() => select(machine.machine_id)} tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') select(machine.machine_id) }}><td><strong>{machine.machine_name || machine.machine_id}</strong><span className="table-subtext">{machine.machine_id} · ×{machine.criticality.toFixed(1)} criticality</span></td><td>{machine.equipment_type}</td><td><RiskPill risk={machine.risk} /></td><td>{fmt(machine.process_temperature)}</td><td>{fmt(machine.rotational_speed)}</td><td>{fmt(machine.torque)}</td><td>{fmt(machine.tool_wear)}</td><td><span className={`source-tag compact source-${machine.source ?? 'waiting'}`}>{machine.source === 'synthetic-demo' ? 'SIM' : machine.source?.toUpperCase() ?? 'NONE'}</span></td><td><span className="timestamp-cell">{relativeTime(machine.timestamp)}</span></td><td><ChevronRight size={16} className="row-chevron" /></td></tr>)}</tbody></table></div>
}

function EventsView({ events, machines, refresh }: { events: Event[]; machines: Machine[]; refresh: () => Promise<void> }) {
  const [allEvents, setAllEvents] = useState(events)
  const [severity, setSeverity] = useState('All')
  const [status, setStatus] = useState('All')
  const [machine, setMachine] = useState('All')
  const [working, setWorking] = useState<number | null>(null)
  const [loadError, setLoadError] = useState('')
  async function loadEvents() { try { setAllEvents(await request<Event[]>('/api/events?limit=1000')); setLoadError('') } catch (cause) { setLoadError(cause instanceof Error ? cause.message : 'Could not load event history') } }
  useEffect(() => { void loadEvents(); const timer = window.setInterval(() => void loadEvents(), 5000); return () => window.clearInterval(timer) }, [])
  const filtered = allEvents.filter(event => (severity === 'All' || event.severity === severity) && (status === 'All' || event.status === status) && (machine === 'All' || event.machine_id === machine))
  async function update(event: Event, nextStatus: string) { setWorking(event.id); try { await request(`/api/events/${event.id}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) }); await Promise.all([loadEvents(), refresh()]) } finally { setWorking(null) } }
  return <section className="section-view"><div className="section-heading"><div><p className="eyebrow">MAINTENANCE LOG</p><h1>Events & response</h1><p>Observed limit violations, acknowledgement, and follow-up.</p></div><button className="button-secondary" onClick={() => void loadEvents()}><RefreshCw size={15} /> Refresh</button></div>
    <div className="filter-row"><label>Machine<select value={machine} onChange={event => setMachine(event.target.value)}><option>All</option>{machines.map(item => <option key={item.machine_id}>{item.machine_id}</option>)}</select></label><label>Severity<select value={severity} onChange={event => setSeverity(event.target.value)}>{['All', 'Critical', 'Attention', 'Normal'].map(value => <option key={value}>{value}</option>)}</select></label><label>Status<select value={status} onChange={event => setStatus(event.target.value)}>{['All', 'Open', 'Acknowledged', 'Resolved'].map(value => <option key={value}>{value}</option>)}</select></label><span className="result-count">{filtered.length} events</span><button className="button-secondary small-button" onClick={() => void loadEvents()}><RefreshCw size={13} /> Refresh</button></div>
    {loadError && <div className="api-error"><AlertCircle size={15} />{loadError}</div>}
    {filtered.length === 0 ? <div className="empty-table">No events match these filters.</div> : <div className="event-list">{filtered.map(event => <article className="event-row" key={event.id}><div className={`event-symbol ${event.severity.toLowerCase()}`}>{event.severity === 'Critical' ? <AlertCircle size={17} /> : <AlertTriangle size={17} />}</div><div className="event-body"><div className="event-meta"><strong>{event.machine_id}</strong><RiskPill risk={event.severity} /><span className={`status-text status-${event.status.toLowerCase()}`}>{event.status}</span><time>{new Date(event.timestamp).toLocaleString()}</time></div><p>{event.condition}</p><span className="event-action"><Wrench size={13} /> {event.recommended_action}</span></div><div className="event-controls">{event.status === 'Open' && <button className="button-secondary small-button" disabled={working === event.id} onClick={() => void update(event, 'Acknowledged')}>Acknowledge</button>}{event.status !== 'Resolved' && <button className="button-secondary small-button" disabled={working === event.id} onClick={() => void update(event, 'Resolved')}>Resolve</button>}</div></article>)}</div>}
  </section>
}

function ChatPanel({ machine, close }: { machine?: Machine; close: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [assistantReady, setAssistantReady] = useState<boolean | null>(null)
  useEffect(() => { void request<{ configured: boolean }>('/api/assistant/status').then(status => setAssistantReady(status.configured)).catch(() => setAssistantReady(false)) }, [])
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!machine || !input.trim() || busy) return
    const question = input.trim(); const next = [...messages, { role: 'user' as const, content: question }]
    setMessages(next); setInput(''); setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_id: machine.machine_id, question, history: messages.slice(-8) }) })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({ detail: response.statusText }))
        throw new Error(detail.detail ?? `Assistant request failed (${response.status})`)
      }
      if (!response.body) throw new Error('The assistant response stream is unavailable.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false
      while (!finished) {
        const part = await reader.read()
        finished = part.done
        buffer += decoder.decode(part.value, { stream: !finished })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const dataLine = frame.split('\n').find(line => line.startsWith('data:'))
          if (!dataLine) continue
          const message = JSON.parse(dataLine.slice(5).trim()) as { delta?: string; error?: string }
          if (message.error) throw new Error(message.error)
          if (message.delta) {
            setMessages(current => {
              const last = current[current.length - 1]
              return last?.role === 'assistant'
                ? [...current.slice(0, -1), { ...last, content: last.content + message.delta }]
                : [...current, { role: 'assistant', content: message.delta ?? '' }]
            })
          }
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Assistant unavailable') }
    finally { setBusy(false) }
  }
  return <aside className="chat-panel"><header><span className="chat-mark"><Bot size={17} /></span><div><strong>Maintenance assistant</strong><span>{machine ? `${machine.machine_id} · ${machine.risk}` : 'Select an asset to begin'}</span></div><IconButton label="Close assistant" onClick={close}><X size={17} /></IconButton></header>
    {assistantReady === false && <div className="assistant-setup-warning"><AlertCircle size={14} /><span>Assistant disabled: set a newly rotated <code>GROQ_API_KEY</code> in the API server environment, then restart the API.</span></div>}
    <div className="chat-content">{!machine ? <div className="chat-empty"><HardDrive size={22} /><p>Select a registered machine to ask about its readings and event history.</p></div> : <><div className="assistant-context"><span className="eyebrow">CURRENT ASSET CONTEXT</span><RiskPill risk={machine.risk} /><p>{machine.assessment.recommended_action}</p><span>Assistant answers are guidance, not work authorization.</span></div>{messages.length === 0 && <div className="suggested-questions"><span className="eyebrow">ASK ABOUT THIS MACHINE</span>{['What is driving this risk status?', 'What should the maintainer check first?', 'Summarize the recent event history'].map(question => <button key={question} onClick={() => setInput(question)}>{question}<ArrowRight size={14} /></button>)}</div>}{messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === 'assistant' ? 'MX' : 'YOU'}</span><p>{message.content}</p></div>)}{busy && <div className="chat-message assistant"><LoaderCircle size={16} className="spin" /><p>Reviewing asset context…</p></div>}{error && <p className="chat-error">{error}</p>}</>}</div>
    <form className="chat-input-row" onSubmit={submit}><input aria-label="Ask a maintenance question" disabled={!machine || busy || assistantReady !== true} value={input} onChange={event => setInput(event.target.value)} placeholder={assistantReady === null ? 'Checking assistant…' : assistantReady === false ? 'Configure API key on server' : machine ? 'Ask about risk or next steps' : 'Select a machine first'} /><button aria-label="Send question" disabled={!machine || !input.trim() || busy || assistantReady !== true}><Send size={16} /></button></form><p className="chat-disclaimer">AI-generated guidance · verify against site safety procedures.</p>
  </aside>
}

function App() {
  const { data, connected, error, refresh } = useLiveDashboard()
  const [view, setView] = useState<View>('Fleet')
  const [riskFilter, setRiskFilter] = useState('All risks')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(new URLSearchParams(window.location.search).get('asset') ?? '')
  const [modal, setModal] = useState<'register' | 'qr' | 'connections' | 'report' | 'action' | 'remove' | 'sensor-connect' | null>(null)
  const [sensorConnectMachine, setSensorConnectMachine] = useState<Machine | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [limits, setLimits] = useState<Limits>(fallbackLimits)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [simulationError, setSimulationError] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const [reportError, setReportError] = useState('')
  const machines = data?.machines ?? []
  const selectedMachine = machines.find(machine => machine.machine_id === selectedId)

  useEffect(() => { void request<Limits>('/api/settings').then(setLimits).catch(() => undefined) }, [])
  useEffect(() => {
    if (selectedId && machines.some(machine => machine.machine_id === selectedId)) {
      const url = new URL(window.location.href); url.searchParams.set('asset', selectedId); window.history.replaceState({}, '', url)
    }
  }, [selectedId, machines])

  // Handle deep-link QR connection (e.g. ?connect=PRESS-01)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connectId = params.get('connect')
    if (connectId && machines.length > 0) {
      const found = machines.find(m => m.machine_id === connectId)
      if (found) {
        setSensorConnectMachine(found)
        setModal('sensor-connect')
      }
    }
  }, [machines])

  const filteredMachines = machines.filter(machine =>
    (riskFilter === 'All risks' || machine.risk.toLowerCase() === riskFilter.toLowerCase()) &&
    `${machine.machine_name} ${machine.machine_id} ${machine.equipment_type}`.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => ({ Critical: 0, Attention: 1, Normal: 2, 'No data': 3 }[left.risk] - ({ Critical: 0, Attention: 1, Normal: 2, 'No data': 3 }[right.risk])))

  async function saveLimits(event: FormEvent) {
    event.preventDefault(); setSettingsMessage('')
    try { const saved = await request<Limits>('/api/settings', { method: 'PUT', body: JSON.stringify(limits) }); setLimits(saved); setSettingsMessage('Limits saved to the live API.') }
    catch (cause) { setSettingsMessage(cause instanceof Error ? cause.message : 'Could not save limits') }
  }

  async function controlSimulation(action: 'start' | 'pause' | 'reset') {
    setSimulationError('')
    try {
      await request(`/api/simulation/${action}`, { method: 'POST' })
      await refresh()
    } catch (cause) { setSimulationError(cause instanceof Error ? cause.message : 'Simulation control failed') }
  }

  function removeSelected() {
    setSelectedId('')
    const url = new URL(window.location.href)
    url.searchParams.delete('asset')
    window.history.replaceState({}, '', url)
    void refresh()
  }

  async function downloadReport() {
    if (!selectedMachine) return
    setReportBusy(true); setReportError('')
    try {
      const report = await request<Record<string, unknown>>(`/api/reports/${encodeURIComponent(selectedMachine.machine_id)}`)
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `${selectedMachine.machine_id}-maintenance-report.json`; anchor.click(); URL.revokeObjectURL(url)
    } catch (cause) { setReportError(cause instanceof Error ? cause.message : 'Report generation failed') }
    finally { setReportBusy(false) }
  }

  return <div className="app-shell">
    <header className="topbar"><button className="brand" onClick={() => { setView('Fleet'); setSelectedId('') }}><img className="brand-mark" src="/maintain-x-logo.png" alt="" /><span>MAINTAIN<span className="brand-x">-X</span></span><span className="brand-divider" /><span className="brand-caption">ASSET INTELLIGENCE</span></button>
      <nav className="topnav" aria-label="Main navigation">{(['Fleet', 'Events', 'Connections'] as View[]).map(item => <button key={item} className={view === item ? 'nav-active' : ''} onClick={() => { setView(item); setSelectedId('') }}>{item}{item === 'Events' && (data?.metrics.open_events ?? 0) > 0 && <span className="nav-count">{data?.metrics.open_events}</span>}</button>)}</nav>
      <div className="top-actions"><span className={`connection-indicator ${connected ? 'connected' : ''}`}><i />{connected ? 'Live stream' : 'Reconnecting'}</span><button className="button-secondary add-machine" onClick={() => setModal('register')}><Plus size={15} /> Add machine</button><IconButton label="Connection settings" onClick={() => setModal('connections')}><Settings2 size={17} /></IconButton></div>
    </header>
    <main className="page-wrap">
      {error && <div className="api-error"><AlertCircle size={16} /><span>API connection unavailable: {error}. Start the live API to load equipment.</span><button onClick={() => void refresh()}>Retry</button></div>}
      <div className={`demo-banner ${data?.connections.simulation.enabled ? 'simulation-banner' : ''}`}><span className="banner-icon"><Radio size={15} /></span><span><strong>{data?.connections.simulation.enabled ? 'ONE-SECOND SIMULATION ACTIVE' : 'LIVE DEVICE READINGS'}</strong><span className="banner-separator">/</span> {data?.connections.simulation.enabled ? 'Clearly labeled generated signals are updating every second to demonstrate the live workflow; they are not physical sensor measurements.' : 'Only readings received from connected devices are displayed.'}</span><button aria-label="About data sources" title="Source badges distinguish generated readings from REST and MQTT device data."><CircleHelp size={15} /></button></div>
      {simulationError && <div className="api-error"><AlertCircle size={15} />{simulationError}</div>}

      {view === 'Connections' ? <section className="section-view"><div className="section-heading"><div><p className="eyebrow">DEVICE NETWORK</p><h1>Connections &amp; Sensor Setup</h1><p>Authenticated ingress, individual machine usable limits, and physical sensor hardware connection guide.</p></div><button className="button-primary" onClick={() => setModal('connections')}><Link2 size={15} /> Setup guide</button></div>
        <div className="connection-cards"><ConnectionCard icon={<Link2 size={18} />} title="REST sensor gateway" status={data?.connections.rest.configured ? `${data.metrics.real_connected} device(s) recently reporting` : 'Needs server token'} port={data?.connections.rest.port ?? 8000} detail="HTTP JSON ingestion · authenticated gateway" endpoint="/api/ingest/v1/readings" /><ConnectionCard icon={<Radio size={18} />} title="MQTT broker" status={data?.connections.mqtt.connected ? 'Connected' : data?.connections.mqtt.configured ? 'Configured · offline' : 'Optional · not configured'} port={data?.connections.mqtt.port ?? 8883} detail={data?.connections.mqtt.detail ?? 'TLS enabled by default'} endpoint={data?.connections.mqtt.host || 'Set MQTT_BROKER_HOST on the API server'} /><ConnectionCard icon={<Activity size={18} />} title="One-second demo feed" status={data?.connections.simulation.enabled ? 'Running' : 'Paused'} port={data?.connections.rest.port ?? 8000} detail={`${data?.connections.simulation.machines ?? 0} generated profiles · tick ${data?.connections.simulation.tick ?? 0}`} endpoint="Control from the Fleet view · not an IoT connection" /></div>
        
        {/* Real Sensor Hardware & Firmware Guide */}
        <RealSensorsGuide
          machines={machines}
          shared={limits}
          connections={data?.connections ?? { rest: { name: 'REST', port: 8000, configured: false, endpoint: 'http://127.0.0.1:8000/api/ingest/v1/readings' }, mqtt: { configured: false, connected: false, detail: 'Not configured', host: '', port: 8883 }, websocket: 'ws://127.0.0.1:8000/ws', simulation: { enabled: false, source: 'synthetic-demo', tick: 0, interval_seconds: 1, machines: 5 } }}
          onReadingSent={() => void refresh()}
          onConnect={m => {
            setSensorConnectMachine(m)
            setModal('sensor-connect')
          }}
        />

        {/* Individual Machine Usable Limits Manager */}
        <IndividualMachineLimitsConfig
          machines={machines}
          shared={limits}
          onSaved={() => void refresh()}
          onConnect={m => {
            setSensorConnectMachine(m)
            setModal('sensor-connect')
          }}
        />

        <section className="panel settings-panel"><div className="panel-heading"><div><p className="eyebrow">ENGINEERING ASSUMPTIONS</p><h2>Shared baseline limits &amp; downtime scenario</h2><p className="panel-subtitle">Set plant-wide fallback bounds and planning assumptions. Individual machines can override these above.</p></div><Settings2 size={18} /></div>
          <form onSubmit={saveLimits} className="limits-form"><LimitInput label="Process temperature" unit="°C" value={limits.process_temperature} onChange={value => setLimits({ ...limits, process_temperature: value })} /><LimitInput label="Torque" unit="Nm" value={limits.torque} onChange={value => setLimits({ ...limits, torque: value })} /><LimitInput label="RPM lower bound" unit="rpm" value={limits.rotational_speed_low} onChange={value => setLimits({ ...limits, rotational_speed_low: value })} /><LimitInput label="RPM upper bound" unit="rpm" value={limits.rotational_speed_high} onChange={value => setLimits({ ...limits, rotational_speed_high: value })} /><LimitInput label="Tool wear" unit="index" value={limits.tool_wear} onChange={value => setLimits({ ...limits, tool_wear: value })} /><LimitInput label="Downtime cost" unit="$/hour" value={limits.downtime_cost_per_hour} onChange={value => setLimits({ ...limits, downtime_cost_per_hour: value })} /><LimitInput label="Repair duration" unit="hours" value={limits.estimated_repair_hours} onChange={value => setLimits({ ...limits, estimated_repair_hours: value })} /><div className="limit-save"><button className="button-primary" disabled={limits.rotational_speed_high <= limits.rotational_speed_low}><Check size={15} /> Save assumptions</button>{settingsMessage && <span className={settingsMessage.includes('Could not') || settingsMessage.includes('must') ? 'form-error' : 'save-message'}>{settingsMessage}</span>}</div></form>
        </section>
        <section className="panel standards-note"><div><p className="eyebrow">REFERENCE SCOPE</p><h2>Standards guide the process; equipment documents set the limits.</h2><p>ISO 17359:2018 provides general condition-monitoring programme guidance. ISO 20816-1:2016 concerns machine vibration measurement and evaluation, not temperature or torque limits. Neither supplies universal alarm values for these sensor fields.</p></div><div className="standards-links"><a href="https://www.iso.org/standard/71194.html" target="_blank" rel="noreferrer">ISO 17359:2018 <ArrowRight size={13} /></a><a href="https://www.iso.org/standard/63180.html" target="_blank" rel="noreferrer">ISO 20816-1:2016 <ArrowRight size={13} /></a></div><p className="standards-caveat">Use each machine manufacturer’s limits where published; otherwise have a qualified site engineer approve a profile and record the reference below. Inherited shared fallbacks remain explicitly unverified assumptions.</p></section>
        <section className="panel machine-limits-panel"><div className="panel-heading"><div><p className="eyebrow">EQUIPMENT-SPECIFIC CONFIGURATION</p><h2>Threshold profiles by machine</h2><p className="panel-subtitle">Overrides apply only to the selected asset. Every custom profile requires a source and reference.</p></div><Settings2 size={18} /></div><div className="machine-limit-list">{machines.map(machine => <MachineLimitEditor key={machine.machine_id} machine={machine} shared={limits} onSaved={() => void refresh()} />)}</div></section>
      </section> : view === 'Events' ? <EventsView events={data?.events ?? []} machines={machines} refresh={refresh} /> : selectedMachine ? <MachineDetail machine={selectedMachine} onBack={() => { setSelectedId(''); const url = new URL(window.location.href); url.searchParams.delete('asset'); window.history.replaceState({}, '', url) }} onReport={() => { setChatOpen(false); setModal('report') }} onChat={() => setChatOpen(true)} onQR={() => { setChatOpen(false); setModal('qr') }} onLogAction={() => setModal('action')} onRemove={() => setModal('remove')} onConnect={() => { setSensorConnectMachine(selectedMachine); setModal('sensor-connect') }} /> : <>
        <section className="overview-heading"><div><p className="eyebrow">OPERATIONS / FLEET OVERVIEW</p><h1>Machine health, at a glance.</h1><p>Incoming measurements, equipment risk, and maintenance response in one place.</p></div><div className="overview-controls">{data?.connections.simulation.enabled ? <button className="button-secondary" onClick={() => void controlSimulation('pause')}><RefreshCw size={15} /> Pause demo</button> : <button className="button-primary" onClick={() => void controlSimulation('start')}><Zap size={15} /> Start demo</button>}<IconButton label="Reset five demo profiles" onClick={() => void controlSimulation('reset')}><RefreshCw size={16} /></IconButton><button className="button-secondary" onClick={() => setModal('qr')}><QrCode size={15} /> QR labels</button><button className="button-primary" onClick={() => setModal('register')}><Plus size={16} /> Register machine</button></div></section>
        <section className="metric-row" aria-label="Fleet summary"><FleetMetric label="Monitored assets" value={data?.metrics.total ?? '—'} detail={`${data?.metrics.simulation_assets ?? 0} in demo feed`} icon={<HardDrive size={17} />} /><FleetMetric label="Critical" value={data?.metrics.critical ?? '—'} detail="Immediate review" icon={<AlertCircle size={17} />} emphasis={(data?.metrics.critical ?? 0) > 0} onClick={() => setRiskFilter('Critical')} /><FleetMetric label="Attention" value={data?.metrics.attention ?? '—'} detail="Threshold exceeded" icon={<AlertTriangle size={17} />} onClick={() => setRiskFilter('Attention')} /><FleetMetric label="Within limits" value={data?.metrics.normal ?? '—'} detail="Latest reading in range" icon={<ShieldCheck size={17} />} /><FleetMetric label="Real devices" value={data?.metrics.real_connected ?? '—'} detail="REST / MQTT source" icon={<Radio size={17} />} onClick={() => setView('Connections')} /><FleetMetric label="Open events" value={data?.metrics.open_events ?? '—'} detail={`${data?.metrics.actions_due ?? 0} follow-ups due`} icon={<Wrench size={17} />} onClick={() => setView('Events')} /></section>
        {machines.length === 0 ? <EmptyFleet onRegister={() => setModal('register')} onConnections={() => setModal('connections')} /> : <>
          <section className="fleet-section"><div className="fleet-heading"><div><p className="eyebrow">REGISTERED EQUIPMENT</p><h2>Fleet register <span className="asset-total">{machines.length}</span></h2></div><div className="fleet-filters"><label className="search-box"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find machine" aria-label="Search machines" />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={13} /></button>}</label><label className="select-wrap"><span className="sr-only">Filter by risk</span><select value={riskFilter} onChange={event => setRiskFilter(event.target.value)}>{riskLabels.map(label => <option key={label}>{label}</option>)}</select><ChevronDown size={14} /></label></div></div>
            {riskFilter === 'Critical' && <div className="critical-filter-note"><AlertCircle size={15} /><span>Critical assets</span><strong>{filteredMachines.length}</strong><span>Latest readings exceed configured thresholds or multiple conditions are active.</span><button onClick={() => setRiskFilter('All risks')}>Clear filter</button></div>}
            <FleetTable machines={filteredMachines} selected={selectedId} select={id => setSelectedId(id)} />
          </section>
          <section className="lower-grid"><section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">LATEST SIGNALS</p><h2>Recent events</h2></div><button className="text-link" onClick={() => setView('Events')}>View event log <ArrowRight size={14} /></button></div>{(data?.events ?? []).slice(0, 4).length === 0 ? <p className="panel-empty">No machine events received.</p> : <div className="recent-events">{data?.events.slice(0, 4).map(event => <button key={event.id} className="recent-event" onClick={() => setSelectedId(event.machine_id)}><span className={`event-mini ${event.severity.toLowerCase()}`}><AlertTriangle size={14} /></span><span><strong>{event.machine_id}</strong><span>{event.condition}</span></span><time>{relativeTime(event.timestamp)}</time></button>)}</div>}</section>
            <section className="panel links-panel"><div className="panel-heading"><div><p className="eyebrow">FIELD WORKFLOW</p><h2>Equipment access</h2></div><QrCode size={18} /></div><p>Print machine labels that open the matching dashboard record. Pair sensors separately through the secured gateway.</p><button className="button-secondary" onClick={() => setModal('qr')}><QrCode size={15} /> Create QR labels</button><button className="button-secondary" onClick={() => setView('Connections')}><Link2 size={15} /> View sensor guide</button></section></section>
        </>}
      </>}
      <footer className="page-footer"><span><ShieldCheck size={14} /> Sensor readings remain on this local installation.</span><span>MAINTAIN-X <i /> API {data ? 'reachable' : 'checking'}</span></footer>
    </main>
    {chatOpen && <ChatPanel machine={selectedMachine} close={() => setChatOpen(false)} />}
    {modal === 'register' && <AddMachineModal close={() => setModal(null)} onCreated={() => void refresh()} shared={limits} />}
    {modal === 'qr' && <QRModal machines={machines} sharedLimits={limits} close={() => setModal(null)} onConnect={m => { setModal('sensor-connect'); setSensorConnectMachine(m) }} />}
    {modal === 'sensor-connect' && sensorConnectMachine && <SensorConnectModal machine={sensorConnectMachine} shared={limits} connections={data?.connections ?? { rest: { name: 'REST', port: 8000, configured: false, endpoint: 'http://127.0.0.1:8000/api/ingest/v1/readings' }, mqtt: { configured: false, connected: false, detail: 'Not configured', host: '', port: 8883 }, websocket: 'ws://127.0.0.1:8000/ws', simulation: { enabled: false, source: 'synthetic-demo', tick: 0, interval_seconds: 1, machines: 5 } }} close={() => setModal(null)} onReadingSent={() => void refresh()} />}
    {modal === 'action' && selectedMachine && <LogActionModal machine={selectedMachine} close={() => setModal(null)} onSaved={() => { void refresh() }} />}
    {modal === 'remove' && selectedMachine && <RemoveMachineModal machine={selectedMachine} close={() => setModal(null)} onRemoved={removeSelected} />}
    {modal === 'connections' && <ConnectionModal connections={data?.connections ?? { rest: { name: 'REST', port: 8000, configured: false, endpoint: 'http://127.0.0.1:8000/api/ingest/v1/readings' }, mqtt: { configured: false, connected: false, detail: 'Not configured', host: '', port: 8883 }, websocket: 'ws://127.0.0.1:8000/ws', simulation: { enabled: false, source: 'synthetic-demo', tick: 0, interval_seconds: 1, machines: 5 } }} close={() => setModal(null)} />}
    {modal === 'report' && selectedMachine && <Modal title={`Maintenance report · ${selectedMachine.machine_id}`} close={() => { setModal(null); setReportError('') }} wide className="report-modal"><ReportPreview machine={selectedMachine} onDownload={() => void downloadReport()} busy={reportBusy} error={reportError} /></Modal>}
    {modal === 'report' && !selectedMachine && <Modal title="Maintenance report" close={() => setModal(null)}><p className="modal-intro">Select a registered machine to generate its report.</p></Modal>}
  </div>
}

function FleetMetric({ label, value, detail, icon, emphasis = false, onClick }: { label: string; value: number | string; detail: string; icon: React.ReactNode; emphasis?: boolean; onClick?: () => void }) {
  return <button className={`fleet-metric ${emphasis ? 'metric-critical' : ''} ${onClick ? 'metric-clickable' : ''}`} onClick={onClick} disabled={!onClick}><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></button>
}

function ConnectionCard({ icon, title, status, port, detail, endpoint }: { icon: React.ReactNode; title: string; status: string; port: number; detail: string; endpoint: string }) {
  return <article className="connection-card"><div className="connection-card-top"><span className="sensor-icon">{icon}</span><span className="port-tag">PORT {port}</span></div><h2>{title}</h2><p>{detail}</p><strong>{status}</strong><code>{endpoint}</code></article>
}

function LimitInput({ label, unit, value, onChange }: { label: string; unit: string; value: number; onChange: (value: number) => void }) {
  return <label className="limit-input">{label}<div><input type="number" value={value} onChange={event => onChange(Number(event.target.value))} /><span>{unit}</span></div></label>
}

function MachineLimitEditor({ machine, shared, onSaved }: { machine: Machine; shared: Limits; onSaved: () => void }) {
  const inherited: MachineLimitProfile = machine.limit_profile ?? {
    mode: 'inherit', process_temperature: shared.process_temperature, torque: shared.torque,
    rotational_speed_low: shared.rotational_speed_low, rotational_speed_high: shared.rotational_speed_high,
    tool_wear: shared.tool_wear, source: 'inherited_default', reference: 'Shared fallback assumptions; not equipment-certified',
  }
  const [profile, setProfile] = useState<MachineLimitProfile>(inherited)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setProfile(machine.limit_profile ?? inherited) }, [machine.machine_id, machine.limit_profile?.mode, machine.limit_profile?.updated_at, shared.process_temperature, shared.torque, shared.rotational_speed_low, shared.rotational_speed_high, shared.tool_wear])
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setMessage('')
    try {
      const payload = profile.mode === 'inherit' ? { mode: 'inherit' } : profile
      const saved = await request<MachineLimitProfile>(`/api/machines/${encodeURIComponent(machine.machine_id)}/limits`, { method: 'PUT', body: JSON.stringify(payload) })
      setProfile(saved); setMessage('Profile saved and current risk reassessed.'); onSaved()
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not save machine limits') }
    finally { setSaving(false) }
  }
  function setNumber(key: keyof Pick<MachineLimitProfile, 'process_temperature' | 'torque' | 'rotational_speed_low' | 'rotational_speed_high' | 'tool_wear'>, value: number) {
    setProfile(current => ({ ...current, [key]: value }))
  }
  return <details className="machine-limit-editor"><summary><span><strong>{machine.machine_id}</strong><span>{machine.equipment_type}</span></span><span className={`profile-badge ${profile.mode}`}>{profile.mode === 'custom' ? `Custom · ${profile.source === 'manufacturer' ? 'OEM' : 'Site approved'}` : 'Inherited fallback'}</span><ChevronDown size={15} /></summary>
    <form onSubmit={save} className="machine-profile-form"><p className="profile-current-note">{profile.mode === 'inherit' ? `Using shared fallback: ${shared.process_temperature} °C · ${shared.torque} Nm · ${shared.rotational_speed_low}–${shared.rotational_speed_high} rpm · wear ${shared.tool_wear}.` : 'Custom values are active for this machine only.'}</p>
      <div className="profile-mode"><button type="button" className={profile.mode === 'inherit' ? 'selected' : ''} onClick={() => setProfile({ ...inherited, mode: 'inherit', source: 'inherited_default' })}>Use shared fallback</button><button type="button" className={profile.mode === 'custom' ? 'selected' : ''} onClick={() => setProfile({ ...profile, mode: 'custom', source: profile.source === 'inherited_default' ? 'site_engineering' : profile.source, reference: profile.reference === 'Shared fallback assumptions; not equipment-certified' ? '' : profile.reference })}>Set machine profile</button></div>
      {profile.mode === 'custom' && <><div className="machine-profile-fields"><LimitInput label="Process temperature" unit="°C" value={profile.process_temperature} onChange={value => setNumber('process_temperature', value)} /><LimitInput label="Torque" unit="Nm" value={profile.torque} onChange={value => setNumber('torque', value)} /><LimitInput label="RPM lower" unit="rpm" value={profile.rotational_speed_low} onChange={value => setNumber('rotational_speed_low', value)} /><LimitInput label="RPM upper" unit="rpm" value={profile.rotational_speed_high} onChange={value => setNumber('rotational_speed_high', value)} /><LimitInput label="Wear indicator" unit="index" value={profile.tool_wear} onChange={value => setNumber('tool_wear', value)} /></div><div className="provenance-fields"><label>Threshold source<select value={profile.source === 'manufacturer' ? 'manufacturer' : 'site_engineering'} onChange={event => setProfile({ ...profile, source: event.target.value as 'manufacturer' | 'site_engineering' })}><option value="manufacturer">Manufacturer manual / data sheet</option><option value="site_engineering">Site engineering approval</option></select></label><label>Reference<input required value={profile.reference} onChange={event => setProfile({ ...profile, reference: event.target.value })} placeholder="Document title, revision, page, approval ID" maxLength={300} /></label></div></>}
      <div className="profile-save"><button className="button-primary" disabled={saving || (profile.mode === 'custom' && profile.rotational_speed_high <= profile.rotational_speed_low)}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />} Save profile</button>{message && <span>{message}</span>}</div>
    </form>
  </details>
}

function IndividualMachineLimitsConfig({
  machines,
  shared,
  onSaved,
  onConnect,
}: {
  machines: Machine[]
  shared: Limits
  onSaved: () => void
  onConnect: (machine: Machine) => void
}) {
  const [targetId, setTargetId] = useState<string>('NEW')
  const [machineName, setMachineName] = useState('')
  const [machineId, setMachineId] = useState('')
  const [equipmentType, setEquipmentType] = useState('Industrial equipment')
  const [criticality, setCriticality] = useState('1.0')

  // Operating limits (anchored by default)
  const [temp, setTemp] = useState<number>(shared.process_temperature)
  const [torque, setTorque] = useState<number>(shared.torque)
  const [rpmLow, setRpmLow] = useState<number>(shared.rotational_speed_low)
  const [rpmHigh, setRpmHigh] = useState<number>(shared.rotational_speed_high)
  const [toolWear, setToolWear] = useState<number>(shared.tool_wear)
  const [source, setSource] = useState<'manufacturer' | 'site_engineering'>('site_engineering')
  const [reference, setReference] = useState('Site engineering baseline calibration')

  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string; machine?: Machine } | null>(null)

  const handleSelect = (id: string) => {
    setTargetId(id)
    setFeedback(null)
    if (id === 'NEW') {
      setMachineName('')
      setMachineId('')
      setEquipmentType('Industrial equipment')
      setCriticality('1.0')
      setTemp(shared.process_temperature)
      setTorque(shared.torque)
      setRpmLow(shared.rotational_speed_low)
      setRpmHigh(shared.rotational_speed_high)
      setToolWear(shared.tool_wear)
      setSource('site_engineering')
      setReference('Site engineering baseline calibration')
    } else {
      const found = machines.find(m => m.machine_id === id)
      if (found) {
        setMachineName(found.machine_name || found.machine_id)
        setMachineId(found.machine_id)
        setEquipmentType(found.equipment_type || 'Industrial equipment')
        setCriticality(String(found.criticality ?? 1.0))
        const p = found.limit_profile
        setTemp(p?.process_temperature ?? shared.process_temperature)
        setTorque(p?.torque ?? shared.torque)
        setRpmLow(p?.rotational_speed_low ?? shared.rotational_speed_low)
        setRpmHigh(p?.rotational_speed_high ?? shared.rotational_speed_high)
        setToolWear(p?.tool_wear ?? shared.tool_wear)
        setSource(p?.source === 'manufacturer' ? 'manufacturer' : 'site_engineering')
        setReference(p?.reference || 'Site engineering calibration')
      }
    }
  }

  const handleResetToBaseline = () => {
    setTemp(shared.process_temperature)
    setTorque(shared.torque)
    setRpmLow(shared.rotational_speed_low)
    setRpmHigh(shared.rotational_speed_high)
    setToolWear(shared.tool_wear)
    setFeedback(null)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const finalId = machineId.trim()
    if (!finalId) {
      setFeedback({ type: 'error', text: 'Machine ID is required.' })
      return
    }
    if (rpmHigh <= rpmLow) {
      setFeedback({ type: 'error', text: 'RPM upper limit must exceed lower limit.' })
      return
    }
    setSaving(true)
    setFeedback(null)

    try {
      const saved = await request<Machine>('/api/machines', {
        method: 'POST',
        body: JSON.stringify({
          machine_id: finalId,
          machine_name: machineName.trim() || finalId,
          equipment_type: equipmentType.trim() || 'Industrial equipment',
          criticality: Number(criticality) || 1.0,
          limits: {
            mode: 'custom',
            process_temperature: temp,
            torque: torque,
            rotational_speed_low: rpmLow,
            rotational_speed_high: rpmHigh,
            tool_wear: toolWear,
            source: source,
            reference: reference.trim() || 'Site engineering calibration',
          },
        }),
      })

      setFeedback({
        type: 'success',
        text: `Usable limits for "${saved.machine_name || saved.machine_id}" saved! Operating thresholds are now active and anchored.`,
        machine: saved,
      })
      onSaved()
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not save machine usable limits.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="individual-limits-panel">
      <div className="individual-limits-header">
        <div>
          <p className="eyebrow">EQUIPMENT PARAMETER CONFIGURATION</p>
          <h2>Configure Individual Machine Usable Limits</h2>
          <p className="panel-subtitle">
            Manually type or select a machine and customize its usable limits. Non-customized parameters remain safely anchored to verified engineering defaults.
          </p>
        </div>
        <Sliders size={20} style={{ color: 'var(--steel)' }} />
      </div>

      <form onSubmit={handleSubmit} className="individual-limits-form">
        {/* Machine Target Selection */}
        <div className="machine-target-row">
          <label>
            Select Target Machine
            <select value={targetId} onChange={e => handleSelect(e.target.value)}>
              <option value="NEW">+ Type &amp; Configure New Machine</option>
              {machines.map(m => (
                <option key={m.machine_id} value={m.machine_id}>
                  {m.machine_name || m.machine_id} ({m.machine_id})
                </option>
              ))}
            </select>
          </label>
          <label>
            Machine Name
            <input
              required
              value={machineName}
              onChange={e => setMachineName(e.target.value)}
              placeholder="e.g. North Line Hydraulic Press"
            />
          </label>
          <label>
            Machine ID
            <input
              required
              value={machineId}
              onChange={e => setMachineId(e.target.value.toUpperCase())}
              placeholder="e.g. PRESS-01"
              disabled={targetId !== 'NEW'}
            />
          </label>
          <label>
            Equipment Type
            <input
              value={equipmentType}
              onChange={e => setEquipmentType(e.target.value)}
              placeholder="e.g. Hydraulic Press"
            />
          </label>
          <label>
            Criticality Multiplier
            <select value={criticality} onChange={e => setCriticality(e.target.value)}>
              <option value="0.5">0.5 · Standard</option>
              <option value="1.0">1.0 · Standard</option>
              <option value="2.0">2.0 · Important</option>
              <option value="3.0">3.0 · High consequence</option>
              <option value="5.0">5.0 · Essential process</option>
            </select>
          </label>
        </div>

        {/* Usable Limits Grid with Anchored Status Pills */}
        <div className="limits-input-grid">
          <div className={`limit-input-card ${temp === shared.process_temperature ? 'is-anchored' : 'is-custom'}`}>
            <div className="limit-card-top">
              <span>Process Temp</span>
              <span className={`anchor-pill ${temp === shared.process_temperature ? 'anchored' : 'custom'}`}>
                <Anchor size={9} /> {temp === shared.process_temperature ? 'Anchored' : 'Custom'}
              </span>
            </div>
            <input type="number" value={temp} onChange={e => setTemp(Number(e.target.value))} min={20} max={150} step={0.5} />
            <span className="limit-unit-hint">Limit in °C (Baseline: {shared.process_temperature}°C)</span>
          </div>

          <div className={`limit-input-card ${torque === shared.torque ? 'is-anchored' : 'is-custom'}`}>
            <div className="limit-card-top">
              <span>Torque Limit</span>
              <span className={`anchor-pill ${torque === shared.torque ? 'anchored' : 'custom'}`}>
                <Anchor size={9} /> {torque === shared.torque ? 'Anchored' : 'Custom'}
              </span>
            </div>
            <input type="number" value={torque} onChange={e => setTorque(Number(e.target.value))} min={10} max={300} step={0.5} />
            <span className="limit-unit-hint">Limit in Nm (Baseline: {shared.torque} Nm)</span>
          </div>

          <div className={`limit-input-card ${rpmLow === shared.rotational_speed_low ? 'is-anchored' : 'is-custom'}`}>
            <div className="limit-card-top">
              <span>RPM Lower Bound</span>
              <span className={`anchor-pill ${rpmLow === shared.rotational_speed_low ? 'anchored' : 'custom'}`}>
                <Anchor size={9} /> {rpmLow === shared.rotational_speed_low ? 'Anchored' : 'Custom'}
              </span>
            </div>
            <input type="number" value={rpmLow} onChange={e => setRpmLow(Number(e.target.value))} min={0} max={9999} />
            <span className="limit-unit-hint">Minimum RPM (Baseline: {shared.rotational_speed_low})</span>
          </div>

          <div className={`limit-input-card ${rpmHigh === shared.rotational_speed_high ? 'is-anchored' : 'is-custom'}`}>
            <div className="limit-card-top">
              <span>RPM Upper Bound</span>
              <span className={`anchor-pill ${rpmHigh === shared.rotational_speed_high ? 'anchored' : 'custom'}`}>
                <Anchor size={9} /> {rpmHigh === shared.rotational_speed_high ? 'Anchored' : 'Custom'}
              </span>
            </div>
            <input type="number" value={rpmHigh} onChange={e => setRpmHigh(Number(e.target.value))} min={1} max={10000} />
            <span className="limit-unit-hint">Maximum RPM (Baseline: {shared.rotational_speed_high})</span>
          </div>

          <div className={`limit-input-card ${toolWear === shared.tool_wear ? 'is-anchored' : 'is-custom'}`}>
            <div className="limit-card-top">
              <span>Tool Wear Limit</span>
              <span className={`anchor-pill ${toolWear === shared.tool_wear ? 'anchored' : 'custom'}`}>
                <Anchor size={9} /> {toolWear === shared.tool_wear ? 'Anchored' : 'Custom'}
              </span>
            </div>
            <input type="number" value={toolWear} onChange={e => setToolWear(Number(e.target.value))} min={0} max={1000} />
            <span className="limit-unit-hint">Indicator index (Baseline: {shared.tool_wear})</span>
          </div>
        </div>

        {/* Provenance Fields */}
        <div className="provenance-fields" style={{ margin: 0 }}>
          <label>
            Threshold Approval Source
            <select value={source} onChange={e => setSource(e.target.value as 'manufacturer' | 'site_engineering')}>
              <option value="site_engineering">Site engineering approval</option>
              <option value="manufacturer">Manufacturer manual / OEM datasheet</option>
            </select>
          </label>
          <label>
            Document Reference / Approval Note
            <input
              required
              value={reference}
              onChange={e => setReference(e.target.value)}
              placeholder="e.g. OEM Manual Rev 2, Section 4.1 or Engineering Work Order #1042"
            />
          </label>
        </div>

        {/* Action Row */}
        <div className="anchor-actions-row">
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button type="submit" className="button-primary" disabled={saving || rpmHigh <= rpmLow}>
              {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
              Save Usable Limits
            </button>
            <button type="button" className="button-secondary" onClick={handleResetToBaseline}>
              <RefreshCw size={13} /> Reset to Anchored Defaults
            </button>
          </div>
          {feedback && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className={feedback.type === 'success' ? 'save-message' : 'form-error'}>
                {feedback.text}
              </span>
              {feedback.machine && (
                <button
                  type="button"
                  className="button-primary small-button"
                  onClick={() => onConnect(feedback.machine!)}
                >
                  <Radio size={13} /> Connect Sensor / QR for {feedback.machine.machine_id}
                </button>
              )}
            </div>
          )}
        </div>
      </form>
    </section>
  )
}

function RealSensorsGuide({
  machines,
  shared,
  connections,
  onReadingSent,
  onConnect,
}: {
  machines: Machine[]
  shared: Limits
  connections: Dashboard['connections']
  onReadingSent: () => void
  onConnect: (machine: Machine) => void
}) {
  const [activeTab, setActiveTab] = useState<'esp32' | 'python' | 'mqtt' | 'curl'>('esp32')
  const [selectedMachineId, setSelectedMachineId] = useState<string>(machines[0]?.machine_id ?? 'PRESS-01')
  const [gatewayHost, setGatewayHost] = useState(window.location.hostname || '127.0.0.1')
  const [token, setToken] = useState('replace-with-a-long-random-secret')
  const [copied, setCopied] = useState(false)

  // Interactive Live Tester state
  const [testTemp, setTestTemp] = useState(68.5)
  const [testSpeed, setTestSpeed] = useState(1480)
  const [testTorque, setTestTorque] = useState(74.0)
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<{ status: 'success' | 'error'; text: string } | null>(null)

  const machine = machines.find(m => m.machine_id === selectedMachineId) ?? machines[0]
  const limits = machine?.limit_profile?.mode === 'custom' ? machine.limit_profile : shared
  const ingestUrl = `http://${gatewayHost}:${connections.rest.port}/api/ingest/v1/readings`

  const esp32Code = `/*
 * MAINTAIN-X Physical Sensor Transmitter
 * Target Machine: ${machine?.machine_name || selectedMachineId} (${selectedMachineId})
 * Hardware: ESP32 / ESP8266 / Arduino WiFi
 */
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* INGEST_URL    = "${ingestUrl}";
const char* INGEST_TOKEN  = "${token}";
const char* MACHINE_ID    = "${selectedMachineId}";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\\nWiFi Connected! IP: " + WiFi.localIP().toString());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(INGEST_URL);
    http.addHeader("Content-Type", "application/json");
    if (strlen(INGEST_TOKEN) > 0) {
      http.addHeader("Authorization", String("Bearer ") + INGEST_TOKEN);
    }

    // 1. Read your physical sensors:
    // - Temp: MAX6675 thermocouple or DS18B20
    // - RPM: Optical encoder or Hall pulse counter
    // - Torque: ACS712 CT current or load cell ADC
    float process_temp = 68.2;  // Usable limit: ${limits.process_temperature} C
    float rpm          = 1480.0; // Usable band: ${limits.rotational_speed_low}-${limits.rotational_speed_high} rpm
    float torque       = 74.5;   // Usable limit: ${limits.torque} Nm
    float tool_wear    = 120.0;  // Indicator limit: ${limits.tool_wear}

    String json = "{\\"machine_id\\":\\"" + String(MACHINE_ID) + "\\","
      + "\\"equipment_type\\":\\"${machine?.equipment_type || 'Industrial equipment'}\\","
      + "\\"process_temperature\\":" + String(process_temp, 2) + ","
      + "\\"rotational_speed\\":" + String(rpm, 1) + ","
      + "\\"torque\\":" + String(torque, 2) + ","
      + "\\"tool_wear\\":" + String(tool_wear, 1) + ","
      + "\\"operating_state\\":\\"RUNNING\\"}";

    int httpCode = http.POST(json);
    Serial.printf("[HTTP] POST: %d (Payload: %s)\\n", httpCode, json.c_str());
    http.end();
  }
  delay(2000); // 2-second telemetry interval
}`

  const pythonCode = `"""
MAINTAIN-X Real Sensor Gateway Script
Machine: ${machine?.machine_name || selectedMachineId} (${selectedMachineId})
Platform: Raspberry Pi / Linux Gateway / Edge PC
"""
import time
import requests

INGEST_URL   = "${ingestUrl}"
INGEST_TOKEN = "${token}"
MACHINE_ID   = "${selectedMachineId}"
EQUIPMENT    = "${machine?.equipment_type || 'Industrial equipment'}"

def read_hardware_sensors():
    # Read physical sensors over SPI, I2C, 1-Wire, GPIO, or Modbus:
    return {
        "process_temperature": 68.5,  # Usable limit: ${limits.process_temperature} C
        "air_temperature": 26.0,
        "rotational_speed": 1490.0,   # Usable band: ${limits.rotational_speed_low} - ${limits.rotational_speed_high} rpm
        "torque": 76.2,               # Usable limit: ${limits.torque} Nm
        "tool_wear": 125.0,           # Indicator limit: ${limits.tool_wear}
        "operating_state": "RUNNING",
    }

def main():
    print(f"Connecting sensors for {MACHINE_ID} to {INGEST_URL}...")
    headers = {"Content-Type": "application/json"}
    if INGEST_TOKEN:
        headers["Authorization"] = f"Bearer {INGEST_TOKEN}"

    while True:
        try:
            telemetry = {
                "machine_id": MACHINE_ID,
                "equipment_type": EQUIPMENT,
                **read_hardware_sensors(),
            }
            res = requests.post(INGEST_URL, json=telemetry, headers=headers, timeout=5)
            if res.status_code == 200:
                risk = res.json().get("assessment", {}).get("risk", "Unknown")
                print(f"[OK 200] Telemetry delivered! Health assessment: {risk}")
            else:
                print(f"[ERR {res.status_code}] Response: {res.text}")
        except Exception as err:
            print(f"[DISCONNECTED] Retrying gateway connection: {err}")
        time.sleep(2.0)

if __name__ == "__main__":
    main()`

  const mqttCode = `"""
MAINTAIN-X Industrial MQTT Publisher
Broker: ${connections.mqtt.host || 'mqtt.yourplant.local'} : ${connections.mqtt.port}
Topic: maintain-x/${selectedMachineId}/readings
"""
import json
import time
import paho.mqtt.client as mqtt

BROKER_HOST = "${connections.mqtt.host || '127.0.0.1'}"
BROKER_PORT = ${connections.mqtt.port}
TOPIC       = "maintain-x/${selectedMachineId}/readings"

client = mqtt.Client(client_id="sensor-gateway-${selectedMachineId}")
# client.username_pw_set("username", "password")
# client.tls_set() # Enable if TLS 8883 is used
client.connect(BROKER_HOST, BROKER_PORT, 60)
client.loop_start()

while True:
    payload = {
        "machine_id": "${selectedMachineId}",
        "process_temperature": 68.4,
        "rotational_speed": 1485.0,
        "torque": 75.1,
        "tool_wear": 122.0,
        "operating_state": "RUNNING"
    }
    client.publish(TOPIC, json.dumps(payload), qos=1)
    print(f"Published telemetry to {TOPIC}")
    time.sleep(2.0)`

  const curlCode = `curl -X POST ${ingestUrl} \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"machine_id":"${selectedMachineId}","equipment_type":"${machine?.equipment_type || 'Industrial equipment'}","process_temperature":68.5,"rotational_speed":1480,"torque":75.0,"tool_wear":120,"operating_state":"RUNNING"}'`

  const activeSnippet = activeTab === 'esp32' ? esp32Code : activeTab === 'python' ? pythonCode : activeTab === 'mqtt' ? mqttCode : curlCode

  const copySnippet = async () => {
    await navigator.clipboard.writeText(activeSnippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const sendTestIngest = async () => {
    setTestSending(true)
    setTestResult(null)
    try {
      const payload = {
        machine_id: selectedMachineId,
        equipment_type: machine?.equipment_type || 'Industrial equipment',
        process_temperature: testTemp,
        rotational_speed: testSpeed,
        torque: testTorque,
        tool_wear: 110,
        operating_state: 'RUNNING',
      }
      const res = await fetch(`${API}/api/ingest/v1/readings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTestResult({
        status: 'success',
        text: `✓ Live telemetry received by API! Assessment Risk: "${data?.assessment?.risk ?? 'Normal'}". WebSocket refreshed.`,
      })
      onReadingSent()
    } catch (e) {
      setTestResult({
        status: 'error',
        text: `✗ Ingestion rejected: ${e instanceof Error ? e.message : 'Connection failed.'} Check token or server status.`,
      })
    } finally {
      setTestSending(false)
    }
  }

  return (
    <section className="real-sensor-guide">
      <div className="guide-header-badge">
        <Cpu size={14} /> PRODUCTION REAL SENSOR GUIDE
      </div>
      <h2>How to Connect Real Sensors to the Dashboard</h2>
      <p className="panel-subtitle">
        Everything you need to stream live readings from physical transducers into MAINTAIN-X over HTTP or MQTT.
      </p>

      {/* Answer Callout: Do we need to upload code? */}
      <div className="guide-answer-callout">
        <h3>Do we need to upload any code to connect sensors?</h3>
        <p>
          <strong>YES! Physical sensors require firmware code on a microcontroller or edge gateway.</strong>
          <br />
          Physical transducers (like thermocouples, Hall effect sensors, and CT current clamps) output analog voltages or raw electrical pulses—they cannot speak directly to web browsers. To ingest live data, wire your sensors to a micro-controller (<strong>ESP32</strong>, <strong>Arduino WiFi</strong>) or an edge computer (<strong>Raspberry Pi</strong>). That device executes the code below, which samples your sensor pins, packages the measurements into JSON, and sends an authenticated <code>POST /api/ingest/v1/readings</code> request.
        </p>
      </div>

      {/* Architecture Strip */}
      <div className="architecture-strip">
        <div className="arch-step">
          <span className="arch-step-badge">1</span>
          <div className="arch-step-content"><strong>Physical Sensors</strong><span>MAX6675, Hall, CT clamp</span></div>
        </div>
        <div className="arch-divider"><ArrowRight size={14} /></div>
        <div className="arch-step">
          <span className="arch-step-badge">2</span>
          <div className="arch-step-content"><strong>Microcontroller / Pi</strong><span>Runs sensor driver firmware</span></div>
        </div>
        <div className="arch-divider"><ArrowRight size={14} /></div>
        <div className="arch-step">
          <span className="arch-step-badge">3</span>
          <div className="arch-step-content"><strong>Local WiFi / LAN</strong><span>Secured private network</span></div>
        </div>
        <div className="arch-divider"><ArrowRight size={14} /></div>
        <div className="arch-step">
          <span className="arch-step-badge">4</span>
          <div className="arch-step-content"><strong>REST / MQTT Ingest</strong><span>POST /api/ingest/v1/readings</span></div>
        </div>
        <div className="arch-divider"><ArrowRight size={14} /></div>
        <div className="arch-step">
          <span className="arch-step-badge">5</span>
          <div className="arch-step-content"><strong>Live Dashboard</strong><span>Real-time WebSocket alerts</span></div>
        </div>
      </div>

      {/* Sensor Hardware Matrix */}
      <div className="sensor-matrix-grid">
        <article className="sensor-card">
          <div className="sensor-card-top"><Thermometer size={16} /> Process Temperature</div>
          <strong>MAX6675 / DS18B20</strong>
          <p>K-type thermocouple with SPI amplifier or 1-Wire probe attached to bearing/chassis.</p>
          <code>Field: process_temperature (°C)</code>
        </article>
        <article className="sensor-card">
          <div className="sensor-card-top"><Gauge size={16} /> Rotational Speed</div>
          <strong>Optical / Hall Pulse Counter</strong>
          <p>TCRT5000 IR sensor or 3144 Hall-effect sensor on interrupt pin counting pulses per rev.</p>
          <code>Field: rotational_speed (rpm)</code>
        </article>
        <article className="sensor-card">
          <div className="sensor-card-top"><Zap size={16} /> Motor Torque / Load</div>
          <strong>ACS712 / CT Current Clamp</strong>
          <p>SCT-013 non-invasive current sensor or strain gauge + HX711 24-bit ADC module.</p>
          <code>Field: torque (Nm)</code>
        </article>
        <article className="sensor-card">
          <div className="sensor-card-top"><Activity size={16} /> Tool Wear / Vibration</div>
          <strong>Spindle Counter / Piezo RMS</strong>
          <p>Accumulated cutting hours or SW-420 / ADXL345 vibration intensity indicator.</p>
          <code>Field: tool_wear (index)</code>
        </article>
      </div>

      {/* Interactive Code Generator */}
      <div className="code-generator-section">
        <div className="code-generator-controls">
          <label>
            Tailor for Machine:
            <select value={selectedMachineId} onChange={e => setSelectedMachineId(e.target.value)}>
              {machines.map(m => (
                <option key={m.machine_id} value={m.machine_id}>
                  {m.machine_name || m.machine_id} ({m.machine_id})
                </option>
              ))}
            </select>
          </label>
          <label>
            Server Host IP:
            <input value={gatewayHost} onChange={e => setGatewayHost(e.target.value)} placeholder="192.168.1.100" />
          </label>
          <label>
            Ingest Token:
            <input value={token} onChange={e => setToken(e.target.value)} placeholder="Bearer token" />
          </label>
          {machine && (
            <button className="button-secondary small-button" style={{ marginLeft: 'auto' }} onClick={() => onConnect(machine)}>
              <QrCode size={13} /> View QR &amp; Setup for {selectedMachineId}
            </button>
          )}
        </div>

        <div className="code-lang-tabs">
          <button className={`code-lang-tab ${activeTab === 'esp32' ? 'active' : ''}`} onClick={() => setActiveTab('esp32')}>
            <Cpu size={13} style={{ marginRight: 4 }} /> ESP32 / Arduino (C++)
          </button>
          <button className={`code-lang-tab ${activeTab === 'python' ? 'active' : ''}`} onClick={() => setActiveTab('python')}>
            <Terminal size={13} style={{ marginRight: 4 }} /> Raspberry Pi / Python
          </button>
          <button className={`code-lang-tab ${activeTab === 'mqtt' ? 'active' : ''}`} onClick={() => setActiveTab('mqtt')}>
            <Radio size={13} style={{ marginRight: 4 }} /> MQTT Publisher
          </button>
          <button className={`code-lang-tab ${activeTab === 'curl' ? 'active' : ''}`} onClick={() => setActiveTab('curl')}>
            <Code size={13} style={{ marginRight: 4 }} /> cURL Test Command
          </button>
        </div>

        <div className="code-display-wrap">
          <div className="code-display-actions">
            <button className="code-copy-btn" onClick={copySnippet}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied code' : 'Copy code snippet'}
            </button>
          </div>
          <pre><code>{activeSnippet}</code></pre>
        </div>
      </div>

      {/* Interactive Live Ingest Test Console */}
      <div className="live-ingest-tester">
        <h4>Interactive Telemetry Ingest Test</h4>
        <p>Send a real test packet directly from your browser to verify API readiness and watch the live fleet update.</p>
        <div className="tester-inputs">
          <label>
            Process Temp (°C)
            <input type="number" value={testTemp} onChange={e => setTestTemp(Number(e.target.value))} step={0.5} />
          </label>
          <label>
            Speed (RPM)
            <input type="number" value={testSpeed} onChange={e => setTestSpeed(Number(e.target.value))} />
          </label>
          <label>
            Torque (Nm)
            <input type="number" value={testTorque} onChange={e => setTestTorque(Number(e.target.value))} step={0.5} />
          </label>
        </div>
        <button className="button-primary small-button" onClick={sendTestIngest} disabled={testSending}>
          {testSending ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}
          Test Ingestion for {selectedMachineId}
        </button>
        {testResult && (
          <div className={`tester-response ${testResult.status}`}>
            {testResult.text}
          </div>
        )}
      </div>
    </section>
  )
}

function ReportPreview({ machine, onDownload, busy, error }: { machine: Machine; onDownload: () => void; busy: boolean; error: string }) {
  const [report, setReport] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => { let active = true; void request<Record<string, unknown>>(`/api/reports/${encodeURIComponent(machine.machine_id)}`).then(data => { if (active) setReport(data) }).catch(() => undefined).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [machine.machine_id])
  const events = (report?.events as Event[] | undefined) ?? []
  const actions = (report?.actions as { timestamp: string; action: string; notes: string }[] | undefined) ?? []
  return <div className="report-preview"><p className="modal-intro">Generated from recorded equipment readings and event history; no model-generated fault diagnosis is asserted.</p><div className="report-summary"><div><span className="eyebrow">EQUIPMENT</span><strong>{machine.machine_id}</strong><span>{machine.equipment_type}</span></div><div><span className="eyebrow">CURRENT STATUS</span><RiskPill risk={machine.risk} /><span>{relativeTime(machine.timestamp)}</span></div><div><span className="eyebrow">EVENTS / ACTIONS</span><strong>{loading ? '…' : `${events.length} / ${actions.length}`}</strong><span>recorded entries</span></div></div><h3>Event history</h3>{events.length ? <div className="report-lines">{events.map(event => <p key={event.id}><time>{new Date(event.timestamp).toLocaleString()}</time><strong>{event.severity} · {event.status}</strong>{event.condition}<span>Suggested: {event.recommended_action}</span></p>)}</div> : <p className="empty-note">No recorded threshold events for this asset.</p>}<h3>Corrective action history</h3>{actions.length ? <div className="report-lines">{actions.map((action, index) => <p key={`${action.timestamp}-${index}`}><time>{new Date(action.timestamp).toLocaleString()}</time><strong>{action.action}</strong>{action.notes}</p>)}</div> : <p className="empty-note">No maintenance actions have been logged.</p>}<div className="report-footer"><span>Report generated {new Date().toLocaleString()}</span>{error && <span className="form-error">{error}</span>}<button className="button-primary" onClick={onDownload} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />} Download JSON report</button><a className="button-secondary" href={`/api/reports/${encodeURIComponent(machine.machine_id)}/events.csv`} download><ArrowDownToLine size={15} /> Events CSV</a><button className="button-secondary" onClick={() => window.print()}><Download size={15} /> Print</button></div></div>
}

export default App