import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '../context/SettingsContext.shared'
import './SetupWizardModal.css'
import { API_BASE } from '../config'

const STEPS = [
  { id: 'comfy-path', label: 'ComfyUI' },
  { id: 'models', label: 'Models' },
  { id: 'download', label: 'Download' },
  { id: 'workflows', label: 'Workflows' }
]

function formatGB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  return `${(bytes / (1024 ** 3)).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`
}

function bytesFromGB(gb) {
  const value = Number(gb)
  return Number.isFinite(value) ? Math.round(value * (1024 ** 3)) : 0
}

function buildFileList(config, selections, comfyPathsByCategory) {
  const map = new Map()

  const addFile = (relativeDir, entry) => {
    if (!entry?.FileName || !entry?.Url) return
    const key = `${relativeDir}::${entry.FileName}`
    if (map.has(key)) return
    map.set(key, {
      relativeDir,
      fileName: entry.FileName,
      url: entry.Url,
      expectedBytes: bytesFromGB(entry.Size)
    })
  }

  for (const selection of selections) {
    if (!selection.modelQuality) continue
    const diffusion = (config.DiffusionModels || []).find(d => d.Name === selection.diffusionName)
    if (!diffusion) continue
    const modelEntry = diffusion.Models?.[selection.modelQuality]
    addFile(comfyPathsByCategory.DiffusionModels, modelEntry)
    addFile(comfyPathsByCategory.VAE, diffusion.VAE)
    addFile(comfyPathsByCategory.TextEncoder, diffusion.TextEncoder)
    const loras = Array.isArray(diffusion.LoRA)
      ? diffusion.LoRA
      : (diffusion.LoRA ? [diffusion.LoRA] : [])
    for (const loraEntry of loras) {
      addFile(comfyPathsByCategory.LoRA, loraEntry)
    }
    const controlnets = Array.isArray(diffusion.ControlNet)
      ? diffusion.ControlNet
      : (diffusion.ControlNet ? [diffusion.ControlNet] : [])
    for (const controlnetEntry of controlnets) {
      addFile(comfyPathsByCategory.ControlNet, controlnetEntry)
    }
    const upscaleModels = Array.isArray(diffusion.UpscaleModels)
      ? diffusion.UpscaleModels
      : (diffusion.UpscaleModels ? [diffusion.UpscaleModels] : [])
    for (const upscaleEntry of upscaleModels) {
      addFile(comfyPathsByCategory.UpscaleModels, upscaleEntry)
    }
  }

  return Array.from(map.values())
}

export default function SetupWizardModal({ onComplete, onClose }) {
  const { settings, updateSettings } = useSettings()

  const [stepId, setStepId] = useState('comfy-path')
  const [config, setConfig] = useState(null)
  const [loadError, setLoadError] = useState('')

  const [comfyPath, setComfyPath] = useState('')
  const [pathBusy, setPathBusy] = useState(false)
  const [pathError, setPathError] = useState('')
  const [browseBusy, setBrowseBusy] = useState(false)

  const [selectionByName, setSelectionByName] = useState({})
  const [existingFileKeys, setExistingFileKeys] = useState(new Set())
  const [checkingFiles, setCheckingFiles] = useState(false)

  const [downloadEvent, setDownloadEvent] = useState(null)
  const [downloadError, setDownloadError] = useState('')
  const eventSourceRef = useRef(null)

  const [installBusy, setInstallBusy] = useState(false)
  const [installResult, setInstallResult] = useState(null)
  const [workflowSelection, setWorkflowSelection] = useState({})
  const [overwriteWorkflows, setOverwriteWorkflows] = useState(false)
  const workflowSelectionPrimedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/setup/config`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data?.error || 'Failed to load setup config')
        setConfig(data)
        const initial = {}
        for (const diffusion of data.DiffusionModels || []) {
          initial[diffusion.Name] = ''
        }
        setSelectionByName(initial)
      } catch (err) {
        if (!cancelled) setLoadError(err.message || String(err))
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    setComfyPath(settings?.apis?.comfyui?.path || '')
  }, [settings?.apis?.comfyui?.path])

  useEffect(() => () => {
    eventSourceRef.current?.close()
  }, [])

  const allCandidateFiles = useMemo(() => {
    if (!config) return []
    const paths = config.ComfyUIPaths || {}
    const allSelections = (config.DiffusionModels || []).flatMap(diffusion => {
      const qualities = Object.keys(diffusion.Models || {})
      return qualities.map(q => ({ diffusionName: diffusion.Name, modelQuality: q }))
    })
    return buildFileList(config, allSelections, paths)
  }, [config])

  const refreshFileExistence = useCallback(async (pathOverride) => {
    if (!config) return
    const effectivePath = pathOverride ?? comfyPath
    if (!effectivePath) return

    setCheckingFiles(true)
    try {
      const res = await fetch(`${API_BASE}/setup/check-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comfyPath: effectivePath, files: allCandidateFiles })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to check files')
      const keys = new Set(
        (data.files || [])
          .filter(file => file.exists)
          .map(file => `${file.relativeDir}::${file.fileName}`)
      )
      setExistingFileKeys(keys)
    } catch (err) {
      console.error('Failed to check files:', err)
    } finally {
      setCheckingFiles(false)
    }
  }, [allCandidateFiles, comfyPath, config])

  const selections = useMemo(
    () => Object.entries(selectionByName).map(([diffusionName, modelQuality]) => ({ diffusionName, modelQuality })),
    [selectionByName]
  )

  const filesToDownload = useMemo(() => {
    if (!config) return []
    const candidates = buildFileList(config, selections, config.ComfyUIPaths || {})
    return candidates.filter(file => !existingFileKeys.has(`${file.relativeDir}::${file.fileName}`))
  }, [config, selections, existingFileKeys])

  const totalDownloadBytes = useMemo(
    () => filesToDownload.reduce((sum, file) => sum + (file.expectedBytes || 0), 0),
    [filesToDownload]
  )

  const candidateWorkflows = useMemo(() => {
    if (!config) return []
    const items = []
    for (const sel of selections) {
      if (!sel.modelQuality) continue
      const diffusion = (config.DiffusionModels || []).find(d => d.Name === sel.diffusionName)
      for (const workflow of diffusion?.Workflows || []) {
        items.push({
          key: workflow.File,
          name: workflow.Name,
          workflowFile: workflow.File,
          subtitle: diffusion.Name,
          diffusionName: diffusion.Name,
          modelQuality: sel.modelQuality
        })
      }
    }
    for (const workflow of config.OtherWorkflows || []) {
      items.push({
        key: workflow.File,
        name: workflow.Name,
        workflowFile: workflow.File,
        subtitle: 'Other',
        diffusionName: null,
        modelQuality: null
      })
    }
    return items
  }, [config, selections])

  useEffect(() => {
    if (stepId !== 'workflows') {
      workflowSelectionPrimedRef.current = false
      return
    }
    if (workflowSelectionPrimedRef.current) return
    workflowSelectionPrimedRef.current = true
    const next = {}
    for (const item of candidateWorkflows) {
      next[item.key] = true
    }
    setWorkflowSelection(next)
  }, [stepId, candidateWorkflows])

  const handleSkip = async () => {
    try {
      await updateSettings({ ...settings, initialSetupComplete: true })
    } catch (err) {
      console.error('Failed to mark setup complete:', err)
    }
    onClose?.()
  }

  const handleCloseAndMarkComplete = async () => {
    try {
      await updateSettings({ ...settings, initialSetupComplete: true })
    } catch (err) {
      console.error('Failed to mark setup complete:', err)
    }
    onClose?.()
  }

  const handleBrowseFolder = async () => {
    setPathError('')
    setBrowseBusy(true)
    try {
      const res = await fetch(`${API_BASE}/setup/pick-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Select your ComfyUI folder', initialPath: comfyPath })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Folder picker failed')
      if (data.path) setComfyPath(data.path)
    } catch (err) {
      setPathError(err.message || String(err))
    } finally {
      setBrowseBusy(false)
    }
  }

  const handleValidatePath = async () => {
    setPathError('')
    setPathBusy(true)
    try {
      const trimmed = comfyPath.trim()
      const res = await fetch(`${API_BASE}/setup/check-comfy-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmed })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Invalid ComfyUI path')

      await updateSettings({
        ...settings,
        apis: {
          ...(settings?.apis || {}),
          comfyui: { ...(settings?.apis?.comfyui || {}), path: trimmed }
        }
      })

      await refreshFileExistence(trimmed)
      setStepId('models')
    } catch (err) {
      setPathError(err.message || String(err))
    } finally {
      setPathBusy(false)
    }
  }

  const handleStartDownload = async () => {
    setDownloadError('')
    setDownloadEvent(null)

    if (filesToDownload.length === 0) {
      setStepId('workflows')
      return
    }

    try {
      const res = await fetch(`${API_BASE}/setup/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comfyPath, files: filesToDownload })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to start downloads')

      const jobId = data.jobId
      setStepId('download')

      eventSourceRef.current?.close()
      const source = new EventSource(`${API_BASE}/setup/download/progress/${jobId}`)
      eventSourceRef.current = source

      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data)
          setDownloadEvent(payload)
          if (payload.status === 'done' || payload.status === 'error') {
            source.close()
            eventSourceRef.current = null
            if (payload.status === 'error') {
              setDownloadError(payload.error || 'Download failed')
            }
          }
        } catch {
          /* ignore */
        }
      }

      source.onerror = () => {
        source.close()
        eventSourceRef.current = null
        setDownloadError(prev => prev || 'Lost connection to download progress stream')
      }
    } catch (err) {
      setDownloadError(err.message || String(err))
    }
  }

  const handleInstallWorkflows = async () => {
    setInstallBusy(true)
    setInstallResult(null)
    try {
      const payloadWorkflows = candidateWorkflows
        .filter(item => workflowSelection[item.key])
        .map(item => ({
          workflowFile: item.workflowFile,
          diffusionName: item.diffusionName,
          modelQuality: item.modelQuality
        }))

      const res = await fetch(`${API_BASE}/setup/install-workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflows: payloadWorkflows, overwrite: overwriteWorkflows })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to install workflows')
      setInstallResult(data)
    } catch (err) {
      setInstallResult({ installed: [], skipped: [], errors: [{ workflow: '*', error: err.message || String(err) }] })
    } finally {
      setInstallBusy(false)
    }
  }

  const handleFinish = async () => {
    try {
      await updateSettings({ ...settings, initialSetupComplete: true })
    } catch (err) {
      console.error('Failed to mark setup complete:', err)
    }
    onComplete?.()
  }

  const downloadDone = downloadEvent?.status === 'done'
  const downloadInProgress = downloadEvent?.status === 'downloading'
  const overlayClick = stepId === 'comfy-path' ? handleCloseAndMarkComplete : undefined

  return (
    <div className="projects-page__modal-overlay" onClick={overlayClick}>
      <div className="projects-page__modal setup-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="projects-page__modal-glow" />

        <div className="projects-page__modal-header projects-page__modal-header--split">
          <div>
            <h1 className="projects-page__modal-title font-headline">Initial Setup</h1>
            <p className="projects-page__modal-desc">
              Get ComfyUI wired up so you can generate locally.
            </p>
          </div>
          {stepId === 'comfy-path' && (
            <button
              type="button"
              className="projects-page__icon-btn"
              onClick={handleCloseAndMarkComplete}
              aria-label="Close setup"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>

        <ol className="setup-wizard__steps">
          {STEPS.map((step, index) => {
            const stepIndex = STEPS.findIndex(s => s.id === stepId)
            const state = index < stepIndex ? 'done' : index === stepIndex ? 'active' : 'pending'
            return (
              <li key={step.id} className={`setup-wizard__step setup-wizard__step--${state}`}>
                <span className="setup-wizard__step-index">{index + 1}</span>
                <span className="setup-wizard__step-label">{step.label}</span>
              </li>
            )
          })}
        </ol>

        {loadError && <div className="setup-wizard__error">{loadError}</div>}

        {stepId === 'comfy-path' && (
          <div className="setup-wizard__body">
            <label className="projects-page__label font-label" htmlFor="setup-comfy-path">ComfyUI Folder</label>
            <div className="setup-wizard__path-row">
              <input
                id="setup-comfy-path"
                type="text"
                className="projects-page__input setup-wizard__path-input"
                placeholder="e.g. D:\AI\ComfyUI"
                value={comfyPath}
                onChange={(e) => setComfyPath(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="setup-wizard__browse-btn"
                onClick={handleBrowseFolder}
                disabled={browseBusy}
                title="Browse for ComfyUI folder"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>folder_open</span>
                {browseBusy ? '…' : 'Browse'}
              </button>
            </div>
            <p className="setup-wizard__hint">
              The folder must contain a <code>models</code> subfolder. Missing model-type subfolders will be created.
            </p>
            {pathError && <div className="setup-wizard__error">{pathError}</div>}

            <div className="setup-wizard__actions">
              <button type="button" className="projects-page__btn-secondary setup-wizard__btn-skip" onClick={handleSkip}>
                Skip
              </button>
              <button
                type="button"
                className="projects-page__btn-primary"
                onClick={handleValidatePath}
                disabled={pathBusy || !comfyPath.trim() || !config}
              >
                {pathBusy ? 'Checking…' : 'Next'}
              </button>
            </div>
          </div>
        )}

        {stepId === 'models' && config && (
          <div className="setup-wizard__body">
            <p className="setup-wizard__hint">
              Pick one quality per model you want to install — or leave everything as “Don’t install” to skip downloads and jump straight to importing workflows. Sizes include the model file and its required VAE / Text Encoder / LoRA(s).
            </p>

            <div className="setup-wizard__model-list">
              {(config.DiffusionModels || []).map(diffusion => {
                const currentQuality = selectionByName[diffusion.Name] || ''
                const selectionFiles = buildFileList(
                  config,
                  [{ diffusionName: diffusion.Name, modelQuality: currentQuality }],
                  config.ComfyUIPaths || {}
                )
                const selectionDownload = selectionFiles.filter(
                  file => !existingFileKeys.has(`${file.relativeDir}::${file.fileName}`)
                )
                const selectionDownloadBytes = selectionDownload.reduce((sum, f) => sum + (f.expectedBytes || 0), 0)

                return (
                  <div key={diffusion.Name} className="setup-wizard__model-card">
                    <div className="setup-wizard__model-head">
                      <span className="setup-wizard__model-name font-headline">{diffusion.Name}</span>
                      {currentQuality && (
                        <span className="setup-wizard__model-meta">
                          {selectionDownload.length === 0 ? 'Already installed' : `${formatGB(selectionDownloadBytes)} to download`}
                        </span>
                      )}
                    </div>

                    <div className="projects-page__select-wrap">
                      <select
                        className="projects-page__select"
                        value={currentQuality}
                        onChange={(e) =>
                          setSelectionByName(prev => ({ ...prev, [diffusion.Name]: e.target.value }))
                        }
                      >
                        <option value="">Don&apos;t install</option>
                        {Object.entries(diffusion.Models || {}).map(([quality, entry]) => (
                          <option key={quality} value={quality}>
                            {quality} — {entry.FileName} ({Number(entry.Size).toFixed(1)} GB)
                          </option>
                        ))}
                      </select>
                      <span className="material-symbols-outlined projects-page__select-icon">expand_more</span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="setup-wizard__summary">
              <span>{filesToDownload.length} file{filesToDownload.length === 1 ? '' : 's'} to download</span>
              <strong>{formatGB(totalDownloadBytes)}</strong>
            </div>

            <div className="setup-wizard__actions">
              <button type="button" className="projects-page__btn-secondary" onClick={() => setStepId('comfy-path')}>
                Back
              </button>
              <button
                type="button"
                className="projects-page__btn-primary"
                onClick={handleStartDownload}
                disabled={checkingFiles}
              >
                {filesToDownload.length === 0 ? 'Next' : 'Download'}
              </button>
            </div>
          </div>
        )}

        {stepId === 'download' && (
          <div className="setup-wizard__body">
            <div className="setup-wizard__progress-block">
              <div className="setup-wizard__progress-meta">
                <span className="setup-wizard__progress-file">
                  {downloadEvent?.currentFile || (downloadDone ? 'All files downloaded' : 'Preparing…')}
                </span>
                <span className="setup-wizard__progress-counter">
                  {downloadEvent
                    ? `${Math.min((downloadEvent.currentIndex || 0) + (downloadDone ? 0 : 1), downloadEvent.totalFiles || 0)} / ${downloadEvent.totalFiles || 0}`
                    : ''}
                </span>
              </div>

              <div className="setup-wizard__progress-bar">
                <div
                  className="setup-wizard__progress-bar-fill"
                  style={{ width: `${Math.min(100, Math.max(0, downloadEvent?.overallPercent ?? 0))}%` }}
                />
              </div>

              <div className="setup-wizard__progress-foot">
                <span>{downloadEvent?.overallPercent ?? 0}% overall</span>
                <span>
                  {downloadInProgress && downloadEvent?.currentTotalBytes
                    ? `${formatGB(downloadEvent.currentBytes)} / ${formatGB(downloadEvent.currentTotalBytes)} (${downloadEvent.currentPercent ?? 0}%)`
                    : ''}
                </span>
              </div>
            </div>

            {downloadError && <div className="setup-wizard__error">{downloadError}</div>}

            <div className="setup-wizard__actions">
              <button
                type="button"
                className="projects-page__btn-secondary"
                onClick={() => setStepId('models')}
                disabled={downloadInProgress}
              >
                Back
              </button>
              <button
                type="button"
                className="projects-page__btn-primary"
                onClick={() => setStepId('workflows')}
                disabled={!downloadDone && !downloadError}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {stepId === 'workflows' && (
          <div className="setup-wizard__body">
            <p className="setup-wizard__hint">
              Pick the workflows to import. Diffusion-tied workflows are wired to the model you downloaded.
            </p>

            <div className="setup-wizard__workflow-toolbar">
              <span className="setup-wizard__workflow-counter">
                {Object.values(workflowSelection).filter(Boolean).length} / {candidateWorkflows.length} selected
              </span>
              <div className="setup-wizard__workflow-toolbar-actions">
                <button
                  type="button"
                  className="setup-wizard__workflow-link"
                  onClick={() => setWorkflowSelection(
                    Object.fromEntries(candidateWorkflows.map(item => [item.key, true]))
                  )}
                  disabled={installBusy}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="setup-wizard__workflow-link"
                  onClick={() => setWorkflowSelection({})}
                  disabled={installBusy}
                >
                  Select none
                </button>
              </div>
            </div>

            <div className="setup-wizard__workflow-list">
              {candidateWorkflows.length === 0 && (
                <div className="setup-wizard__workflow-empty">No workflows available for the current selection.</div>
              )}
              {candidateWorkflows.map(item => (
                <label key={item.key} className="setup-wizard__workflow-item">
                  <input
                    type="checkbox"
                    checked={Boolean(workflowSelection[item.key])}
                    onChange={(e) =>
                      setWorkflowSelection(prev => ({ ...prev, [item.key]: e.target.checked }))
                    }
                    disabled={installBusy}
                  />
                  <span className="setup-wizard__workflow-item-body">
                    <span className="setup-wizard__workflow-item-name">{item.name}</span>
                    <span className="setup-wizard__workflow-item-meta">{item.subtitle}</span>
                  </span>
                </label>
              ))}
            </div>

            <label className="setup-wizard__overwrite">
              <input
                type="checkbox"
                checked={overwriteWorkflows}
                onChange={(e) => setOverwriteWorkflows(e.target.checked)}
                disabled={installBusy}
              />
              <span>Overwrite existing workflows with the same name</span>
            </label>

            {installResult && (
              <div className="setup-wizard__result">
                <div>
                  Installed: <strong>{installResult.installed?.length || 0}</strong>
                  {installResult.skipped?.length > 0 && (
                    <> · Skipped: <strong>{installResult.skipped.length}</strong></>
                  )}
                </div>
                {installResult.skipped?.length > 0 && (
                  <ul className="setup-wizard__result-skipped">
                    {installResult.skipped.map((s, i) => (
                      <li key={i}>{s.name} — already installed (enable overwrite to replace)</li>
                    ))}
                  </ul>
                )}
                {installResult.errors?.length > 0 && (
                  <ul className="setup-wizard__result-errors">
                    {installResult.errors.map((e, i) => (
                      <li key={i}>{e.workflow || e.workflowFile || 'error'}: {e.error}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="setup-wizard__actions">
              <button
                type="button"
                className="projects-page__btn-secondary"
                onClick={() => setStepId('download')}
                disabled={installBusy}
              >
                Back
              </button>
              {!installResult ? (
                <button
                  type="button"
                  className="projects-page__btn-primary"
                  onClick={handleInstallWorkflows}
                  disabled={installBusy || Object.values(workflowSelection).every(v => !v)}
                >
                  {installBusy ? 'Installing…' : 'Install Workflows'}
                </button>
              ) : (
                <button type="button" className="projects-page__btn-primary" onClick={handleFinish}>
                  Done
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
