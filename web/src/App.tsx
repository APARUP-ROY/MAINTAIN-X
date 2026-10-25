import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity, AlertCircle, AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowRight,
  Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3,
  Copy, Download, Gauge, HardDrive, Link2, LoaderCircle, MessageSquare,
  Plus, QrCode, Radio, RefreshCw, Search, Send, Settings2, ShieldCheck,
  Thermometer, Wrench, X, Zap,
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

function QRModal({ machines, close }: { machines: Machine[]; close: () => void }) {
  const [copied, setCopied] = useState('')
  async function copy(value: string, id: string) { await navigator.clipboard.writeText(value); setCopied(id); window.setTimeout(() => setCopied(''), 1500) }
  return <Modal title="Machine identification labels" close={close} wide className="qr-modal">
    <p className="modal-intro">Each QR opens that machine’s MAINTAIN-X detail view at <code>{QR_DASHBOARD_URL}</code>. Scanning does not pair or configure a sensor; telemetry requires a separately provisioned gateway connection.</p>
    {machines.length === 0 ? <p className="empty-note">Register an asset before creating its label.</p> : <div className="qr-grid">{machines.map(machine => {
      const url = `${QR_DASHBOARD_URL}/?asset=${encodeURIComponent(machine.machine_id)}`
      return <article className="qr-label" key={machine.machine_id}><QRCodeSVG value={url} size={116} level="M" includeMargin /><div><p className="eyebrow">EQUIPMENT ID</p><h3>{machine.machine_name || machine.machine_id}</h3><p>{machine.machine_id} · {machine.equipment_type}</p><button className="button-secondary small-button" onClick={() => void copy(url, machine.machine_id)}>{copied === machine.machine_id ? <Check size={14} /> : <Copy size={14} />}{copied === machine.machine_id ? 'Copied' : 'Copy asset link'}</button></div></article>
    })}</div>}
    <div className="modal-footer"><button className="button-secondary" onClick={() => window.print()}><Download size={15} /> Print labels</button></div>
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

function MachineDetail({ machine, onBack, onReport, onChat, onQR, onLogAction, onRemove }: { machine: Machine; onBack: () => void; onReport: () => void; onChat: () => void; onQR: () => void; onLogAction: () => void; onRemove: () => void }) {
  const [history, setHistory] = useState<Record<string, number | string | null>[]>([])
  useEffect(() => { void request<Record<string, number | string | null>[]>(`/api/machines/${encodeURIComponent(machine.machine_id)}/history?limit=90`).then(setHistory).catch(() => setHistory([])) }, [machine.machine_id, machine.timestamp])
  const series = history.map(row => ({ ...row, time: row.timestamp ? new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '' }))
  return <section className="detail-view">
    <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Fleet overview</button>
    <div className="detail-title"><div><p className="eyebrow">ASSET INTELLIGENCE / {machine.equipment_type.toUpperCase()}</p><h1>{machine.machine_name || machine.machine_id}</h1><p className="detail-subtitle">ID: {machine.machine_id} <span>·</span> {machine.equipment_type} <span>·</span> Criticality ×{machine.criticality.toFixed(1)} <span>·</span> {machine.operating_state ?? 'Awaiting data'}</p></div><div className="detail-actions"><RiskPill risk={machine.risk} /><button className="button-secondary" onClick={onReport}><ArrowDownToLine size={15} /> Report</button><button className="button-secondary" onClick={onLogAction}><Wrench size={15} /> Log action</button><button className="button-secondary" onClick={onQR}><QrCode size={15} /> QR label</button><button className="button-primary" onClick={onChat}><MessageSquare size={15} /> Ask assistant</button></div></div>
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
  const [modal, setModal] = useState<'register' | 'qr' | 'connections' | 'report' | 'action' | 'remove' | null>(null)
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

      {view === 'Connections' ? <section className="section-view"><div className="section-heading"><div><p className="eyebrow">DEVICE NETWORK</p><h1>Connections</h1><p>Authenticated ingress and gateway readiness. No field device is considered connected until its first reading.</p></div><button className="button-primary" onClick={() => setModal('connections')}><Link2 size={15} /> Setup guide</button></div>
        <div className="connection-cards"><ConnectionCard icon={<Link2 size={18} />} title="REST sensor gateway" status={data?.connections.rest.configured ? `${data.metrics.real_connected} device(s) recently reporting` : 'Needs server token'} port={data?.connections.rest.port ?? 8000} detail="HTTP JSON ingestion · authenticated gateway" endpoint="/api/ingest/v1/readings" /><ConnectionCard icon={<Radio size={18} />} title="MQTT broker" status={data?.connections.mqtt.connected ? 'Connected' : data?.connections.mqtt.configured ? 'Configured · offline' : 'Optional · not configured'} port={data?.connections.mqtt.port ?? 8883} detail={data?.connections.mqtt.detail ?? 'TLS enabled by default'} endpoint={data?.connections.mqtt.host || 'Set MQTT_BROKER_HOST on the API server'} /><ConnectionCard icon={<Activity size={18} />} title="One-second demo feed" status={data?.connections.simulation.enabled ? 'Running' : 'Paused'} port={data?.connections.rest.port ?? 8000} detail={`${data?.connections.simulation.machines ?? 0} generated profiles · tick ${data?.connections.simulation.tick ?? 0}`} endpoint="Control from the Fleet view · not an IoT connection" /></div>
        <section className="panel settings-panel"><div className="panel-heading"><div><p className="eyebrow">ENGINEERING ASSUMPTIONS</p><h2>Alert limits & downtime scenario</h2><p className="panel-subtitle">Set site-reviewed alert bounds and planning assumptions. Defaults are examples, not universal safety thresholds or plant cost data.</p></div><Settings2 size={18} /></div>
          <form onSubmit={saveLimits} className="limits-form"><LimitInput label="Process temperature" unit="°C" value={limits.process_temperature} onChange={value => setLimits({ ...limits, process_temperature: value })} /><LimitInput label="Torque" unit="Nm" value={limits.torque} onChange={value => setLimits({ ...limits, torque: value })} /><LimitInput label="RPM lower bound" unit="rpm" value={limits.rotational_speed_low} onChange={value => setLimits({ ...limits, rotational_speed_low: value })} /><LimitInput label="RPM upper bound" unit="rpm" value={limits.rotational_speed_high} onChange={value => setLimits({ ...limits, rotational_speed_high: value })} /><LimitInput label="Tool wear" unit="index" value={limits.tool_wear} onChange={value => setLimits({ ...limits, tool_wear: value })} /><LimitInput label="Downtime cost" unit="$/hour" value={limits.downtime_cost_per_hour} onChange={value => setLimits({ ...limits, downtime_cost_per_hour: value })} /><LimitInput label="Repair duration" unit="hours" value={limits.estimated_repair_hours} onChange={value => setLimits({ ...limits, estimated_repair_hours: value })} /><div className="limit-save"><button className="button-primary" disabled={limits.rotational_speed_high <= limits.rotational_speed_low}><Check size={15} /> Save assumptions</button>{settingsMessage && <span className={settingsMessage.includes('Could not') || settingsMessage.includes('must') ? 'form-error' : 'save-message'}>{settingsMessage}</span>}</div></form>
        </section>
        <section className="panel standards-note"><div><p className="eyebrow">REFERENCE SCOPE</p><h2>Standards guide the process; equipment documents set the limits.</h2><p>ISO 17359:2018 provides general condition-monitoring programme guidance. ISO 20816-1:2016 concerns machine vibration measurement and evaluation, not temperature or torque limits. Neither supplies universal alarm values for these sensor fields.</p></div><div className="standards-links"><a href="https://www.iso.org/standard/71194.html" target="_blank" rel="noreferrer">ISO 17359:2018 <ArrowRight size={13} /></a><a href="https://www.iso.org/standard/63180.html" target="_blank" rel="noreferrer">ISO 20816-1:2016 <ArrowRight size={13} /></a></div><p className="standards-caveat">Use each machine manufacturer’s limits where published; otherwise have a qualified site engineer approve a profile and record the reference below. Inherited shared fallbacks remain explicitly unverified assumptions.</p></section>
        <section className="panel machine-limits-panel"><div className="panel-heading"><div><p className="eyebrow">EQUIPMENT-SPECIFIC CONFIGURATION</p><h2>Threshold profiles by machine</h2><p className="panel-subtitle">Overrides apply only to the selected asset. Every custom profile requires a source and reference.</p></div><Settings2 size={18} /></div><div className="machine-limit-list">{machines.map(machine => <MachineLimitEditor key={machine.machine_id} machine={machine} shared={limits} onSaved={() => void refresh()} />)}</div></section>
        <ConnectionInstructions />
      </section> : view === 'Events' ? <EventsView events={data?.events ?? []} machines={machines} refresh={refresh} /> : selectedMachine ? <MachineDetail machine={selectedMachine} onBack={() => { setSelectedId(''); const url = new URL(window.location.href); url.searchParams.delete('asset'); window.history.replaceState({}, '', url) }} onReport={() => { setChatOpen(false); setModal('report') }} onChat={() => setChatOpen(true)} onQR={() => { setChatOpen(false); setModal('qr') }} onLogAction={() => setModal('action')} onRemove={() => setModal('remove')} /> : <>
        <section className="overview-heading"><div><p className="eyebrow">OPERATIONS / FLEET OVERVIEW</p><h1>Machine health, at a glance.</h1><p>Incoming measurements, equipment risk, and maintenance response in one place.</p></div><div className="overview-controls">{data?.connections.simulation.enabled ? <button className="button-secondary" onClick={() => void controlSimulation('pause')}><RefreshCw size={15} /> Pause demo</button> : <button className="button-primary" onClick={() => void controlSimulation('start')}><Zap size={15} /> Start demo</button>}<IconButton label="Reset five demo profiles" onClick={() => void controlSimulation('reset')}><RefreshCw size={16} /></IconButton><button className="button-secondary" onClick={() => setModal('qr')}><QrCode size={15} /> QR labels</button><button className="button-primary" onClick={() => setModal('register')}><Plus size={16} /> Register machine</button></div></section>
        <section className="metric-row" aria-label="Fleet summary"><FleetMetric label="Monitored assets" value={data?.metrics.total ?? '—'} detail={`${data?.metrics.simulation_assets ?? 0} in demo feed`} icon={<HardDrive size={17} />} /><FleetMetric label="Critical" value={data?.metrics.critical ?? '—'} detail="Immediate review" icon={<AlertCircle size={17} />} emphasis={(data?.metrics.critical ?? 0) > 0} onClick={() => setRiskFilter('Critical')} /><FleetMetric label="Attention" value={data?.metrics.attention ?? '—'} detail="Threshold exceeded" icon={<AlertTriangle size={17} />} onClick={() => setRiskFilter('Attention')} /><FleetMetric label="Within limits" value={data?.metrics.normal ?? '—'} detail="Latest reading in range" icon={<ShieldCheck size={17} />} /><FleetMetric label="Real devices" value={data?.metrics.real_connected ?? '—'} detail="REST / MQTT source" icon={<Radio size={17} />} onClick={() => setView('Connections')} /><FleetMetric label="Open events" value={data?.metrics.open_events ?? '—'} detail={`${data?.metrics.actions_due ?? 0} follow-ups due`} icon={<Wrench size={17} />} onClick={() => setView('Events')} /></section>
        {machines.length === 0 ? <EmptyFleet onRegister={() => setModal('register')} onConnections={() => setModal('connections')} /> : <>
          <section className="fleet-section"><div className="fleet-heading"><div><p className="eyebrow">REGISTERED EQUIPMENT</p><h2>Fleet register <span className="asset-total">{machines.length}</span></h2></div><div className="fleet-filters"><label className="search-box"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find machine" aria-label="Search machines" />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={13} /></button>}</label><label className="select-wrap"><span className="sr-only">Filter by risk</span><select value={riskFilter} onChange={event => setRiskFilter(event.target.value)}>{riskLabels.map(label => <option key={label}>{label}</option>)}</select><ChevronDown size={14} /></label></div></div>
            {riskFilter === 'Critical' && <div className="critical-filter-note"><AlertCircle size={15} /><span>Critical assets</span><strong>{filteredMachines.length}</strong><span>Latest readings exceed configured thresholds or multiple conditions are active.</span><button onClick={() => setRiskFilter('All risks')}>Clear filter</button></div>}
            <FleetTable machines={filteredMachines} selected={selectedId} select={id => setSelectedId(id)} />
          </section>
          <section className="lower-grid"><section className="panel recent-panel"><div className="panel-heading"><div><p className="eyebrow">LATEST SIGNALS</p><h2>Recent events</h2></div><button className="text-link" onClick={() => setView('Events')}>View event log <ArrowRight size={14} /></button></div>{(data?.events ?? []).slice(0, 4).length === 0 ? <p className="panel-empty">No machine events received.</p> : <div className="recent-events">{data?.events.slice(0, 4).map(event => <button key={event.id} className="recent-event" onClick={() => setSelectedId(event.machine_id)}><span className={`event-mini ${event.severity.toLowerCase()}`}><AlertTriangle size={14} /></span><span><strong>{event.machine_id}</strong><span>{event.condition}</span></span><time>{relativeTime(event.timestamp)}</time></button>)}</div>}</section>
            <section className="panel links-panel"><div className="panel-heading"><div><p className="eyebrow">FIELD WORKFLOW</p><h2>Equipment access</h2></div><QrCode size={18} /></div><p>Print machine labels that open the matching dashboard record. Pair sensors separately through the secured gateway.</p><button className="button-secondary" onClick={() => setModal('qr')}><QrCode size={15} /> Create QR labels</button><button className="button-secondary" onClick={() => setModal('connections')}><Link2 size={15} /> View connection guide</button></section></section>
        </>}
      </>}
      <footer className="page-footer"><span><ShieldCheck size={14} /> Sensor readings remain on this local installation.</span><span>MAINTAIN-X <i /> API {data ? 'reachable' : 'checking'}</span></footer>
    </main>
    {chatOpen && <ChatPanel machine={selectedMachine} close={() => setChatOpen(false)} />}
    {modal === 'register' && <AddMachineModal close={() => setModal(null)} onCreated={() => void refresh()} shared={limits} />}
    {modal === 'qr' && <QRModal machines={machines} close={() => setModal(null)} />}
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

function ConnectionInstructions() {
  return <section className="panel connection-instructions"><div><p className="eyebrow">GATEWAY QUICK START</p><h2>Send the first device reading</h2><p>Replace the sample fields with calibrated readings from your sensor driver. Configure the bearer token on a trusted gateway; do not expose the API directly to the public internet.</p></div><div className="terminal-card"><div><i /><i /><i /><span>PAYLOAD TEMPLATE · EXAMPLE VALUES</span></div><code>{'{ "machine_id": "PRESS-01",'}<br />{'  "process_temperature": YOUR_SENSOR_VALUE,'}<br />{'  "rotational_speed": YOUR_SENSOR_VALUE,'}<br />{'  "torque": YOUR_SENSOR_VALUE }'}</code></div></section>
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