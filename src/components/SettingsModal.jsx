import { useState, useEffect } from 'react'
import { useSettings } from '../context/SettingsContext.shared'
import { API_BASE } from '../config'
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
    let alive = true
    const refresh = async () => {
      try { const s = await bridge.status(); if (alive) setSt(s?.[name] || null) } catch { /* ignore */ }
    }
    refresh()
    const id = setInterval(refresh, 3000) // reflect starting → running transitions
    return () => { alive = false; clearInterval(id) }
  }, [isDesktop, bridge, name])

  if (!isDesktop || !st) return null
  if (!st.installed) return null // not installed yet (Rigging install is handled above)

  const stopping = busy === 'stop'
  const starting = !stopping && (st.starting || busy === 'start')
  const running = st.running && !starting && !stopping

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
          {stopping ? 'Stopping…' : starting ? 'Starting…' : running ? 'Running' : 'Stopped'}
        </span>
        <div style={{ flex: 1 }} />
        {running ? (
          <button type="button" style={btn} onClick={doStop} disabled={!!busy}>Stop</button>
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

// Desktop-only: install the (opt-in) rigging service after first run — for users
// who upgraded, skipped it on the setup screen, or later added a GPU. Drives the
// same uv provisioning as the first-run window via the genStudioSetup bridge and
// shows live progress. Renders nothing outside the desktop app.
function RiggingInstaller() {
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
      if (evt.kind === 'phase') { setPhase(evt.phase || ''); if (typeof evt.pct === 'number') setPct(evt.pct) }
      else if (evt.kind === 'error') setError(evt.text || 'Setup failed.')
    })
    return () => { alive = false; if (typeof off === 'function') off() }
  }, [isDesktop, bridge])

  if (!isDesktop) return null

  const handleInstall = async () => {
    setError(''); setRunning(true); setPhase('Starting…'); setPct(0)
    try {
      const res = await bridge.run({ rigging: true })
      if (res?.ok) setStatus(await bridge.status())
      else setError(res?.error || 'Installation failed. See details in the setup logs.')
    } catch (e) {
      setError(e?.message || 'Installation failed.')
    } finally {
      setRunning(false)
    }
  }

  if (status?.rigging) {
    return (
      <p className="settings-helper-text" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#4caf50' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>check_circle</span>
        Rigging service is installed and ready.
      </p>
    )
  }

  return (
    <div style={{ marginTop: '8px' }}>
      <button
        type="button"
        onClick={handleInstall}
        disabled={running}
        style={{
          fontFamily: 'inherit', fontSize: '13px', fontWeight: 600,
          cursor: running ? 'default' : 'pointer', opacity: running ? 0.6 : 1,
          border: 'none', borderRadius: '8px', padding: '9px 16px', color: '#0b0e14',
          background: 'linear-gradient(90deg, #7c5cff, #22d3ee)',
        }}
      >
        {running ? `Installing… ${Math.round(pct * 100)}%` : 'Install rigging service'}
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
      <p className="settings-helper-text">One-time install; downloads several GB and needs an NVIDIA GPU (≥14 GB).</p>
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
  const { settings, updateSettings, addCustomApi } = useSettings()
  const [localSettings, setLocalSettings] = useState(settings)
  const [activeTab, setActiveTab] = useState('apis')
  const [showAddCustom, setShowAddCustom] = useState(false)
  const [newCustom, setNewCustom] = useState({ name: '', url: '', headers: '', body: '', type: 'image-generation' })

  // Ensure local state is updated if context settings load/change
  useEffect(() => {
    setLocalSettings(settings)
  }, [settings])

  const handleSave = async () => {
    await updateSettings(localSettings)
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
                    <BrowseFolderButton
                      description="Select your ComfyUI folder"
                      initialPath={localSettings?.apis?.comfyui?.path || ''}
                      onPick={picked => setLocalSettings(prev => ({
                        ...prev,
                        apis: { ...prev?.apis, comfyui: { ...prev?.apis?.comfyui, path: picked } }
                      }))}
                    />
                  </div>
                </div>

                <div className="settings-input-group">
                  <label className="settings-label">Models Path <span style={{ opacity: 0.6, fontWeight: 400 }}>(optional)</span></label>
                  <div style={{ display: 'flex', gap: '0.5em', alignItems: 'flex-start' }}>
                    <input
                      className="settings-input"
                      style={{ flex: 1 }}
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
                    <BrowseFolderButton
                      description="Select your ComfyUI models folder"
                      initialPath={localSettings?.apis?.comfyui?.modelsPath || localSettings?.apis?.comfyui?.path || ''}
                      onPick={picked => setLocalSettings(prev => ({
                        ...prev,
                        apis: { ...prev?.apis, comfyui: { ...prev?.apis?.comfyui, modelsPath: picked } }
                      }))}
                    />
                  </div>
                  <p className="settings-helper-text">
                    Set this only if your models live somewhere other than <code>{'{ComfyUI path}'}\models</code> (e.g. shared across multiple ComfyUI installs).
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
                <RiggingInstaller />
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
