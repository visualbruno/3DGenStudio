import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext'
import Header from '../components/Header'
import Footer from '../components/Footer'
import Viewer from '../components/Viewer'
import SettingsModal from '../components/SettingsModal'
import './KanbanPage.css'

const SIDEBAR_ITEMS = [
  { id: 'images', icon: 'image', label: 'Images' },
  { id: 'imageedit', icon: 'photo_filter', label: 'Image Edit' },
  { id: 'meshgen', icon: 'deployed_code', label: 'Mesh Gen', filled: true },
  { id: 'meshedit', icon: 'edit_square', label: 'Mesh Edit' },
  { id: 'texturing', icon: 'texture', label: 'Texturing' },
]

const IMAGE_API_LIST = [
  { id: 'nanobana', name: 'Nanobana' },
  { id: 'nanobana_pro', name: 'Nanobana Pro' },
  { id: 'nanobana_2', name: 'Nanobana 2' },
  { id: 'openai', name: 'OpenAI (DALL-E 3)' },
]

function getComfyDraftFromWorkflow(workflow) {
  return {
    mode: 'comfy',
    workflowId: workflow?.id || '',
    inputs: Object.fromEntries(
      (workflow?.parameters || []).map(parameter => {
        const valueType = parameter.valueType || (parameter.type === 'number' ? 'number' : 'string')
        return [parameter.id, ['image', 'video'].includes(valueType) ? null : (parameter.defaultValue ?? '')]
      })
    )
  }
}

function formatWorkflowDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function getWorkflowParameterValueType(parameter) {
  return parameter.valueType || (parameter.type === 'number' ? 'number' : 'string')
}

function createImageCardId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `image-card-${Date.now()}-${Math.round(Math.random() * 1E9)}`
}

export default function KanbanPage() {
  const { projectId } = useParams()
  const {
    getProject,
    getProjectAssets,
    getProjectTasks,
    uploadAsset,
    attachExistingAsset,
    deleteAsset,
    getLibraryAssets,
    createTask,
    generateImage,
    getComfyWorkflows,
    runComfyWorkflow
  } = useProjects()
  const { settings } = useSettings()
  
  const [project, setProject] = useState(null)
  const [assets, setAssets] = useState([])
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)

  const [activeTab, setActiveTab] = useState('meshgen')
  const [genSeed, setGenSeed] = useState('8841295201')
  const [faceCount, setFaceCount] = useState('15000')
  const [meshBatch, setMeshBatch] = useState('1')
  const [processEngine, setProcessEngine] = useState('api')
  const [texResolution, setTexResolution] = useState('2048 x 2048 (2K)')
  const [texEngine, setTexEngine] = useState('stable')
  const [pbrEnabled, setPbrEnabled] = useState(true)
  const [aoEnabled, setAoEnabled] = useState(false)

  // NEW: Settings and Image Creation State
  const [showSettings, setShowSettings] = useState(false)
  const [imageDraft, setImageDraft] = useState(null) // null | { mode: 'select'|'local'|'comfy'|'api' }
  const [pendingImageGeneration, setPendingImageGeneration] = useState(null)
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [] })
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [comfyWorkflows, setComfyWorkflows] = useState([])
  const [comfyLoading, setComfyLoading] = useState(false)
  const [imageCardPages, setImageCardPages] = useState({})
  const fileInputRef = useRef(null)
  const fileUploadContextRef = useRef({ cardId: null, closeDraft: true })

  // Fetch all data for this project
  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [projData, assetsData, tasksData] = await Promise.all([
          getProject(projectId),
          getProjectAssets(projectId),
          getProjectTasks(projectId)
        ])
        setProject(projData)
        setAssets(assetsData)
        setTasks(tasksData)
      } catch (err) {
        console.error('Failed to load project data:', err)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [projectId, getProject, getProjectAssets, getProjectTasks])

  useEffect(() => {
    async function loadComfyWorkflows() {
      try {
        setComfyLoading(true)
        const workflows = await getComfyWorkflows()
        setComfyWorkflows(workflows)
      } catch (err) {
        console.error('Failed to load ComfyUI workflows:', err)
      } finally {
        setComfyLoading(false)
      }
    }

    loadComfyWorkflows()
  }, [getComfyWorkflows])

  const openImageSourceMenu = (cardId = null) => {
    setImageDraft({ mode: 'select', cardId })
  }

  const openLocalFilePicker = (cardId = null) => {
    fileUploadContextRef.current = {
      cardId,
      closeDraft: !cardId
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    const { cardId, closeDraft } = fileUploadContextRef.current
    const nextCardId = cardId || createImageCardId()

    try {
      setLoading(true)

      for (const file of files) {
        await uploadAsset(projectId, file, 'image', {
          resolution: 'Unknown',
          format: file.type.split('/')[1]?.toUpperCase() || 'IMG',
          source: 'IMPORT',
          cardId: nextCardId
        })
      }

      const assetsData = await getProjectAssets(projectId)
      setAssets(assetsData)

      if (closeDraft) {
        setImageDraft(null)
      }
    } catch (err) {
      console.error('Upload failed:', err)
      alert(err.message || 'Upload failed')
    } finally {
      setLoading(false)
      e.target.value = ''
      fileUploadContextRef.current = { cardId: null, closeDraft: true }
    }
  }

  const refreshProjectAssets = async () => {
    const assetsData = await getProjectAssets(projectId)
    setAssets(assetsData)
  }

  const selectedComfyWorkflow = comfyWorkflows.find(workflow => workflow.id == imageDraft?.workflowId) || null

  const openComfyWorkflowDraft = (cardId = imageDraft?.cardId || null) => {
    if (comfyWorkflows.length === 0) {
      alert('Import a ComfyUI workflow in the Library page first.')
      return
    }

    setImageDraft({
      ...getComfyDraftFromWorkflow(comfyWorkflows[0]),
      cardId
    })
  }

  const handleComfyWorkflowChange = (workflowId) => {
    const workflow = comfyWorkflows.find(item => item.id == workflowId)
    setImageDraft(prev => ({
      ...getComfyDraftFromWorkflow(workflow),
      cardId: prev?.cardId || null
    }))
  }

  const handleComfyInputChange = (parameter, rawValue) => {
    const valueType = getWorkflowParameterValueType(parameter)
    let nextValue = rawValue

    if (['image', 'video'].includes(valueType)) {
      nextValue = rawValue
    } else if (parameter.type === 'number' || valueType === 'number') {
      nextValue = rawValue
    } else if (parameter.type === 'json' && typeof rawValue === 'string') {
      nextValue = rawValue
    }

    setImageDraft(prev => ({
      ...prev,
      inputs: {
        ...(prev?.inputs || {}),
        [parameter.id]: nextValue
      }
    }))
  }

  const openAssetLibrary = async (cardId = imageDraft?.cardId || null) => {
    try {
      setLibraryLoading(true)
      const library = await getLibraryAssets()
      setLibraryAssets(library)
      setImageDraft({ mode: 'assets', cardId })
    } catch (err) {
      console.error('Failed to load asset library:', err)
      alert(err.message || 'Failed to load assets library')
    } finally {
      setLibraryLoading(false)
    }
  }

  const handleAttachLibraryImage = async (libraryImage) => {
    try {
      setLoading(true)
      const cardId = imageDraft?.cardId || createImageCardId()
      await attachExistingAsset(projectId, {
        filename: libraryImage.filename,
        type: 'image',
        name: libraryImage.name,
        metadata: {
          resolution: 'Unknown',
          format: libraryImage.extension,
          source: 'ASSET LIB',
          cardId
        }
      })
      await refreshProjectAssets()
      setImageDraft(null)
    } catch (err) {
      console.error('Failed to attach image from assets:', err)
      alert(err.message || 'Failed to attach image from assets')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveImage = async (assetId) => {
    try {
      await deleteAsset(assetId)
      await refreshProjectAssets()
    } catch (err) {
      console.error('Failed to remove image:', err)
      alert(err.message || 'Failed to remove image')
    }
  }

  const handleRemoveImageCard = async (cardAssets) => {
    try {
      for (const asset of cardAssets) {
        await deleteAsset(asset.id)
      }

      await refreshProjectAssets()
    } catch (err) {
      console.error('Failed to remove image card:', err)
      alert(err.message || 'Failed to remove image card')
    }
  }

  const handleGenerateImage = async (draft) => {
    if (draft.mode === 'comfy') {
      if (!draft?.workflowId) return

      const workflow = comfyWorkflows.find(item => item.id == draft.workflowId)
      if (!workflow) {
        alert('Select a valid ComfyUI workflow.')
        return
      }

      for (const parameter of workflow.parameters || []) {
        const valueType = getWorkflowParameterValueType(parameter)
        const currentValue = draft.inputs?.[parameter.id]

        if (['image', 'video'].includes(valueType) && !currentValue) {
          alert(`Select a ${valueType} file for ${parameter.name}.`)
          return
        }

        if (valueType === 'string' && !String(currentValue ?? '').trim()) {
          alert(`Enter a value for ${parameter.name}.`)
          return
        }
      }

      try {
        setPendingImageGeneration({
          title: workflow.name,
          source: 'ComfyUI',
          detail: `Running ${workflow.parameters?.length || 0} configured input${workflow.parameters?.length === 1 ? '' : 's'}`
        })
        setImageDraft(null)
        setLoading(true)
        await runComfyWorkflow(projectId, {
          workflowId: draft.workflowId,
          inputs: draft.inputs || {},
          cardId: draft.cardId || createImageCardId()
        })
        await refreshProjectAssets()
      } catch (err) {
        console.error('ComfyUI workflow failed:', err)
        setImageDraft(draft)
        alert(err.message || 'ComfyUI workflow failed')
      } finally {
        setPendingImageGeneration(null)
        setLoading(false)
      }

      return
    }

    if (!draft?.prompt?.trim()) return

    try {
      setPendingImageGeneration({
        selectedApi: draft.selectedApi,
        title: draft.prompt.trim(),
        source: combinedApis.find(api => api.id === draft.selectedApi)?.name || 'Remote API',
        detail: 'Waiting for image response'
      })
      setImageDraft(null)
      setLoading(true)
      await generateImage(projectId, {
        selectedApi: draft.selectedApi,
        prompt: draft.prompt,
        cardId: draft.cardId || createImageCardId()
      })
      await refreshProjectAssets()
      setImageDraft(null)
    } catch (err) {
      console.error('Image generation failed:', err)
      setImageDraft(draft)
      alert(err.message || 'Image generation failed')
    } finally {
      setPendingImageGeneration(null)
      setLoading(false)
    }
  }

  const handleGenerateMesh = async () => {
    try {
      await createTask({
        projectId,
        name: `Mesh_Synth_${tasks.length + 1}`,
        metadata: { genSeed, faceCount, meshBatch, processEngine }
      });
      const tasksData = await getProjectTasks(projectId);
      setTasks(tasksData);
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  };

  const images = assets.filter(a => a.type === 'image')
  const imageCards = useMemo(() => {
    const cards = new Map()

    for (const asset of images) {
      const cardId = asset.metadata?.cardId || `asset-${asset.id}`

      if (!cards.has(cardId)) {
        cards.set(cardId, [])
      }

      cards.get(cardId).push(asset)
    }

    return Array.from(cards.entries())
      .map(([id, cardAssets]) => {
        const sortedAssets = [...cardAssets].sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
        const primaryAsset = sortedAssets[0]
        const sources = [...new Set(sortedAssets.map(asset => asset.metadata?.source).filter(Boolean))]
        const formats = [...new Set(sortedAssets.map(asset => asset.metadata?.format).filter(Boolean))]

        return {
          id,
          assets: sortedAssets,
          primaryAsset,
          sourceLabel: sources.length === 1 ? sources[0] : 'MIXED',
          metaLabel: sortedAssets.length === 1
            ? `${primaryAsset.metadata?.resolution || 'N/A'} • ${primaryAsset.metadata?.format || 'N/A'}`
            : `${sortedAssets.length} images • ${formats.slice(0, 2).join(', ') || 'Mixed formats'}`,
          createdAt: primaryAsset.createdAt || 0
        }
      })
      .sort((left, right) => right.createdAt - left.createdAt)
  }, [images])

  if (loading && !project) {
    return (
      <div className="kanban-layout" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p className="font-headline">Synchronizing Workspace...</p>
      </div>
    )
  }

  // Combined API list: Static + Custom from settings
  const combinedApis = [
    ...IMAGE_API_LIST,
    ...(settings?.apis?.custom || []).map(api => ({ id: `custom_${api.id}`, name: api.name }))
  ]

  return (
    <div className="kanban-layout">
      <Header showSearch showCreateNew onSettingsClick={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="kanban-body">
        {/* ── Sidebar ── */}
        <aside className="kanban-sidebar" id="kanban-sidebar">
          <div className="kanban-sidebar__workspace">
            <div className="kanban-sidebar__ws-icon">
              <span className="material-symbols-outlined" style={{ color: 'var(--secondary)' }}>token</span>
            </div>
            <div className="kanban-sidebar__ws-info">
              <span className="kanban-sidebar__ws-name">{project?.name || 'Workspace'}</span>
              <span className="kanban-sidebar__ws-version font-label">V0.4.2 Prototype</span>
            </div>
          </div>

          <nav className="kanban-sidebar__nav">
            {SIDEBAR_ITEMS.map(item => (
              <button
                key={item.id}
                className={`kanban-sidebar__nav-item ${activeTab === item.id ? 'kanban-sidebar__nav-item--active' : ''}`}
                onClick={() => setActiveTab(item.id)}
                id={`sidebar-${item.id}`}
              >
                <span className={`material-symbols-outlined ${item.filled && activeTab === item.id ? 'filled' : ''}`} style={{ fontSize: '18px' }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}

            <div className="kanban-sidebar__divider" />

            <button className="kanban-sidebar__new-asset" id="new-asset-btn" onClick={() => setShowSettings(true)}>
              <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>settings</span>
              <span className="font-label">PROJECT SETTINGS</span>
            </button>
          </nav>

          <div className="kanban-sidebar__bottom">
            <button className="kanban-sidebar__link" onClick={() => setShowSettings(true)} style={{ background: 'transparent', border: 'none', width: '100%', cursor: 'pointer', textAlign: 'left' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>account_circle</span>
              Profile
            </button>
            <a href="#" className="kanban-sidebar__link">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>help</span>
              Support
            </a>
          </div>
        </aside>

        {/* ── Main Kanban Area ── */}
        <main className="kanban-main" id="kanban-main">
          <div className="kanban-columns">
            {/* ═══ Column 1: Images ═══ */}
            <div className="kanban-col" id="col-images">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--primary)' }}>image</span>
                  <h2 className="kanban-col__title font-headline">IMAGES</h2>
                </div>
                <span className="kanban-col__badge font-label">{imageCards.length.toString().padStart(2, '0')} ITEMS</span>
              </div>

              <div className="kanban-col__content">
                {imageCards.map(card => (
                  <div key={card.id} className="image-card" id={`image-card-${card.id}`}>
                    {(() => {
                      const totalPages = Math.max(1, Math.ceil(card.assets.length / 4))
                      const currentPage = Math.min(imageCardPages[card.id] || 0, totalPages - 1)
                      const visibleAssets = card.assets.slice(currentPage * 4, currentPage * 4 + 4)

                      return (
                        <>
                    <div className="image-card__actions">
                      <button
                        className="image-card__action-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          openImageSourceMenu(card.id)
                        }}
                        title="Add more images"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add_photo_alternate</span>
                      </button>
                      <button
                        className="image-card__action-btn image-card__delete"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRemoveImageCard(card.assets)
                        }}
                        title="Remove card"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                      </button>
                    </div>

                    <div className={`image-card__thumb ${visibleAssets.length > 1 ? 'image-card__thumb--grid' : ''}`}>
                      {visibleAssets.length > 0 ? (
                        visibleAssets.map(asset => {
                          return (
                            <div key={asset.id} className="image-card__thumb-item">
                              {asset.filename ? (
                                <img
                                  src={`http://localhost:3001/assets/${encodeURI(asset.filename)}`}
                                  alt={asset.name}
                                  className="image-card__thumb-image"
                                />
                              ) : (
                                <div className="image-card__thumb-placeholder">
                                  <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>image</span>
                                </div>
                              )}

                              <button
                                className="image-card__thumb-remove"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRemoveImage(asset.id)
                                }}
                                title="Remove image"
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
                              </button>
                            </div>
                          )
                        })
                      ) : (
                        <div className="image-card__thumb-placeholder">
                          <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>image</span>
                        </div>
                      )}

                      {totalPages > 1 && (
                        <>
                          <button
                            className="image-card__thumb-nav image-card__thumb-nav--prev"
                            onClick={(e) => {
                              e.stopPropagation()
                              setImageCardPages(prev => ({
                                ...prev,
                                [card.id]: Math.max(0, currentPage - 1)
                              }))
                            }}
                            disabled={currentPage === 0}
                            title="Previous images"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_left</span>
                          </button>
                          <button
                            className="image-card__thumb-nav image-card__thumb-nav--next"
                            onClick={(e) => {
                              e.stopPropagation()
                              setImageCardPages(prev => ({
                                ...prev,
                                [card.id]: Math.min(totalPages - 1, currentPage + 1)
                              }))
                            }}
                            disabled={currentPage >= totalPages - 1}
                            title="Next images"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_right</span>
                          </button>
                          <div className="image-card__thumb-page-indicator font-label">
                            {currentPage + 1}/{totalPages}
                          </div>
                        </>
                      )}
                    </div>

                    <div className="image-card__info">
                      <div className="image-card__row">
                        <h3 className="image-card__name">{card.primaryAsset?.name || 'Untitled image'}</h3>
                        <div className="image-card__badges">
                          {card.assets.length > 1 && (
                            <span className="image-card__count font-label">{card.assets.length} IMAGES</span>
                          )}
                          <span
                            className="image-card__source"
                            style={{
                              color: ['AI GEN', 'COMFYUI'].includes(card.sourceLabel) ? 'var(--primary)' : 'var(--on-surface-variant)',
                              background: ['AI GEN', 'COMFYUI'].includes(card.sourceLabel) ? 'rgba(143,245,255,0.1)' : 'rgba(71,72,74,0.2)',
                            }}
                          >
                            {card.sourceLabel}
                          </span>
                        </div>
                      </div>
                      <p className="image-card__meta font-label">{card.metaLabel}</p>
                    </div>
                        </>
                      )
                    })()}
                  </div>
                ))}

                {/* DRAFT IMAGE CARD */}
                {imageDraft && (
                  <div className="image-card image-card--draft">
                    {imageDraft.mode === 'select' && (
                      <div className="image-card__options">
                        <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>IMAGE SOURCE</span>
                        <button className="option-btn" onClick={() => openLocalFilePicker(imageDraft?.cardId || null)}>
                          <span className="material-symbols-outlined">computer</span>
                          Local Computer
                        </button>
                        <button className="option-btn" onClick={() => openAssetLibrary(imageDraft?.cardId || null)}>
                          <span className="material-symbols-outlined">folder_open</span>
                          From Assets
                        </button>
                        <button className="option-btn" onClick={() => openComfyWorkflowDraft(imageDraft?.cardId || null)}>
                          <span className="material-symbols-outlined">account_tree</span>
                          ComfyUI Workflow
                        </button>
                        <button className="option-btn" onClick={() => setImageDraft({ mode: 'api', selectedApi: 'nanobana', prompt: '', cardId: imageDraft?.cardId || null })}>
                          <span className="material-symbols-outlined">api</span>
                          Remote API
                        </button>
                        <button className="kanban-sidebar__nav-item" onClick={() => setImageDraft(null)} style={{ marginTop: '0.5rem', justifyContent: 'center' }}>CANCEL</button>
                      </div>
                    )}

                    {imageDraft.mode === 'assets' && (
                      <div className="image-card__options">
                        <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>FROM ASSETS</span>
                        {libraryLoading ? (
                          <div className="image-card__asset-picker-empty">
                            <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                            <span>Loading images...</span>
                          </div>
                        ) : libraryAssets.images.length > 0 ? (
                          <div className="image-card__asset-picker">
                            {libraryAssets.images.map(asset => (
                              <button
                                key={asset.id}
                                className="image-card__asset-option"
                                onClick={() => handleAttachLibraryImage(asset)}
                              >
                                <img
                                  src={asset.url}
                                  alt={asset.name}
                                  className="image-card__asset-thumb"
                                />
                                <span className="image-card__asset-name">{asset.name}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="image-card__asset-picker-empty">
                            <span className="material-symbols-outlined">perm_media</span>
                            <span>No images available in `assets/images`.</span>
                          </div>
                        )}
                        <button className="kanban-sidebar__nav-item" onClick={() => openImageSourceMenu(imageDraft?.cardId || null)} style={{ justifyContent: 'center' }}>BACK</button>
                      </div>
                    )}

                    {imageDraft.mode === 'comfy' && (
                      <div className="image-card__options">
                        <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>COMFYUI WORKFLOW</span>
                        {comfyLoading ? (
                          <div className="image-card__asset-picker-empty">
                            <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                            <span>Loading workflows...</span>
                          </div>
                        ) : comfyWorkflows.length > 0 ? (
                          <>
                            <select
                              className="params-card__select"
                              value={imageDraft.workflowId}
                              onChange={e => handleComfyWorkflowChange(e.target.value)}
                            >
                              {comfyWorkflows.map(workflow => (
                                <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                              ))}
                            </select>

                            <div className="image-card__workflow-meta">
                              <span>{selectedComfyWorkflow?.parameters?.length || 0} input parameters configured</span>
                              <span>{selectedComfyWorkflow?.outputs?.length || 0} outputs selected</span>
                            </div>

                            <div className="gen-section">
                              {(selectedComfyWorkflow?.parameters || []).length > 0 ? (
                                <div className="image-card__workflow-params">
                                  {selectedComfyWorkflow.parameters.map(parameter => (
                                    <div key={parameter.id} className="params-card__field">
                                      <label className="params-card__label font-label">
                                        {parameter.name} • {getWorkflowParameterValueType(parameter).toUpperCase()}
                                      </label>

                                      {['image', 'video'].includes(getWorkflowParameterValueType(parameter)) ? (
                                        <label className="image-card__file-input">
                                          <input
                                            type="file"
                                            accept={getWorkflowParameterValueType(parameter) === 'video' ? 'video/*' : 'image/*'}
                                            onChange={e => handleComfyInputChange(parameter, e.target.files?.[0] || null)}
                                          />
                                          <span className="material-symbols-outlined">
                                            {getWorkflowParameterValueType(parameter) === 'video' ? 'video_file' : 'image'}
                                          </span>
                                          <span>
                                            {imageDraft.inputs?.[parameter.id]?.name || `Select ${getWorkflowParameterValueType(parameter)} file`}
                                          </span>
                                        </label>
                                      ) : parameter.type === 'json' ? (
                                        <textarea
                                          className="gen-prompt-input image-card__param-textarea"
                                          value={typeof imageDraft.inputs?.[parameter.id] === 'string'
                                            ? imageDraft.inputs?.[parameter.id]
                                            : JSON.stringify(imageDraft.inputs?.[parameter.id] ?? parameter.defaultValue, null, 2)}
                                          onChange={e => handleComfyInputChange(parameter, e.target.value)}
                                        />
                                      ) : (
                                        <input
                                          type={getWorkflowParameterValueType(parameter) === 'number' ? 'number' : 'text'}
                                          className="params-card__input"
                                          value={imageDraft.inputs?.[parameter.id] ?? ''}
                                          onChange={e => handleComfyInputChange(parameter, e.target.value)}
                                        />
                                      )}

                                      <span className="image-card__param-hint">
                                        {parameter.label} • default: {formatWorkflowDefaultValue(parameter.defaultValue)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                                  <span className="material-symbols-outlined">tune</span>
                                  <span>This workflow has no exposed parameters. Start it directly.</span>
                                </div>
                              )}

                              <button className="gen-btn" onClick={() => handleGenerateImage(imageDraft)}>
                                <span className="material-symbols-outlined">bolt</span>
                                START WORKFLOW
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="image-card__asset-picker-empty">
                            <span className="material-symbols-outlined">account_tree</span>
                            <span>No imported workflows available. Open the Library page to import one.</span>
                          </div>
                        )}
                        <button className="kanban-sidebar__nav-item" onClick={() => openImageSourceMenu(imageDraft?.cardId || null)} style={{ justifyContent: 'center' }}>BACK</button>
                      </div>
                    )}

                    {imageDraft.mode === 'api' && (
                      <div className="image-card__options">
                        <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>REMOTE API</span>
                        <select 
                          className="api-select"
                          value={imageDraft.selectedApi}
                          onChange={e => setImageDraft({...imageDraft, selectedApi: e.target.value})}
                        >
                          {combinedApis.map(api => (
                            <option key={api.id} value={api.id}>{api.name}</option>
                          ))}
                        </select>
                        
                        <div className="gen-section">
                          <textarea 
                            className="gen-prompt-input" 
                            placeholder="What should we generate?"
                            value={imageDraft.prompt}
                            onChange={e => setImageDraft({...imageDraft, prompt: e.target.value})}
                          />
                          <button className="gen-btn" onClick={() => handleGenerateImage(imageDraft)}>
                            <span className="material-symbols-outlined">auto_awesome</span>
                            GENERATE
                          </button>
                        </div>
                        <button className="kanban-sidebar__nav-item" onClick={() => openImageSourceMenu(imageDraft?.cardId || null)} style={{ justifyContent: 'center' }}>BACK</button>
                      </div>
                    )}
                  </div>
                )}

                {pendingImageGeneration && (
                  <div className="image-card image-card--loading" id="image-card-loading">
                    <div className="image-card__thumb image-card__thumb--loading">
                      <div className="image-card__loading-state">
                        <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
                        <span className="font-label image-card__loading-label">Processing image...</span>
                      </div>
                    </div>
                    <div className="image-card__info">
                      <div className="image-card__row">
                        <h3 className="image-card__name">{pendingImageGeneration.title}</h3>
                        <span className="image-card__source image-card__source--loading">PENDING</span>
                      </div>
                      <p className="image-card__meta font-label">{pendingImageGeneration.source} • {pendingImageGeneration.detail}</p>
                    </div>
                  </div>
                )}

                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                  ref={fileInputRef}
                />

                {!imageDraft && !pendingImageGeneration && (
                  <button className="kanban-col__add-btn" id="add-image-btn" onClick={() => openImageSourceMenu()}>
                    <span className="material-symbols-outlined">add_photo_alternate</span>
                    <span className="font-label">ADD NEW IMAGE</span>
                  </button>
                )}
              </div>
            </div>

            {/* ═══ Column 2: Image Edit ═══ */}
            <div className="kanban-col" id="col-imageedit">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--primary)' }}>photo_filter</span>
                  <h2 className="kanban-col__title font-headline">IMAGE EDIT</h2>
                </div>
                <span className="kanban-col__badge font-label">READY</span>
              </div>

              <div className="kanban-col__content">
                <div className="tool-card tool-card--hoverable-primary" id="tool-upscale">
                  <div className="tool-card__header">
                    <div className="tool-card__inline-header">
                      <div className="tool-card__inline-left">
                        <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>high_quality</span>
                        <h3 className="tool-card__name">Upscale</h3>
                      </div>
                      <span className="tool-card__api-badge">API</span>
                    </div>
                  </div>
                  <p className="tool-card__body-text">Enhance source image resolution before mesh generation.</p>
                </div>

                <div className="tool-card tool-card--hoverable-primary" id="tool-background-removal">
                  <div className="tool-card__header">
                    <span className="material-symbols-outlined">layers_clear</span>
                    <h3 className="tool-card__name">Background Removal</h3>
                  </div>
                  <p className="tool-card__body-text">Prepare clean silhouettes and transparent cutouts for generation workflows.</p>
                </div>

                <div className="tool-card tool-card--hoverable-primary" id="tool-image-variations">
                  <div className="tool-card__header">
                    <span className="material-symbols-outlined">auto_fix_high</span>
                    <h3 className="tool-card__name">Variations</h3>
                  </div>
                  <p className="tool-card__body-text">Create alternate renders, lighting passes, or style iterations from an existing image.</p>
                </div>
              </div>
            </div>

            {/* ═══ Column 3: Mesh Generation ═══ */}
            <div className="kanban-col" id="col-meshgen">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--secondary)' }}>deployed_code</span>
                  <h2 className="kanban-col__title font-headline">MESH GEN</h2>
                </div>
                <span className="kanban-col__badge kanban-col__badge--secondary font-label">
                  {tasks.some(t => t.status === 'processing') ? 'PROCESSING' : 'READY'}
                </span>
              </div>

              <div className="kanban-col__content">
                {/* Parameters Card */}
                <div className="params-card params-card--secondary" id="meshgen-params">
                  <div className="params-card__header">
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>settings_input_component</span>
                    <span className="params-card__title font-label">PARAMETERS</span>
                  </div>

                  <div className="params-card__body">
                    <div className="params-card__field">
                      <label className="params-card__label font-label">Generation Seed</label>
                      <input
                        type="text"
                        className="params-card__input params-card__input--seed"
                        value={genSeed}
                        onChange={(e) => setGenSeed(e.target.value)}
                        id="gen-seed-input"
                      />
                    </div>

                    <div className="params-card__row">
                      <div className="params-card__field">
                        <label className="params-card__label font-label">Face Count</label>
                        <input
                          type="number"
                          className="params-card__input"
                          value={faceCount}
                          onChange={(e) => setFaceCount(e.target.value)}
                          id="face-count-input"
                        />
                      </div>
                      <div className="params-card__field">
                        <label className="params-card__label font-label">Mesh Batch</label>
                        <input
                          type="number"
                          className="params-card__input"
                          value={meshBatch}
                          onChange={(e) => setMeshBatch(e.target.value)}
                          id="mesh-batch-input"
                        />
                      </div>
                    </div>

                    <div className="params-card__engine">
                      <span className="params-card__engine-label">Processing Engine</span>
                      <div className="params-card__toggle-group">
                        <button
                          className={`params-card__toggle ${processEngine === 'api' ? 'params-card__toggle--active-secondary' : ''}`}
                          onClick={() => setProcessEngine('api')}
                          id="engine-api-btn"
                        >API</button>
                        <button
                          className={`params-card__toggle ${processEngine === 'comfy' ? 'params-card__toggle--active-secondary' : ''}`}
                          onClick={() => setProcessEngine('comfy')}
                          id="engine-comfy-btn"
                        >COMFY</button>
                      </div>
                    </div>
                  </div>

                  <button className="params-card__action params-card__action--secondary" id="generate-mesh-btn" onClick={handleGenerateMesh}>
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>bolt</span>
                    GENERATE MESH
                  </button>
                </div>

                {/* Active Tasks */}
                {tasks.map(task => (
                  <div key={task.id} className="task-card" id={`task-card-${task.id}`}>
                    <div className="task-card__progress-bar">
                      <div className="task-card__progress-fill" style={{ width: `${task.progress}%` }} />
                    </div>
                    <div className="task-card__header">
                      <span className="task-card__name">Task: {task.name}</span>
                      <span className="task-card__pct">{task.progress}%</span>
                    </div>
                    <p className="task-card__status">{task.status === 'processing' ? 'Processing...' : 'Complete'}</p>
                    <div className="task-card__preview">
                      <span className="material-symbols-outlined task-card__preview-icon">
                        {task.status === 'processing' ? 'hourglass_top' : 'check_circle'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ═══ Column 4: Mesh Edit ═══ */}
            <div className="kanban-col" id="col-meshedit">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>edit_square</span>
                  <h2 className="kanban-col__title font-headline">MESH EDIT</h2>
                </div>
                <span className="kanban-col__badge font-label">3 TOOLS</span>
              </div>

              <div className="kanban-col__content">
                {/* 3D Editor */}
                <div className="tool-card" id="tool-3d-editor">
                  <div className="tool-card__header">
                    <div className="tool-card__icon tool-card__icon--primary">
                      <span className="material-symbols-outlined">view_in_ar</span>
                    </div>
                    <div>
                      <h3 className="tool-card__name">3D Editor</h3>
                      <p className="tool-card__desc">Native vertex manipulator</p>
                    </div>
                  </div>
                  <div className="tool-card__viewport" style={{ height: '200px', padding: '0', overflow: 'hidden' }}>
                    <Viewer height="200px" />
                    <div className="tool-card__viewport-label">
                      LIVE VIEWPORT
                    </div>
                  </div>
                </div>

                {/* AI Simplify */}
                <div className="tool-card tool-card--hoverable-tertiary" id="tool-ai-simplify">
                  <div className="tool-card__header">
                    <div className="tool-card__inline-header">
                      <div className="tool-card__inline-left">
                        <span className="material-symbols-outlined" style={{ color: 'var(--tertiary)' }}>compress</span>
                        <h3 className="tool-card__name">AI Simplify</h3>
                      </div>
                      <span className="tool-card__api-badge tool-card__api-badge--tertiary">API</span>
                    </div>
                  </div>
                  <p className="tool-card__body-text">Intelligent decimation preserving silhouette topology. Best for game assets.</p>
                </div>

                {/* Remeshing */}
                <div className="tool-card tool-card--hoverable-primary" id="tool-remeshing">
                  <div className="tool-card__header">
                    <span className="material-symbols-outlined">rebase_edit</span>
                    <h3 className="tool-card__name">Remeshing</h3>
                  </div>
                  <p className="tool-card__body-text">Quadriflow or Instant Meshes conversion logic.</p>
                </div>
              </div>
            </div>

            {/* ═══ Column 5: Texturing ═══ */}
            <div className="kanban-col" id="col-texturing">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--tertiary)' }}>texture</span>
                  <h2 className="kanban-col__title font-headline">TEXTURING</h2>
                </div>
                <span className="kanban-col__badge font-label">READY</span>
              </div>

              <div className="kanban-col__content">
                {/* Texture Params Card */}
                <div className="params-card params-card--tertiary" id="texturing-params">
                  <div className="params-card__header">
                    <span className="material-symbols-outlined" style={{ fontSize: '14px', color: 'var(--tertiary)' }}>palette</span>
                    <span className="params-card__title font-label">MAP GENERATION</span>
                  </div>

                  <div className="params-card__body">
                    <div className="params-card__field">
                      <label className="params-card__label font-label">Output Resolution</label>
                      <select
                        className="params-card__select"
                        value={texResolution}
                        onChange={(e) => setTexResolution(e.target.value)}
                        id="tex-resolution-select"
                      >
                        <option>1024 x 1024 (1K)</option>
                        <option>2048 x 2048 (2K)</option>
                        <option>4096 x 4096 (4K)</option>
                      </select>
                    </div>

                    <div className="params-card__field">
                      <label className="params-card__label font-label">Engine Configuration</label>
                      <div className="params-card__engine-grid">
                        <button
                          className={`params-card__engine-btn ${texEngine === 'stable' ? 'params-card__engine-btn--active-tertiary' : ''}`}
                          onClick={() => setTexEngine('stable')}
                          id="tex-engine-stable"
                        >STABLE API</button>
                        <button
                          className={`params-card__engine-btn ${texEngine === 'comfy' ? 'params-card__engine-btn--active-tertiary' : ''}`}
                          onClick={() => setTexEngine('comfy')}
                          id="tex-engine-comfy"
                        >COMFYUI</button>
                      </div>
                    </div>

                    <div className="params-card__checkboxes">
                      <label className="params-card__checkbox-label">
                        <div className={`params-card__checkbox ${pbrEnabled ? 'params-card__checkbox--checked' : ''}`} onClick={() => setPbrEnabled(!pbrEnabled)}>
                          {pbrEnabled && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>PBR Map Set (Diff, Norm, Rough)</span>
                      </label>
                      <label className={`params-card__checkbox-label ${!aoEnabled ? 'params-card__checkbox-label--dim' : ''}`}>
                        <div className={`params-card__checkbox ${aoEnabled ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => setAoEnabled(!aoEnabled)}>
                          {aoEnabled && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                        </div>
                        <span>Bake Ambient Occlusion</span>
                      </label>
                    </div>
                  </div>

                  <button className="params-card__action params-card__action--tertiary" id="start-texturing-btn">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>brush</span>
                    START TEXTURING
                  </button>
                </div>

                {/* Recent Presets */}
                <div className="presets-card" id="recent-presets">
                  <span className="presets-card__title font-label">RECENT PRESETS</span>
                  <div className="presets-card__tags">
                    <div className="presets-card__tag">Cybermetal_01</div>
                    <div className="presets-card__tag">Procedural_Grip</div>
                    <div className="presets-card__tag">Organic_Skin_v2</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
