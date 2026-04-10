import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import Header from '../components/Header'
import Footer from '../components/Footer'
import './KanbanPage.css'

const SIDEBAR_ITEMS = [
  { id: 'images', icon: 'image', label: 'Images' },
  { id: 'meshgen', icon: 'deployed_code', label: 'Mesh Gen', filled: true },
  { id: 'meshedit', icon: 'edit_square', label: 'Mesh Edit' },
  { id: 'texturing', icon: 'texture', label: 'Texturing' },
]

const SAMPLE_IMAGES = [
  {
    id: 'img_1',
    name: 'Neon Fractal_01',
    resolution: '2048 x 2048',
    format: 'PNG',
    source: 'AI GEN',
    color: 'var(--primary)',
  },
  {
    id: 'img_2',
    name: 'Reference_Plate_A',
    resolution: '1024 x 1024',
    format: 'JPG',
    source: 'IMPORT',
    color: 'var(--on-surface-variant)',
  },
]

export default function KanbanPage() {
  const { projectId } = useParams()
  const { getProject } = useProjects()
  const project = getProject(projectId)
  const [activeTab, setActiveTab] = useState('meshgen')
  const [genSeed, setGenSeed] = useState('8841295201')
  const [faceCount, setFaceCount] = useState('15000')
  const [meshBatch, setMeshBatch] = useState('1')
  const [processEngine, setProcessEngine] = useState('api')
  const [texResolution, setTexResolution] = useState('2048 x 2048 (2K)')
  const [texEngine, setTexEngine] = useState('stable')
  const [pbrEnabled, setPbrEnabled] = useState(true)
  const [aoEnabled, setAoEnabled] = useState(false)

  return (
    <div className="kanban-layout">
      <Header showSearch showCreateNew />

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

            <button className="kanban-sidebar__new-asset" id="new-asset-btn">
              <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
              <span className="font-label">NEW ASSET</span>
            </button>
          </nav>

          <div className="kanban-sidebar__bottom">
            <a href="#" className="kanban-sidebar__link">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>menu_book</span>
              Docs
            </a>
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
                <span className="kanban-col__badge font-label">04 ITEMS</span>
              </div>

              <div className="kanban-col__content">
                {SAMPLE_IMAGES.map(img => (
                  <div key={img.id} className="image-card" id={`image-card-${img.id}`}>
                    <div className="image-card__thumb">
                      <div className="image-card__thumb-placeholder">
                        <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>image</span>
                      </div>
                    </div>
                    <div className="image-card__info">
                      <div className="image-card__row">
                        <h3 className="image-card__name">{img.name}</h3>
                        <span
                          className="image-card__source"
                          style={{
                            color: img.source === 'AI GEN' ? 'var(--primary)' : 'var(--on-surface-variant)',
                            background: img.source === 'AI GEN' ? 'rgba(143,245,255,0.1)' : 'rgba(71,72,74,0.2)',
                          }}
                        >
                          {img.source}
                        </span>
                      </div>
                      <p className="image-card__meta font-label">{img.resolution} • {img.format}</p>
                    </div>
                  </div>
                ))}

                <button className="kanban-col__add-btn" id="add-image-btn">
                  <span className="material-symbols-outlined">upload_file</span>
                  <span className="font-label">ADD NEW IMAGE</span>
                </button>
              </div>
            </div>

            {/* ═══ Column 2: Mesh Generation ═══ */}
            <div className="kanban-col" id="col-meshgen">
              <div className="kanban-col__header">
                <div className="kanban-col__title-group">
                  <span className="material-symbols-outlined" style={{ fontSize: '18px', color: 'var(--secondary)' }}>deployed_code</span>
                  <h2 className="kanban-col__title font-headline">MESH GEN</h2>
                </div>
                <span className="kanban-col__badge kanban-col__badge--secondary font-label">PROCESSING</span>
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

                  <button className="params-card__action params-card__action--secondary" id="generate-mesh-btn">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>bolt</span>
                    GENERATE MESH
                  </button>
                </div>

                {/* Active Task */}
                <div className="task-card" id="active-task">
                  <div className="task-card__progress-bar">
                    <div className="task-card__progress-fill" style={{ width: '64%' }} />
                  </div>
                  <div className="task-card__header">
                    <span className="task-card__name">Task: Mesh_Synth_4</span>
                    <span className="task-card__pct">64%</span>
                  </div>
                  <p className="task-card__status">Initializing vertex buffers...</p>
                  <div className="task-card__preview">
                    <span className="material-symbols-outlined task-card__preview-icon">hourglass_top</span>
                  </div>
                </div>
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
                  <div className="tool-card__viewport">
                    <span className="material-symbols-outlined" style={{ fontSize: '40px', color: 'rgba(253,251,254,0.06)' }}>grid_view</span>
                    <div className="tool-card__viewport-label">
                      OPEN VIEWPORT
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
