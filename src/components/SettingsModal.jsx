import { useState, useEffect, useRef } from 'react'
import { useSettings } from '../context/SettingsContext.shared'
import { API_BASE } from '../config'
import ServerSettingsTab from './ServerSettingsTab'
import './SettingsModal.css'

const CUSTOM_API_TYPE_OPTIONS = [
  { value: 'image-generation', label: 'Image Generation' },
  { value: 'image-edit', label: 'Image Edit' },
  { value: 'mesh-generation', label: 'Mesh Generation' },
  { value: 'mesh-edit', label: 'Mesh Edit' },
  { value: 'mesh-texturing', label: 'Mesh Texturing' },
  { value: 'mesh-rigging', label: 'Mesh Rigging' }
]

function getCustomApiTypeLabel(type) {
  return CUSTOM_API_TYPE_OPTIONS.find(option => option.value === type)?.label || 'Image Generation'
}

async function fetchCreateOptions() {
  const res = await fetch(`${API_BASE}/create/options`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `Failed to load Create options (HTTP ${res.status})`)
  return data
}

function CreateEngineOptions({ engines = [] }) {
  const grouped = new Map()
  for (const engine of engines) {
    const group = engine.group || 'Available engines'
    grouped.set(group, [...(grouped.get(group) || []), engine])
  }
  return [...grouped.entries()].map(([group, items]) => (
    <optgroup key={group} label={group}>
      {items.map(engine => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
    </optgroup>
  ))
}

const MANAGED_FIELD_HINT = 'Set automatically for the ComfyUI that 3D Gen Studio manages. Switch to your own ComfyUI to edit it.'

// Desktop-only: the managed ComfyUI owns apis.comfyui.path/modelsPath/port, and the
// installer only writes them when it actually installs. If those settings later
// drift to an external instance there is no way back — the installer short-circuits
// because the install already exists — so offer an explicit re-point action, plus
// the reverse (hand control back to a user-supplied ComfyUI).
function ManagedComfyControls({ managed, onChanged }) {
  const bridge = typeof window !== 'undefined' ? window.genStudioServices : null
  const isDesktop = !!bridge?.isDesktop
  const [installed, setInstalled] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isDesktop) return undefined
    let alive = true
    bridge.status().then(s => { if (alive) setInstalled(!!s?.comfyui?.installed) }).catch(() => {})
    return () => { alive = false }
  }, [isDesktop, bridge])

  if (!isDesktop || !installed || managed) return null

  const handleUseManaged = async () => {
    setError(''); setBusy(true)
    try {
      const res = await bridge.useManagedComfy()
      if (res?.ok) await onChanged()
      else setError(res?.error || 'Could not switch to the managed ComfyUI.')
    } catch (e) {
      setError(e?.message || 'Could not switch to the managed ComfyUI.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: '8px' }}>
      <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#e0a030' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>warning</span>
        A managed ComfyUI is installed, but these settings point at a different one — so
        3D Gen Studio can&apos;t start or stop it, and &quot;start automatically&quot; is ignored.
      </p>
      <button
        type="button"
        onClick={handleUseManaged}
        disabled={busy}
        style={{
          fontFamily: 'inherit', fontSize: '13px', fontWeight: 600,
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          border: 'none', borderRadius: '8px', padding: '9px 16px', color: '#0b0e14',
          background: 'linear-gradient(90deg, #7c5cff, #22d3ee)',
        }}
      >
        {busy ? 'Switching…' : 'Use the managed ComfyUI'}
      </button>
      {error && <p className="settings-helper-text" style={{ color: '#f87171' }}>{error}</p>}
    </div>
  )
}

// Turn an update plan from the main process into the short list of lines a user
// can actually act on. Deliberately concrete about names and counts: "an update is
// available" tells nobody whether it's a 50 MB node pack or a 3 GB PyTorch swap.
function describeComfyPlan(plan) {
  const short = ref => (ref ? ref.slice(0, 8) : 'unknown')
  const names = list => list.map(n => n.name).join(', ')
  const out = []
  if (plan.core.changed) {
    out.push(`ComfyUI ${plan.core.fromTag || short(plan.core.fromRef)} → ${plan.core.toTag || short(plan.core.toRef)}`)
  }
  if (plan.nodes.update.length) out.push(`${plan.nodes.update.length} custom node pack(s) to update: ${names(plan.nodes.update)}`)
  if (plan.nodes.add.length) out.push(`${plan.nodes.add.length} to install: ${names(plan.nodes.add)}`)
  if (plan.nodes.remove.length) out.push(`${plan.nodes.remove.length} to remove: ${names(plan.nodes.remove)}`)
  if (plan.torch.changed) out.push(`PyTorch ${plan.torch.from || 'missing'} → ${plan.torch.to}`)
  if (plan.deps.changed) out.push('Python packages, from this version’s dependency lock')
  if (plan.orphans.length) out.push(`${plan.orphans.length} package(s) to uninstall (no longer needed): ${plan.orphans.slice(0, 6).map(o => o.name).join(', ')}${plan.orphans.length > 6 ? ', …' : ''}`)
  // Installs made before update tracking existed have no record of their refs, so
  // this first update refreshes everything. Say so — otherwise the list above looks
  // alarming for what is really a one-off.
  if (plan.unknownState) out.push('This install predates update tracking, so ComfyUI and every node pack are refreshed once')
  return out
}

// Desktop-only: bring an EXISTING managed ComfyUI up to what this app version
// ships. Updating the app does not do this on its own — the installer
// short-circuits once the install exists, and the node packs are pinned tarballs
// with no git checkout to pull — so a user who upgrades keeps running the ComfyUI,
// node pack refs and Python packages of whichever version installed it.
//
// The check is cheap (no network) and runs when the panel opens, so an install
// that is already current says so instead of offering a pointless button.
function ComfyUpdatePanel() {
  const bridge = typeof window !== 'undefined' ? window.genStudioServices : null
  const setupBridge = typeof window !== 'undefined' ? window.genStudioSetup : null
  const isDesktop = !!bridge?.isDesktop && !!bridge?.checkComfyUpdate && !!setupBridge
  const [installed, setInstalled] = useState(null)
  const [plan, setPlan] = useState(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState('') // '' | 'update' | 'reinstall'
  const [phase, setPhase] = useState('')
  const [pct, setPct] = useState(0)
  const [finished, setFinished] = useState(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!isDesktop) return undefined
    let alive = true
    const load = async () => {
      try {
        const st = await setupBridge.status()
        if (!alive) return
        setInstalled(!!st?.comfyui)
        if (!st?.comfyui) return
        setChecking(true)
        const res = await bridge.checkComfyUpdate()
        if (!alive) return
        if (res?.ok) setPlan(res.plan)
        else setError(res?.error || 'Could not check for ComfyUI updates.')
      } catch (e) {
        if (alive) setError(e?.message || 'Could not check for ComfyUI updates.')
      } finally {
        if (alive) setChecking(false)
      }
    }
    load()
    return () => { alive = false }
  }, [isDesktop, bridge, setupBridge])

  // Update/reinstall progress rides the same channel as the first-run installer,
  // tagged so the two cards can't cross-report.
  useEffect(() => {
    if (!isDesktop) return undefined
    let alive = true
    const off = setupBridge.onProgress(evt => {
      if (!alive || evt?.service !== 'comfyui-update') return
      if (evt.kind === 'phase') { setPhase(evt.phase || ''); if (typeof evt.pct === 'number') setPct(evt.pct) }
      else if (evt.kind === 'error') setError(evt.text || 'The update failed.')
    })
    return () => { alive = false; if (typeof off === 'function') off() }
  }, [isDesktop, setupBridge])

  const recheck = async () => {
    setError(''); setChecking(true)
    try {
      const res = await bridge.checkComfyUpdate()
      if (res?.ok) setPlan(res.plan)
      else setError(res?.error || 'Could not check for ComfyUI updates.')
    } catch (e) {
      setError(e?.message || 'Could not check for ComfyUI updates.')
    } finally {
      setChecking(false)
    }
  }

  const runJob = async kind => {
    setError(''); setFinished(null); setConfirming(false)
    setJob(kind); setPhase('Starting…'); setPct(0)
    try {
      const res = kind === 'update' ? await bridge.updateComfyUI() : await bridge.reinstallComfyUI()
      if (res?.ok) {
        setFinished({ kind, summary: res.summary, changed: res.changed !== false, wasRunning: !!res.wasRunning })
        await recheck()
      } else {
        setError(res?.error || 'The update failed. See the desktop log for details.')
      }
    } catch (e) {
      setError(e?.message || 'The update failed.')
    } finally {
      setJob('')
    }
  }

  if (!isDesktop || !installed) return null

  const busy = !!job
  const reinstallNeeded = plan?.requiresReinstall || null
  const primaryBtn = {
    fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
    border: 'none', borderRadius: '8px', padding: '9px 16px', color: '#0b0e14',
    background: 'linear-gradient(90deg, #7c5cff, #22d3ee)',
  }
  const ghostBtn = {
    fontFamily: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
    borderRadius: '8px', padding: '6px 14px', border: '1px solid rgba(255,255,255,0.12)',
    background: '#1b2130', color: '#e8eaf0',
  }

  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      {busy && (
        <>
          <p className="settings-helper-text" style={{ margin: 0 }}>
            {job === 'reinstall' ? 'Reinstalling ComfyUI' : 'Updating ComfyUI'}… {Math.round(pct * 100)}%
          </p>
          <div style={{ height: '6px', borderRadius: '4px', background: 'rgba(255,255,255,0.08)', marginTop: '8px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(pct * 100)}%`, background: 'linear-gradient(90deg, #7c5cff, #22d3ee)', transition: 'width .3s' }} />
          </div>
          <p className="settings-helper-text" style={{ marginTop: '4px' }}>{phase}</p>
        </>
      )}

      {!busy && reinstallNeeded && (
        <>
          <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em', color: '#e0a030' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>warning</span>
            {reinstallNeeded.reason}
          </p>
          {confirming ? (
            <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center' }}>
              <button type="button" style={primaryBtn} onClick={() => runJob('reinstall')}>Reinstall now</button>
              <button type="button" style={ghostBtn} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" style={primaryBtn} onClick={() => setConfirming(true)}>Reinstall ComfyUI…</button>
          )}
          <p className="settings-helper-text">
            Downloads ComfyUI, the custom nodes and PyTorch again (several GB). Your models,
            inputs and outputs are kept.
          </p>
        </>
      )}

      {!busy && !reinstallNeeded && plan?.hasUpdates && (
        <>
          <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#22d3ee', margin: 0 }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>system_update_alt</span>
            This app version ships a newer ComfyUI setup than the one installed:
          </p>
          <ul className="settings-helper-text" style={{ margin: '6px 0 8px', paddingLeft: '1.4em' }}>
            {describeComfyPlan(plan).map(line => <li key={line}>{line}</li>)}
          </ul>
          <button type="button" style={primaryBtn} onClick={() => runJob('update')}>Update ComfyUI</button>
          <p className="settings-helper-text">
            ComfyUI is stopped while it updates, and only what changed is downloaded. Your
            models, inputs and outputs are untouched.
          </p>
        </>
      )}

      {!busy && !reinstallNeeded && plan && !plan.hasUpdates && (
        <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', margin: 0 }}>
          <span className="material-symbols-outlined" style={{ fontSize: '1.1em', color: '#4caf50' }}>check_circle</span>
          ComfyUI, its custom nodes and its Python packages match this app version.
          <button
            type="button"
            onClick={recheck}
            disabled={checking}
            style={{ ...ghostBtn, marginLeft: 'auto', cursor: checking ? 'default' : 'pointer', opacity: checking ? 0.6 : 1 }}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </p>
      )}

      {!busy && !plan && checking && (
        <p className="settings-helper-text" style={{ margin: 0 }}>Checking the installed custom nodes and packages…</p>
      )}

      {!busy && finished && (
        <p className="settings-helper-text" style={{ color: '#4caf50' }}>
          {finished.kind === 'reinstall'
            ? 'ComfyUI was reinstalled.'
            : finished.changed ? `Updated: ${finished.summary}.` : 'Already up to date.'}
          {finished.wasRunning ? ' It was stopped for the update — start it again below.' : ''}
        </p>
      )}

      {!busy && plan?.nodes?.unmanaged?.length > 0 && (
        <p className="settings-helper-text">
          Left untouched because 3D Gen Studio didn&apos;t install them:{' '}
          {plan.nodes.unmanaged.map(n => n.name).join(', ')}. Node packs you add yourself are
          never removed, but they can break the locked environment.
        </p>
      )}

      {error && <p className="settings-helper-text" style={{ color: '#f87171' }}>{error}</p>}
    </div>
  )
}

// One poller shared by every ServiceControl on screen. The Mesh Tools tab shows
// four of them, and a per-component interval meant four IPC round trips — each
// sweeping the filesystem for every service in the main process — every 3s for
// one identical answer. It also stops while the window is hidden: a settings
// dialog left open in a background window has nothing to reflect.
const serviceStatusSubs = new Set()
let serviceStatusTimer = null
let serviceStatusLast = null

function pollServiceStatus() {
  const bridge = typeof window !== 'undefined' ? window.genStudioServices : null
  if (!bridge) return
  if (typeof document !== 'undefined' && document.hidden) return
  bridge.status()
    .then(s => { serviceStatusLast = s; serviceStatusSubs.forEach(fn => fn(s)) })
    .catch(() => { /* ignore */ })
}

function subscribeServiceStatus(fn) {
  serviceStatusSubs.add(fn)
  if (serviceStatusLast) fn(serviceStatusLast)
  if (!serviceStatusTimer) {
    pollServiceStatus()
    serviceStatusTimer = setInterval(pollServiceStatus, 3000) // reflect starting → running transitions
  }
  return () => {
    serviceStatusSubs.delete(fn)
    if (!serviceStatusSubs.size && serviceStatusTimer) {
      clearInterval(serviceStatusTimer)
      serviceStatusTimer = null
    }
  }
}

// Nothing below the status dot changes between most ticks, so re-rendering four
// cards every 3s only bought needless layout work inside the modal's scroller.
function sameServiceStatus(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.label === b.label && a.installed === b.installed && a.running === b.running
    && a.starting === b.starting && a.external === b.external
}

// Desktop-only: start/stop a Python service on demand and show its status. The
// services aren't started at app launch — they spin up when a tool needs them,
// and can be stopped here (stopping Rigging frees its GPU memory). Renders
// nothing outside the desktop app.
function ServiceControl({ name }) {
  const bridge = typeof window !== 'undefined' ? window.genStudioServices : null
  const isDesktop = !!bridge?.isDesktop
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('') // '' | 'start' | 'stop'
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isDesktop) return undefined
    return subscribeServiceStatus(s => {
      const next = s?.[name] || null
      setSt(prev => (sameServiceStatus(prev, next) ? prev : next))
    })
  }, [isDesktop, name])

  if (!isDesktop || !st) return null
  if (!st.installed) return null // not installed yet (the installer card above handles that)

  const stopping = busy === 'stop'
  const starting = !stopping && (st.starting || busy === 'start')
  const running = st.running && !starting && !stopping
  // Answering on its port, but started outside the app — the port was already in
  // use by a working instance, so the shell adopted it rather than starting a
  // second one. There is no child process to kill, so Stop would be a lie.
  const external = running && st.external

  const applyResult = (r) => {
    if (r?.status?.[name]) setSt(r.status[name])
    if (r && r.ok === false) setError(r.error || 'Operation failed.')
  }
  const doStart = async () => {
    setError(''); setBusy('start')
    try { applyResult(await bridge.start(name)) }
    catch (e) { setError(e?.message || 'Failed to start.') }
    finally { setBusy('') }
  }
  const doStop = async () => {
    setError(''); setBusy('stop')
    try { applyResult(await bridge.stop(name)) }
    catch (e) { setError(e?.message || 'Failed to stop.') }
    finally { setBusy('') }
  }

  const dotColor = running ? '#4caf50' : (starting || stopping) ? '#e0a030' : '#6b7280'
  const btn = {
    fontFamily: 'inherit', fontSize: '12px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
    borderRadius: '8px', padding: '6px 14px', border: '1px solid rgba(255,255,255,0.12)',
    background: '#1b2130', color: '#e8eaf0', opacity: busy ? 0.6 : 1,
  }

  return (
    <div style={{ marginTop: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6em' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: dotColor, boxShadow: running ? '0 0 6px #4caf50' : 'none', flex: 'none' }} />
        <span className="settings-helper-text" style={{ margin: 0 }}>
          {stopping ? 'Stopping…' : starting ? 'Starting…'
            : external ? 'Running (started outside 3D Gen Studio)'
            : running ? 'Running' : 'Stopped'}
        </span>
        <div style={{ flex: 1 }} />
        {running ? (
          <button type="button" style={btn} onClick={doStop} disabled={!!busy || external} title={external ? 'This service was not started by 3D Gen Studio, so it cannot be stopped from here.' : undefined}>Stop</button>
        ) : (
          <button type="button" style={btn} onClick={doStart} disabled={!!busy}>{starting ? 'Starting…' : 'Start'}</button>
        )}
      </div>
      {error && <p className="settings-helper-text" style={{ color: '#f87171' }}>{error}</p>}
    </div>
  )
}

// Desktop-only: opt a service into starting automatically when the app launches
// (the main process reads this setting on boot). Renders nothing outside the
// desktop app, where services are launched externally.
function AutoStartToggle({ checked, onChange, warning }) {
  const isDesktop = typeof window !== 'undefined' && !!window.genStudioServices?.isDesktop
  if (!isDesktop) return null
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', marginTop: '10px', cursor: 'pointer' }}>
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
      <span className="settings-helper-text" style={{ margin: 0 }}>
        Start automatically when the app launches
        {warning ? ' (keeps ~14 GB of GPU memory in use the whole session)' : ''}
      </span>
    </label>
  )
}

// Desktop-only: install one of the opt-in services after first run — for users
// who upgraded, skipped it on the setup screen, or later added a GPU. Drives the
// same uv provisioning as the first-run window via the genStudioSetup bridge and
// shows live progress. Renders nothing outside the desktop app.
//
// Meta Llama 3 licence gate for the motion service. Kimodo's text encoder is LLM2Vec
// over Meta Llama 3, so installing it downloads Meta Llama 3 weights — which Meta
// licenses under an agreement the user has to accept.
//
// This is the SECOND place the motion service can be installed from (the first-run
// setup window is the other), and the main process refuses the install until the
// acceptance is recorded — so the gate has to exist here too, not just there.
function LlamaLicenseGate({ onChange }) {
  const bridge = typeof window !== 'undefined' ? window.genStudioSetup : null
  const isDesktop = typeof window !== 'undefined' && window.genStudioDesktop?.isDesktop && bridge
  const [state, setState] = useState(null)      // { accepted, text }
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isDesktop) return undefined
    let alive = true
    bridge.llamaLicense()
      .then(res => { if (alive) { setState(res || null); onChange?.(!!res?.accepted) } })
      .catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, bridge])

  if (!isDesktop || !state) return null

  const accept = async () => {
    setError('')
    try {
      const res = await bridge.acceptLlamaLicense()
      if (!res?.accepted) throw new Error('The acceptance could not be saved.')
      setState(prev => ({ ...prev, accepted: true }))
      onChange?.(true)
      setOpen(false)
    } catch (e) {
      setError(e?.message || 'The acceptance could not be saved.')
    }
  }

  return (
    <div className="settings-license">
      <p className="settings-helper-text">
        <b>Built with Meta Llama 3.</b> Kimodo encodes your prompt with LLM2Vec, which is built on
        Meta Llama 3, so installing motion generation downloads Meta Llama 3-8B-Instruct
        (~16 GB) from Hugging Face. Meta licenses those weights under the Meta Llama 3
        Community License.
      </p>
      <div className="settings-license__row">
        {state.accepted ? (
          <span className="settings-license__ok">
            <span className="material-symbols-outlined">check_circle</span>
            Meta Llama 3 Community License accepted
          </span>
        ) : (
          <label className="settings-license__accept">
            <input type="checkbox" checked={false} onChange={() => setOpen(true)} />
            I accept the Meta Llama 3 Community License
          </label>
        )}
        <button type="button" className="settings-license__link" onClick={() => setOpen(o => !o)}>
          {open ? 'Hide the licence' : 'Read the licence'}
        </button>
      </div>
      {open && (
        <>
          <pre className="settings-license__text">
            {state.text || 'The licence file could not be read. The full text is at https://llama.meta.com/llama3/license'}
          </pre>
          {!state.accepted && (
            <button type="button" className="settings-btn-primary" onClick={accept}>
              I Accept
            </button>
          )}
        </>
      )}
      {error && <p className="settings-helper-text" style={{ color: 'var(--error)' }}>{error}</p>}
    </div>
  )
}

// `service` is the key both setup:run and setup:status use ('rigging' | 'motion'
// | 'comfyui').
// `availableKey` (optional) names a setup:status flag that must be true for the
// install to be possible at all on this platform — when it's false we say so
// instead of offering a button that is guaranteed to fail.
// `onInstalled` lets the parent re-read the settings the main process wrote during
// the install (the managed ComfyUI sets path/modelsPath/port/managed), so the open
// form doesn't keep — and later save — its pre-install copy.
// `blockedReason` (optional) disables the button and says why — used for the motion
// service, whose install the main process refuses until the Meta Llama 3 licence has
// been accepted (see LlamaLicenseGate below).
function ServiceInstaller({ service, buttonLabel, readyText, note, availableKey, unavailableText, onInstalled, blockedReason }) {
  const bridge = typeof window !== 'undefined' ? window.genStudioSetup : null
  const isDesktop = typeof window !== 'undefined' && window.genStudioDesktop?.isDesktop && bridge
  const [status, setStatus] = useState(null)
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState('')
  const [pct, setPct] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isDesktop) return undefined
    let alive = true
    bridge.status().then(s => { if (alive) setStatus(s) }).catch(() => {})
    const off = bridge.onProgress(evt => {
      if (!alive) return
      // Progress events carry a `service` tag; ignore another service's install
      // so two installer cards on screen don't cross-report each other.
      if (evt.service && evt.service !== service) return
      if (evt.kind === 'phase') { setPhase(evt.phase || ''); if (typeof evt.pct === 'number') setPct(evt.pct) }
      else if (evt.kind === 'error') setError(evt.text || 'Setup failed.')
    })
    return () => { alive = false; if (typeof off === 'function') off() }
  }, [isDesktop, bridge, service])

  if (!isDesktop) return null

  const handleInstall = async () => {
    if (blockedReason) { setError(blockedReason); return }
    setError(''); setRunning(true); setPhase('Starting…'); setPct(0)
    try {
      const res = await bridge.run({ [service]: true })
      if (res?.ok) {
        setStatus(await bridge.status())
        if (typeof onInstalled === 'function') await onInstalled()
      } else setError(res?.error || 'Installation failed. See details in the setup logs.')
    } catch (e) {
      setError(e?.message || 'Installation failed.')
    } finally {
      setRunning(false)
    }
  }

  if (status?.[service]) {
    return (
      <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#4caf50' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>check_circle</span>
        {readyText}
      </p>
    )
  }

  // Wait for status before deciding: rendering the button and then swapping it for
  // "unavailable" reads as a bug.
  if (availableKey && !status) return null
  if (availableKey && !status[availableKey]) {
    return (
      <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>info</span>
        {unavailableText}
      </p>
    )
  }

  return (
    <div style={{ marginTop: '8px' }}>
      <button
        type="button"
        onClick={handleInstall}
        title={blockedReason || undefined}
        disabled={running || !!blockedReason}
        style={{
          fontFamily: 'inherit', fontSize: '13px', fontWeight: 600,
          cursor: running ? 'default' : 'pointer', opacity: running ? 0.6 : 1,
          border: 'none', borderRadius: '8px', padding: '9px 16px', color: '#0b0e14',
          background: 'linear-gradient(90deg, #7c5cff, #22d3ee)',
        }}
      >
        {running ? `Installing… ${Math.round(pct * 100)}%` : buttonLabel}
      </button>
      {running && (
        <>
          <div style={{ height: '6px', borderRadius: '4px', background: 'rgba(255,255,255,0.08)', marginTop: '8px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(pct * 100)}%`, background: 'linear-gradient(90deg, #7c5cff, #22d3ee)', transition: 'width .3s' }} />
          </div>
          <p className="settings-helper-text" style={{ marginTop: '4px' }}>{phase}</p>
        </>
      )}
      {error && <p className="settings-helper-text" style={{ color: '#f87171' }}>{error}</p>}
      <p className="settings-helper-text">{note}</p>
    </div>
  )
}

// Desktop-only-friendly folder browse button: calls the backend's native folder
// picker (Windows) and reports the chosen path back to the caller.
function BrowseFolderButton({ description, initialPath, onPick }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleClick = async () => {
    setError(''); setBusy(true)
    try {
      const res = await fetch(`${API_BASE}/setup/pick-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, initialPath })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Folder picker failed')
      if (data.path) onPick(data.path)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="kanban-sidebar__new-asset"
        style={{ margin: 0, padding: '0.5rem 0.9rem', whiteSpace: 'nowrap' }}
        onClick={handleClick}
        disabled={busy}
        title={description}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '16px', verticalAlign: 'middle' }}>folder_open</span>
        {busy ? '…' : 'Browse'}
      </button>
      {error && <p className="settings-helper-text" style={{ color: '#f87171' }}>{error}</p>}
    </>
  )
}

export default function SettingsModal({ onClose }) {
  const { settings, updateSettings, addCustomApi, refreshSettings } = useSettings()
  const [localSettings, setLocalSettings] = useState(settings)
  const [activeTab, setActiveTab] = useState('apis')
  // Whether the Meta Llama 3 licence has been accepted — the motion installer is
  // blocked until it is (the main process enforces the same rule).
  const [llamaAccepted, setLlamaAccepted] = useState(false)
  const [showAddCustom, setShowAddCustom] = useState(false)
  const [newCustom, setNewCustom] = useState({ name: '', url: '', headers: '', body: '', type: 'image-generation' })
  const [createOptions, setCreateOptions] = useState(null)
  const [createOptionsLoading, setCreateOptionsLoading] = useState(false)
  const [createOptionsError, setCreateOptionsError] = useState('')
  const createOptionsRequested = useRef(false)

  // Ensure local state is updated if context settings load/change
  useEffect(() => {
    setLocalSettings(settings)
  }, [settings])

  // Create options can be expensive (workflow discovery plus service probes), so
  // load them once and only when this tab is opened.
  useEffect(() => {
    if (activeTab !== 'create' || createOptionsRequested.current) return
    createOptionsRequested.current = true
    setCreateOptionsLoading(true)
    fetchCreateOptions()
      .then(data => {
        setCreateOptions(data)
        setCreateOptionsError('')
      })
      .catch(err => setCreateOptionsError(err?.message || 'Could not load Create options'))
      .finally(() => setCreateOptionsLoading(false))
  }, [activeTab])

  const updateCreate = (updates) => {
    setLocalSettings(prev => ({
      ...prev,
      create: { ...(prev?.create || {}), ...updates }
    }))
  }

  const updateCreateDefault = (key, value) => {
    setLocalSettings(prev => ({
      ...prev,
      create: {
        ...(prev?.create || {}),
        defaults: { ...(prev?.create?.defaults || {}), [key]: value }
      }
    }))
  }

  // Server-side truth, not the form copy: the managed flag is written by the main
  // process, and gating the inputs on the local copy would let a stale form make
  // them editable again.
  const comfyManaged = !!settings?.apis?.comfyui?.managed

  const handleSave = async () => {
    // `apis.comfyui.managed` and the paths/port that go with it are owned by the
    // main process, not this form: it writes them when the managed ComfyUI is
    // installed. The modal loads its copy of the settings once, so saving a
    // form that was opened BEFORE an install would write the stale values back
    // and silently un-manage the install (which is exactly what stops
    // "start automatically" from working). The backend merges what we POST, so
    // simply omitting these keys preserves whatever the main process set.
    let payload = localSettings
    if (settings?.apis?.comfyui?.managed) {
      const { managed: _mg, path: _p, modelsPath: _m, port: _pt, ...userOwned } = localSettings?.apis?.comfyui || {}
      payload = { ...localSettings, apis: { ...localSettings.apis, comfyui: userOwned } }
    }
    await updateSettings(payload)
    onClose()
  }

  const handleAddCustom = async () => {
    if (!newCustom.name || !newCustom.url) return
    const updatedSettings = await addCustomApi(newCustom)
    setLocalSettings(updatedSettings)
    setNewCustom({ name: '', url: '', headers: '', body: '', type: 'image-generation' })
    setShowAddCustom(false)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      {/* The dimming blur is a SIBLING of the modal, not its parent: as an ancestor
          its backdrop-filter had to be recomputed over the whole viewport on every
          repaint of the dialog, which made scrolling a long tab crawl in the
          desktop app's Chromium. Nothing paints inside it, so it now stays cached. */}
      <div className="settings-overlay__scrim" aria-hidden="true" />
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <div className="settings-title-group">
            <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>settings</span>
            <h2 className="font-headline">SYSTEM SETTINGS</h2>
          </div>
          <button className="settings-close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-tabs">
            <button
              className={`settings-tab ${activeTab === 'apis' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('apis')}
            >
              APIs
            </button>
            <button
              className={`settings-tab ${activeTab === 'comfyui' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('comfyui')}
            >
              ComfyUI
            </button>
            <button
              className={`settings-tab ${activeTab === 'meshtools' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('meshtools')}
            >
              Mesh Tools
            </button>
            <button
              className={`settings-tab ${activeTab === 'server' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('server')}
            >
              Server
            </button>
            <button
              className={`settings-tab ${activeTab === 'create' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('create')}
            >
              Create
            </button>
          </div>

          {activeTab === 'apis' && (
            <>
              <section className="settings-section">
                <h3 className="settings-section-title font-label">Integrated APIs</h3>
                <div className="settings-grid">
                  <div className="settings-api-card">
                    <div className="settings-api-header">
                      <div className="settings-api-icon">
                        <img src="https://www.google.com/favicon.ico" width="16" alt="G" />
                      </div>
                      <span className="settings-api-name">Google Cloud</span>
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">API Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="Enter Google API Key"
                        value={localSettings?.apis?.google?.apiKey || ''}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          apis: {
                            ...prev?.apis,
                            google: {
                              ...prev?.apis?.google,
                              apiKey: e.target.value
                            }
                          }
                        }))}
                      />
                    </div>
                  </div>

                  <div className="settings-api-card">
                    <div className="settings-api-header">
                      <div className="settings-api-icon">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>bolt</span>
                      </div>
                      <span className="settings-api-name">OpenAI</span>
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">API Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="sk-..."
                        value={localSettings?.apis?.openai?.apiKey || ''}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          apis: {
                            ...prev?.apis,
                            openai: {
                              ...prev?.apis?.openai,
                              apiKey: e.target.value
                            }
                          }
                        }))}
                      />
                    </div>
                  </div>

                  <div className="settings-api-card">
                    <div className="settings-api-header">
                      <div className="settings-api-icon">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>cloud</span>
                      </div>
                      <span className="settings-api-name">Tencent Cloud</span>
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">Secret Id</label>
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="Enter Tencent Cloud Secret Id"
                        value={localSettings?.apis?.tencentcloud?.secretId || ''}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          apis: {
                            ...prev?.apis,
                            tencentcloud: {
                              ...prev?.apis?.tencentcloud,
                              secretId: e.target.value
                            }
                          }
                        }))}
                      />
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">Secret Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="Enter Tencent Cloud Secret Key"
                        value={localSettings?.apis?.tencentcloud?.secretKey || ''}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          apis: {
                            ...prev?.apis,
                            tencentcloud: {
                              ...prev?.apis?.tencentcloud,
                              secretKey: e.target.value
                            }
                          }
                        }))}
                      />
                    </div>
                  </div>

                  <div className="settings-api-card">
                    <div className="settings-api-header">
                      <div className="settings-api-icon">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>deployed_code</span>
                      </div>
                      <span className="settings-api-name">Tripo AI</span>
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">API Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="tsk_..."
                        value={localSettings?.apis?.tripoai?.apiKey || ''}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          apis: {
                            ...prev?.apis,
                            tripoai: {
                              ...prev?.apis?.tripoai,
                              apiKey: e.target.value
                            }
                          }
                        }))}
                      />
                    </div>
                  </div>

                  <div className="settings-api-card">
                    <div className="settings-api-header">
                      <div className="settings-api-icon">
                        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>view_in_ar</span>
                      </div>
                      <span className="settings-api-name">Hitem3D</span>
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">Access Key</label>
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="Enter Hitem3D Access Key"
                        value={localSettings?.apis?.hitem3d?.accessKey || ''}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          apis: {
                            ...prev?.apis,
                            hitem3d: {
                              ...prev?.apis?.hitem3d,
                              accessKey: e.target.value,
                              // A changed credential invalidates any cached token.
                              accessToken: ''
                            }
                          }
                        }))}
                      />
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">Secret Key</label>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder="Enter Hitem3D Secret Key"
                        value={localSettings?.apis?.hitem3d?.secretKey || ''}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          apis: {
                            ...prev?.apis,
                            hitem3d: {
                              ...prev?.apis?.hitem3d,
                              secretKey: e.target.value,
                              accessToken: ''
                            }
                          }
                        }))}
                      />
                    </div>
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 className="settings-section-title font-label">Custom APIs</h3>
                  <button
                    className="kanban-sidebar__new-asset"
                    style={{ margin: 0, padding: '0.25rem 0.75rem' }}
                    onClick={() => setShowAddCustom(!showAddCustom)}
                  >
                    {showAddCustom ? 'CANCEL' : 'ADD CUSTOM'}
                  </button>
                </div>

                {showAddCustom && (
                  <div className="add-custom-api-form">
                    <div className="settings-grid">
                      <div className="settings-input-group">
                        <label className="settings-label">API Name</label>
                        <input
                          className="settings-input"
                          placeholder="My GPU Cloud"
                          value={newCustom.name}
                          onChange={e => setNewCustom({ ...newCustom, name: e.target.value })}
                        />
                      </div>
                      <div className="settings-input-group">
                        <label className="settings-label">Endpoint URL</label>
                        <input
                          className="settings-input"
                          placeholder="https://api..."
                          value={newCustom.url}
                          onChange={e => setNewCustom({ ...newCustom, url: e.target.value })}
                        />
                      </div>
                      <div className="settings-input-group">
                        <label className="settings-label">Type</label>
                        <select
                          className="settings-input"
                          value={newCustom.type}
                          onChange={e => setNewCustom({ ...newCustom, type: e.target.value })}
                        >
                          {CUSTOM_API_TYPE_OPTIONS.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">Headers (JSON)</label>
                      <textarea
                        className="settings-input"
                        style={{ minHeight: '60px' }}
                        placeholder='{"Authorization": "Bearer ..."}'
                        value={newCustom.headers}
                        onChange={e => setNewCustom({ ...newCustom, headers: e.target.value })}
                      />
                    </div>
                    <div className="settings-input-group">
                      <label className="settings-label">Body Template (JSON)</label>
                      <textarea
                        className="settings-input"
                        style={{ minHeight: '60px' }}
                        placeholder='{"prompt": "{{prompt}}"}'
                        value={newCustom.body}
                        onChange={e => setNewCustom({ ...newCustom, body: e.target.value })}
                      />
                    </div>
                    <button className="btn-save" onClick={handleAddCustom} style={{ alignSelf: 'flex-end' }}>
                      CONFIRM API
                    </button>
                  </div>
                )}

                <div className="custom-apis-list">
                  {(localSettings?.apis?.custom || []).map(api => (
                    <div key={api.id} className="custom-api-item">
                      <div className="custom-api-info">
                        <span style={{ fontWeight: 600 }}>{api.name}</span>
                        <span className="custom-api-url">{getCustomApiTypeLabel(api.type)}</span>
                        <span className="custom-api-url">{api.url}</span>
                      </div>
                      <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--on-surface-variant)' }}>
                        link
                      </span>
                    </div>
                  ))}
                  {(localSettings?.apis?.custom || []).length === 0 && !showAddCustom && (
                    <p style={{ textAlign: 'center', opacity: 0.5, fontSize: '0.8rem' }}>No custom endpoints configured.</p>
                  )}
                </div>
              </section>
            </>
          )}

          {activeTab === 'comfyui' && (
            <section className="settings-section">
              <h3 className="settings-section-title font-label">ComfyUI Connection</h3>
              <div className="settings-api-card">
                <div className="settings-api-header">
                  <div className="settings-api-icon">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>account_tree</span>
                  </div>
                  <span className="settings-api-name">ComfyUI</span>
                </div>

                <div className="settings-input-group">
                  <label className="settings-label">Path</label>
                  <div style={{ display: 'flex', gap: '0.5em', alignItems: 'flex-start' }}>
                    <input
                      className="settings-input"
                      style={{ flex: 1 }}
                      disabled={comfyManaged}
                      title={comfyManaged ? MANAGED_FIELD_HINT : undefined}
                      placeholder="C:\\ComfyUI"
                      value={localSettings?.apis?.comfyui?.path || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          comfyui: {
                            ...prev?.apis?.comfyui,
                            path: e.target.value
                          }
                        }
                      }))}
                    />
                    {!comfyManaged && (
                      <BrowseFolderButton
                        description="Select your ComfyUI folder"
                        initialPath={localSettings?.apis?.comfyui?.path || ''}
                        onPick={picked => setLocalSettings(prev => ({
                          ...prev,
                          apis: { ...prev?.apis, comfyui: { ...prev?.apis?.comfyui, path: picked } }
                        }))}
                      />
                    )}
                  </div>
                </div>

                <div className="settings-input-group">
                  <label className="settings-label">Models Path <span style={{ opacity: 0.6, fontWeight: 400 }}>(optional)</span></label>
                  <div style={{ display: 'flex', gap: '0.5em', alignItems: 'flex-start' }}>
                    <input
                      className="settings-input"
                      style={{ flex: 1 }}
                      disabled={comfyManaged}
                      title={comfyManaged ? MANAGED_FIELD_HINT : undefined}
                      placeholder="Defaults to {ComfyUI path}\models"
                      value={localSettings?.apis?.comfyui?.modelsPath || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          comfyui: {
                            ...prev?.apis?.comfyui,
                            modelsPath: e.target.value
                          }
                        }
                      }))}
                    />
                    {!comfyManaged && (
                      <BrowseFolderButton
                        description="Select your ComfyUI models folder"
                        initialPath={localSettings?.apis?.comfyui?.modelsPath || localSettings?.apis?.comfyui?.path || ''}
                        onPick={picked => setLocalSettings(prev => ({
                          ...prev,
                          apis: { ...prev?.apis, comfyui: { ...prev?.apis?.comfyui, modelsPath: picked } }
                        }))}
                      />
                    )}
                  </div>
                  <p className="settings-helper-text">
                    {comfyManaged
                      ? 'Managed by 3D Gen Studio. The Setup Wizard downloads models here, and this folder survives a ComfyUI reinstall.'
                      : <>Set this only if your models live somewhere other than <code>{'{ComfyUI path}'}\models</code> (e.g. shared across multiple ComfyUI installs).</>}
                  </p>
                </div>

                <div className="settings-grid settings-grid--triple">
                  <div className="settings-input-group">
                    <label className="settings-label">Url</label>
                    <input
                      className="settings-input"
                      placeholder="http://127.0.0.1"
                      value={localSettings?.apis?.comfyui?.url || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          comfyui: {
                            ...prev?.apis?.comfyui,
                            url: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label">Port</label>
                    <input
                      className="settings-input"
                      disabled={comfyManaged}
                      title={comfyManaged ? MANAGED_FIELD_HINT : undefined}
                      placeholder="8188"
                      value={localSettings?.apis?.comfyui?.port || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          comfyui: {
                            ...prev?.apis?.comfyui,
                            port: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>
                </div>

                <p className="settings-helper-text">
                  The Kanban page will use this connection to queue workflows, poll every second, and download generated images.
                </p>

                {comfyManaged && (
                  <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#22d3ee' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>verified</span>
                    This ComfyUI is managed by 3D Gen Studio, so the path, models path and port
                    above are set for you and can&apos;t be edited. It starts and stops below.
                  </p>
                )}

                <ManagedComfyControls managed={comfyManaged} onChanged={refreshSettings} />

                {/* Desktop only: install a ComfyUI the app manages itself, for users
                    who don't already run one. Skipped silently in the browser. */}
                <ServiceInstaller
                  service="comfyui"
                  onInstalled={refreshSettings}
                  availableKey="comfyuiAvailable"
                  unavailableText="Installing ComfyUI automatically isn't supported on this platform yet — install it yourself and set the path and port above."
                  buttonLabel="Install ComfyUI for me"
                  readyText="A managed ComfyUI is installed and ready."
                  note="One-time install; downloads several GB (ComfyUI, the custom nodes the bundled workflows need, and PyTorch) and needs an NVIDIA GPU. Models are downloaded separately from the Setup Wizard."
                />
                {/* Desktop only: an install made by an older app version keeps that
                    version's ComfyUI, node pack refs and packages until updated here. */}
                <ComfyUpdatePanel />
                <ServiceControl name="comfyui" />
                <AutoStartToggle
                  checked={localSettings?.apis?.comfyui?.autoStart}
                  onChange={v => setLocalSettings(prev => ({
                    ...prev,
                    apis: { ...prev?.apis, comfyui: { ...prev?.apis?.comfyui, autoStart: v } }
                  }))}
                />
              </div>
            </section>
          )}

          {activeTab === 'meshtools' && (
            <section className="settings-section">
              <h3 className="settings-section-title font-label">Mesh Tools (Python) Connection</h3>
              <div className="settings-api-card">
                <div className="settings-api-header">
                  <div className="settings-api-icon">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>deployed_code</span>
                  </div>
                  <span className="settings-api-name">Mesh Tools</span>
                </div>

                <div className="settings-grid settings-grid--triple">
                  <div className="settings-input-group">
                    <label className="settings-label">Url</label>
                    <input
                      className="settings-input"
                      placeholder="http://127.0.0.1"
                      value={localSettings?.apis?.meshtools?.url || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          meshtools: {
                            ...prev?.apis?.meshtools,
                            url: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label">Port</label>
                    <input
                      className="settings-input"
                      placeholder="8200"
                      value={localSettings?.apis?.meshtools?.port || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          meshtools: {
                            ...prev?.apis?.meshtools,
                            port: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>
                </div>

                <p className="settings-helper-text">
                  The Python mesh-processing service (Auto UV, Auto Retopo). In the desktop
                  app it starts automatically when you use those tools; you can also start or
                  stop it here. Outside the desktop app, start it from python-server/run.
                </p>
                <ServiceControl name="meshtools" />
                <AutoStartToggle
                  checked={localSettings?.apis?.meshtools?.autoStart}
                  onChange={v => setLocalSettings(prev => ({
                    ...prev,
                    apis: { ...prev?.apis, meshtools: { ...prev?.apis?.meshtools, autoStart: v } }
                  }))}
                />
              </div>

              <h3 className="settings-section-title font-label">Rigging (Python) Connection</h3>
              <div className="settings-api-card">
                <div className="settings-api-header">
                  <div className="settings-api-icon">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>accessibility_new</span>
                  </div>
                  <span className="settings-api-name">Auto Rig</span>
                </div>

                <div className="settings-grid settings-grid--triple">
                  <div className="settings-input-group">
                    <label className="settings-label">Url</label>
                    <input
                      className="settings-input"
                      placeholder="http://127.0.0.1"
                      value={localSettings?.apis?.rigtools?.url || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          rigtools: {
                            ...prev?.apis?.rigtools,
                            url: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label">Port</label>
                    <input
                      className="settings-input"
                      placeholder="8300"
                      value={localSettings?.apis?.rigtools?.port || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          rigtools: {
                            ...prev?.apis?.rigtools,
                            port: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>
                </div>

                <p className="settings-helper-text">
                  The SkinTokens/TokenRig rigging service (Auto Rig). Needs an NVIDIA GPU (≥14 GB).
                  In the desktop app it starts on demand; Stop it here to free GPU memory.
                  Outside the desktop app, start it from thirdparty/skintokens/run_server.
                </p>
                <ServiceInstaller
                  service="rigging"
                  buttonLabel="Install rigging service"
                  readyText="Rigging service is installed and ready."
                  note="One-time install; downloads several GB and needs an NVIDIA GPU (≥14 GB)."
                />
                <ServiceControl name="rigging" />
                <AutoStartToggle
                  warning
                  checked={localSettings?.apis?.rigtools?.autoStart}
                  onChange={v => setLocalSettings(prev => ({
                    ...prev,
                    apis: { ...prev?.apis, rigtools: { ...prev?.apis?.rigtools, autoStart: v } }
                  }))}
                />
              </div>

              <h3 className="settings-section-title font-label">Motion Generation (Python) Connection</h3>
              <div className="settings-api-card">
                <div className="settings-api-header">
                  <div className="settings-api-icon">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>auto_awesome</span>
                  </div>
                  <span className="settings-api-name">Kimodo (text to motion)</span>
                </div>

                <div className="settings-grid settings-grid--triple">
                  <div className="settings-input-group">
                    <label className="settings-label">Url</label>
                    <input
                      className="settings-input"
                      placeholder="http://127.0.0.1"
                      value={localSettings?.apis?.motiontools?.url || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          motiontools: {
                            ...prev?.apis?.motiontools,
                            url: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label">Port</label>
                    <input
                      className="settings-input"
                      placeholder="8400"
                      value={localSettings?.apis?.motiontools?.port || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          motiontools: {
                            ...prev?.apis?.motiontools,
                            port: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>
                </div>

                <div className="settings-input-group" style={{ marginTop: '10px' }}>
                  <label className="settings-label">Model folder</label>
                  <input
                    className="settings-input"
                    placeholder="Default: inside the app data folder"
                    value={localSettings?.apis?.motiontools?.modelsPath || ''}
                    onChange={e => setLocalSettings(prev => ({
                      ...prev,
                      apis: {
                        ...prev?.apis,
                        motiontools: {
                          ...prev?.apis?.motiontools,
                          modelsPath: e.target.value
                        }
                      }
                    }))}
                  />
                </div>

                <p className="settings-helper-text">
                  Where the ~17 GB of weights are kept: the Kimodo checkpoint and the Llama-3 base
                  its text encoder loads, each in its own subfolder. Leave this empty to use the
                  app data folder. Set it before installing — changing it later does not move
                  what is already downloaded, and the weights are only fetched into the new
                  folder when the install runs again.
                </p>

                <p className="settings-helper-text">
                  NVIDIA Kimodo, used by Mesh Editor &rarr; Auto Rig &rarr; Kimodo to generate an
                  animation from a text prompt. Needs an NVIDIA GPU. Its text encoder runs on the
                  CPU in a separate process (~16 GB of RAM while loaded) and is released after ten
                  minutes idle, so the GPU stays free for rigging and ComfyUI.
                  Outside the desktop app, start it from thirdparty/kimodo/run_server.
                </p>
                <LlamaLicenseGate onChange={setLlamaAccepted} />
                <ServiceInstaller
                  service="motion"
                  buttonLabel="Install motion service"
                  readyText="Motion service is installed and ready."
                  note="One-time install; downloads ~17 GB and needs an NVIDIA GPU."
                  blockedReason={llamaAccepted ? '' : 'Accept the Meta Llama 3 Community License above first — the text encoder downloads Meta Llama 3 weights.'}
                />
                <ServiceControl name="motion" />
                <AutoStartToggle
                  checked={localSettings?.apis?.motiontools?.autoStart}
                  onChange={v => setLocalSettings(prev => ({
                    ...prev,
                    apis: { ...prev?.apis, motiontools: { ...prev?.apis?.motiontools, autoStart: v } }
                  }))}
                />
              </div>

              <h3 className="settings-section-title font-label">Video to Motion (Python) Connection</h3>
              <div className="settings-api-card">
                <div className="settings-api-header">
                  <div className="settings-api-icon">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>videocam</span>
                  </div>
                  <span className="settings-api-name">MoCapAnything (video to motion)</span>
                </div>

                <div className="settings-grid settings-grid--triple">
                  <div className="settings-input-group">
                    <label className="settings-label">Url</label>
                    <input
                      className="settings-input"
                      placeholder="http://127.0.0.1"
                      value={localSettings?.apis?.mocaptools?.url || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          mocaptools: {
                            ...prev?.apis?.mocaptools,
                            url: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label">Port</label>
                    <input
                      className="settings-input"
                      placeholder="8401"
                      value={localSettings?.apis?.mocaptools?.port || ''}
                      onChange={e => setLocalSettings(prev => ({
                        ...prev,
                        apis: {
                          ...prev?.apis,
                          mocaptools: {
                            ...prev?.apis?.mocaptools,
                            port: e.target.value
                          }
                        }
                      }))}
                    />
                  </div>
                </div>

                <div className="settings-input-group" style={{ marginTop: '10px' }}>
                  <label className="settings-label">Model folder</label>
                  <input
                    className="settings-input"
                    placeholder="Default: inside the service folder"
                    value={localSettings?.apis?.mocaptools?.modelsPath || ''}
                    onChange={e => setLocalSettings(prev => ({
                      ...prev,
                      apis: {
                        ...prev?.apis,
                        mocaptools: {
                          ...prev?.apis?.mocaptools,
                          modelsPath: e.target.value
                        }
                      }
                    }))}
                  />
                </div>

                <p className="settings-helper-text">
                  Where the ~460 MB checkpoint is kept. Leave this empty to use the app data
                  folder. Set it before installing — changing it later does not move what is
                  already downloaded, and the checkpoint is only fetched into the new folder
                  when the install runs again.
                </p>

                <p className="settings-helper-text">
                  MoCapAnything V2, used by Mesh Editor &rarr; Auto Rig &rarr; MoCap to capture
                  motion from a video onto your rig. Needs an NVIDIA GPU: a 20-second capture
                  peaks around 10 GB of VRAM, and shorter captures need proportionally less.
                  Preparing a rig also needs Blender, installed as a Python module (bpy) — there
                  is no separate Blender install.
                  Outside the desktop app, start it from thirdparty/mocapanything/run_server.
                </p>

                <p className="settings-helper-text">
                  Captured motion is <b>in place</b>: the pose is followed, but the character does
                  not travel across the ground. Each rig is prepared once (a few minutes, cached)
                  before video can drive it.
                </p>

                <ServiceInstaller
                  service="mocap"
                  buttonLabel="Install video-to-motion service"
                  readyText="Video-to-motion service is installed and ready."
                  note="One-time install; downloads roughly 3 GB (PyTorch, Blender-as-a-module and the checkpoint) and needs an NVIDIA GPU."
                />
                <ServiceControl name="mocap" />
                <AutoStartToggle
                  checked={localSettings?.apis?.mocaptools?.autoStart}
                  onChange={v => setLocalSettings(prev => ({
                    ...prev,
                    apis: { ...prev?.apis, mocaptools: { ...prev?.apis?.mocaptools, autoStart: v } }
                  }))}
                />
              </div>
            </section>
          )}

          {activeTab === 'server' && <ServerSettingsTab />}
          {activeTab === 'create' && (
            <section className="settings-section">
              <h3 className="settings-section-title font-label">Creation Experience</h3>
              <div className="settings-api-card">
                <div className="settings-input-group">
                  <span id="create-mode-label" className="settings-label">Mode</span>
                  <div role="radiogroup" aria-labelledby="create-mode-label" style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="create-mode"
                        value="simple"
                        checked={localSettings?.create?.mode === 'simple'}
                        onChange={() => updateCreate({ mode: 'simple' })}
                      />
                      <span className="settings-helper-text" style={{ margin: 0 }}>Simple</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="create-mode"
                        value="advanced"
                        checked={localSettings?.create?.mode !== 'simple'}
                        onChange={() => updateCreate({ mode: 'advanced' })}
                      />
                      <span className="settings-helper-text" style={{ margin: 0 }}>Advanced</span>
                    </label>
                  </div>
                  <p className="settings-helper-text">
                    Simple keeps Create focused on project, reference, brief, name and Auto. Advanced exposes every engine and finishing control.
                  </p>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', marginTop: '10px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!localSettings?.create?.autoRun}
                    onChange={e => updateCreate({ autoRun: e.target.checked })}
                  />
                  <span className="settings-helper-text" style={{ margin: 0 }}>
                    Run new Create pipelines automatically without pausing for step review
                  </span>
                </label>
              </div>

              <h3 className="settings-section-title font-label">Simple-mode defaults</h3>
              <div className="settings-api-card">
                {createOptionsLoading && <p className="settings-helper-text">Loading Create options…</p>}
                {createOptionsError && (
                  <p className="settings-helper-text" style={{ color: '#f87171' }}>{createOptionsError}</p>
                )}
                {!createOptionsLoading && !createOptionsError && createOptions && (
                  <p className="settings-helper-text">
                    Leave an engine on Automatic to use the server&apos;s highest-ranked available option.
                  </p>
                )}

                <div className="settings-grid">
                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-template">Prompt template</label>
                    <select
                      id="create-default-template"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.templateId ?? ''}
                      onChange={e => updateCreateDefault('templateId', e.target.value || null)}
                    >
                      <option value="">Server default template</option>
                      {(createOptions?.templates || []).map(template => (
                        <option key={template.id} value={template.id}>{template.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-image-engine">Image engine</label>
                    <select
                      id="create-default-image-engine"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.imageEngineId ?? ''}
                      onChange={e => updateCreateDefault('imageEngineId', e.target.value || null)}
                    >
                      <option value="">Automatic — best available</option>
                      <CreateEngineOptions engines={createOptions?.imageEngines} />
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-mesh-engine">Mesh engine</label>
                    <select
                      id="create-default-mesh-engine"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.meshEngineId ?? ''}
                      onChange={e => updateCreateDefault('meshEngineId', e.target.value || null)}
                    >
                      <option value="">Automatic — best available</option>
                      <CreateEngineOptions engines={createOptions?.meshEngines} />
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-cutout">Cut-out</label>
                    <select
                      id="create-default-cutout"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.cutoutEngine || 'auto'}
                      onChange={e => updateCreateDefault('cutoutEngine', e.target.value)}
                    >
                      <option value="auto">Auto — remove opaque backgrounds</option>
                      <option value="off">Off</option>
                      <CreateEngineOptions engines={createOptions?.cutoutEngines} />
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-views">Turntable views</label>
                    <select
                      id="create-default-views"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.views || 'turntable'}
                      onChange={e => updateCreateDefault('views', e.target.value)}
                    >
                      <option value="turntable">Turntable</option>
                      <option value="single">Front view only</option>
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-clean">Clean mesh</label>
                    <select
                      id="create-default-clean"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.cleanEngine || 'auto'}
                      onChange={e => updateCreateDefault('cleanEngine', e.target.value)}
                    >
                      <option value="auto">Auto</option>
                      <option value="off">Off</option>
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-refine">Refine mesh</label>
                    <select
                      id="create-default-refine"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.refineEngine || 'off'}
                      onChange={e => updateCreateDefault('refineEngine', e.target.value)}
                    >
                      <option value="off">Off</option>
                      <option value="auto">Auto</option>
                      <CreateEngineOptions engines={createOptions?.refineEngines} />
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-texture">Texture mesh</label>
                    <select
                      id="create-default-texture"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.textureEngine || 'auto'}
                      onChange={e => updateCreateDefault('textureEngine', e.target.value)}
                    >
                      <option value="auto">Auto</option>
                      <option value="off">Off</option>
                      <CreateEngineOptions engines={createOptions?.textureEngines} />
                    </select>
                  </div>

                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor="create-default-rig">Auto-rig</label>
                    <select
                      id="create-default-rig"
                      className="settings-input"
                      value={localSettings?.create?.defaults?.rig || 'auto'}
                      onChange={e => updateCreateDefault('rig', e.target.value)}
                    >
                      <option value="auto">Auto</option>
                      <option value="off">Off</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="settings-footer">
          <button className="kanban-sidebar__nav-item" style={{ width: 'auto' }} onClick={onClose}>CANCEL</button>
          <button className="btn-save" onClick={handleSave}>SAVE ALL CHANGES</button>
        </div>
      </div>
    </div>
  )
}
