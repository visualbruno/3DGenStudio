import { useState, useEffect } from 'react'
import { useSettings } from '../context/SettingsContext'
import './SettingsModal.css'

export default function SettingsModal({ onClose }) {
  const { settings, updateSettings, addCustomApi } = useSettings()
  const [localSettings, setLocalSettings] = useState(settings)
  const [activeTab, setActiveTab] = useState('apis')
  const [showAddCustom, setShowAddCustom] = useState(false)
  const [newCustom, setNewCustom] = useState({ name: '', url: '', headers: '', body: '' })

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
    await addCustomApi(newCustom)
    setNewCustom({ name: '', url: '', headers: '', body: '' })
    setShowAddCustom(false)
    // Refresh local settings to show the new one
    setLocalSettings(prev => ({
      ...prev,
      apis: {
        ...prev.apis,
        custom: [...(prev.apis.custom || []), { ...newCustom, id: Date.now() }]
      }
    }))
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
                  <input
                    className="settings-input"
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
        </div>

        <div className="settings-footer">
          <button className="kanban-sidebar__nav-item" style={{ width: 'auto' }} onClick={onClose}>CANCEL</button>
          <button className="btn-save" onClick={handleSave}>SAVE ALL CHANGES</button>
        </div>
      </div>
    </div>
  )
}
