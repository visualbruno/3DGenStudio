import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext'
import Header from '../components/Header'
import Footer from '../components/Footer'
import Viewer from '../components/Viewer'
import SettingsModal from '../components/SettingsModal'
import './KanbanPage.css'

const SIDEBAR_ITEMS = [
  { id: 'images', icon: 'image', label: 'Images' },
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

export default function KanbanPage() {
  const { projectId } = useParams()
  const { getProject, getProjectAssets, getProjectTasks, uploadAsset, createTask } = useProjects()
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
  const fileInputRef = useRef(null)

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

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      setLoading(true);
      await uploadAsset(projectId, file, 'image', {
        resolution: 'Unknown',
        format: file.type.split('/')[1]?.toUpperCase() || 'IMG',
        source: 'IMPORT'
      });
      // Refresh assets
      const assetsData = await getProjectAssets(projectId);
      setAssets(assetsData);
      setImageDraft(null); // Close draft
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateImage = async (draft) => {
    // Placeholder for actual generation logic
    console.log('Generating image with:', draft);
    alert(`Generating image using ${draft.selectedApi || draft.workflow}...`);
    setImageDraft(null);
  };

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
                <span className="kanban-col__badge font-label">{images.length.toString().padStart(2, '0')} ITEMS</span>
              </div>

              <div className="kanban-col__content">
                {images.map(img => (
                  <div key={img.id} className="image-card" id={`image-card-${img.id}`}>
                    <div className="image-card__thumb">
                      {img.filename ? (
                        <img 
                          src={`http://localhost:3001/assets/${img.filename}`} 
                          alt={img.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <div className="image-card__thumb-placeholder">
                          <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>image</span>
                        </div>
                      )}
                    </div>
                    <div className="image-card__info">
                      <div className="image-card__row">
                        <h3 className="image-card__name">{img.name}</h3>
                        <span
                          className="image-card__source"
                          style={{
                            color: img.metadata?.source === 'AI GEN' ? 'var(--primary)' : 'var(--on-surface-variant)',
                            background: img.metadata?.source === 'AI GEN' ? 'rgba(143,245,255,0.1)' : 'rgba(71,72,74,0.2)',
                          }}
                        >
                          {img.metadata?.source || 'IMPORT'}
                        </span>
                      </div>
                      <p className="image-card__meta font-label">{img.metadata?.resolution || 'N/A'} • {img.metadata?.format || 'N/A'}</p>
                    </div>
                  </div>
                ))}

                {/* DRAFT IMAGE CARD */}
                {imageDraft && (
                  <div className="image-card image-card--draft">
                    {imageDraft.mode === 'select' && (
                      <div className="image-card__options">
                        <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>IMAGE SOURCE</span>
                        <button className="option-btn" onClick={() => fileInputRef.current.click()}>
                          <span className="material-symbols-outlined">computer</span>
                          Local Computer
                        </button>
                        <button className="option-btn" onClick={() => setImageDraft({ mode: 'comfy', workflow: 'default_v1.json' })}>
                          <span className="material-symbols-outlined">account_tree</span>
                          ComfyUI Workflow
                        </button>
                        <button className="option-btn" onClick={() => setImageDraft({ mode: 'api', selectedApi: 'nanobana', prompt: '' })}>
                          <span className="material-symbols-outlined">api</span>
                          Remote API
                        </button>
                        <button className="kanban-sidebar__nav-item" onClick={() => setImageDraft(null)} style={{ marginTop: '0.5rem', justifyContent: 'center' }}>CANCEL</button>
                      </div>
                    )}

                    {imageDraft.mode === 'comfy' && (
                      <div className="image-card__options">
                        <span className="font-label" style={{ fontSize: '0.65rem', color: 'var(--primary)', marginBottom: '0.5rem' }}>COMFYUI SELECTION</span>
                        <select 
                          className="params-card__select"
                          value={imageDraft.workflow}
                          onChange={e => setImageDraft({...imageDraft, workflow: e.target.value})}
                        >
                          <option>default_v1.json</option>
                          <option>portrait_studio.json</option>
                          <option>concept_art_v2.json</option>
                        </select>
                        <div className="gen-section">
                          <textarea 
                            className="gen-prompt-input" 
                            placeholder="Positive prompt..."
                            value={imageDraft.prompt || ''}
                            onChange={e => setImageDraft({...imageDraft, prompt: e.target.value})}
                          />
                          <button className="gen-btn" onClick={() => handleGenerateImage(imageDraft)}>
                            <span className="material-symbols-outlined">bolt</span>
                            START WORKFLOW
                          </button>
                        </div>
                        <button className="kanban-sidebar__nav-item" onClick={() => setImageDraft({ mode: 'select' })} style={{ justifyContent: 'center' }}>BACK</button>
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
                        <button className="kanban-sidebar__nav-item" onClick={() => setImageDraft({ mode: 'select' })} style={{ justifyContent: 'center' }}>BACK</button>
                      </div>
                    )}
                  </div>
                )}

                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                  ref={fileInputRef}
                />

                {!imageDraft && (
                  <button className="kanban-col__add-btn" id="add-image-btn" onClick={() => setImageDraft({ mode: 'select' })}>
                    <span className="material-symbols-outlined">add_photo_alternate</span>
                    <span className="font-label">ADD NEW IMAGE</span>
                  </button>
                )}
              </div>
            </div>

            {/* ═══ Column 2: Mesh Generation ═══ */}
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

            {/* ═══ Column 3: Mesh Edit ═══ */}
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

            {/* ═══ Column 4: Texturing ═══ */}
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
