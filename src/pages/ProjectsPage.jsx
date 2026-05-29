import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import { useSettings } from '../context/SettingsContext.shared'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import SetupWizardModal from '../components/SetupWizardModal'
import './ProjectsPage.css'

const PRESETS = [
  'Kanban',
  'Graph',
]

const STATUS_MAP = {
  active: { label: 'Active', className: 'project-card__status--active' },
  processing: { label: 'Processing', className: 'project-card__status--processing' },
  complete: { label: 'Complete', className: 'project-card__status--complete' },
}

const CHANGE_LOG_ENTRIES = [
  {
    version: 'v1.0.0',
    date: '2026-05-29',
    items: [
			'Initial Setup: Download the models and configure automatically the workflows',
			'Wiki: First version of a documentation'
    ],
  },
  {
    version: 'v0.9.2',
    date: '2026-05-23',
    items: [
			'Mesh Editor: In Projection mode, can send Textured/Untextured view to ComfyUI',
			'Project: Fixed Delete Project'
    ],
  },
  {
    version: 'v0.9.1',
    date: '2026-05-21',
    items: [
      'Kanban Page: Fixed bug of Untitled asset because of ComfyUI crash',
			'Workflows: Fixed bug of the output not respected',
			'Kanban Page: Fixed bug, in case of success of ComfyUI without anything returned',
			'Kanban Page: Added Edit button to open the Mesh Editor for a mesh',
			'Kanban Page: Cards are unblocked at startup',
			'Graph Page: Fixed bug -> some workflows were not available in the dropdown',
			'MeshEditor/MeshPreview: Added a Albedo/PBR button'
    ],
  },
  {
    version: 'v0.9.0',
    date: '2026-05-20',
    items: [
      'Mesh Editor: New Projection Mode',
			'Mesh Editor: Renamed Boolean mode by Displace'
    ],
  },
  {
    version: 'v0.8.1',
    date: '2026-05-15',
    items: [
      'Mesh Editor: Fixed modifications applied between modes',
    ],
  },
  {
    version: 'v0.8.0',
    date: '2026-05-14',
    items: [
      'Mesh Editor: Added a new Boolean mode',
			'Mesh Editor: Fixed Texturing',
			'Assets Page: Fixed image ratio'
    ],
  },
  {
    version: 'v0.7.1',
    date: '2026-05-07',
    items: [
      'Image Editor: Added an experimental Shadow Remover',
			'Image Editor: Can draw and erase the Base Layer',
			'Image Editor: Improved Crop UI',
			'Graph Page: Can drag output connector to the workflow to display the list of nodes',			
			'Notifications: Display errors in notifications panel',
			'Fixed: Imported images in DB'
    ],
  },
  {
    version: 'v0.7.0',
    date: '2026-05-05',
    items: [
      'Can generate Mesh using Tencent Cloud and Tripo AI',
			'Image Editor : Added Zoom-In/Out feature'
    ],
  },
  {
    version: 'v0.6.0',
    date: '2026-05-04',
    items: [
      'New Image Editor',
    ],
  },
  {
    version: 'v0.5.0',
    date: '2026-05-03',
    items: [
      'Support of abr file (Adobe Brush)',
			'Mesh Editor: Fixed brush color',
			'Mesh Editor: Fixed brush size',
			'Mesh Editor: Fixed brush orientation'
    ],
  },
  {
    version: 'v0.4.1',
    date: '2026-05-03',
    items: [
      'Graph Page: Improved performances',
			'Mesh Editor - Painting mode: Fixed regression when drawing an image'
    ],
  },
  {
    version: 'v0.4.0',
    date: '2026-05-02',
    items: [
      'Mesh Editor: New Sculpting mode',
			'Search Assets implemented',
			'Improved Modeling mode in Mesh Editor'
    ],
  },
  {
    version: 'v0.3.1',
    date: '2026-04-30',
    items: [
      'Mesh Editor - Painting mode: Layer selection, so we can continue to draw on it',
			'Mesh Editor - Painting mode: Can erase the layer using a brush',
			'Mesh Editor - Painting mode: Fixed drawing on UV seams'
    ],
  },
  {
    version: 'v0.3.0',
    date: '2026-04-29',
    items: [
      'Added Painting mode MeshEditor',
			'Improve Texturing mode in MeshEditor'
    ],
  },
  {
    version: 'v0.2.3',
    date: '2026-04-28',
    items: [
      'Added AssetSelector Dialog',
			'MeshEditor: Added dropdowns for the inputs',
			'Added real system metrics in the footer',
			'Improved loading time in Mesh Editor',
			'Fixed parent in Graph mode'
    ],
  },
  {
    version: 'v0.2.2',
    date: '2026-04-27',
    items: [
      'Improved Inpainting in Mesh Editor',
			'Supports MultiView Projection'
    ],
  },
  {
    version: 'v0.2.1',
    date: '2026-04-25',
    items: [
      'Improved the details of Inpainting in Mesh Editor',
			'Added controls for inpainting result'
    ],
  },
  {
    version: 'v0.2.0',
    date: '2026-04-24',
    items: [
      'Added Inpainting function in Mesh Editor',
			'Added ComfyUI workflow examples'
    ],
  },
  {
    version: 'v0.1.1',
    date: '2026-04-21',
    items: [
      'Added Graph Node "Image Compare"',
      'Improved a bit the Mesh Editor (not good yet)',
    ],
  },
  {
    version: 'v0.1.0',
    date: '2026-04-19',
    items: [
      'Improved import for ComfyUI workflows',
      'Added a draft version of Mesh Editor',
    ],
  },
  {
    version: 'v0.1.0',
    date: '2026-04-19',
    items: [
      'First release',
    ],
  },
]

export default function ProjectsPage() {
  const { projects, createProject, deleteProject } = useProjects()
  const { settings, loading: settingsLoading } = useSettings()
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [showChangeLog, setShowChangeLog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [setupManualOpen, setSetupManualOpen] = useState(false)
  const [setupDismissed, setSetupDismissed] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState(null)

  const showSetup = setupManualOpen
    || (!settingsLoading && !settings?.initialSetupComplete && !setupDismissed)

  const closeSetup = () => {
    setSetupManualOpen(false)
    setSetupDismissed(true)
  }
  const openSetup = () => {
    setSetupDismissed(false)
    setSetupManualOpen(true)
  }
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    preset: PRESETS[0],
  })

  const handleConfirmDelete = async (deleteAssets) => {
    if (!projectToDelete) return
    const id = projectToDelete.id
    setProjectToDelete(null)
    await deleteProject(id, { deleteAssets })
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!formData.name.trim()) return
    const created = await createProject(formData)
    setFormData({ name: '', description: '', preset: PRESETS[0] })
    setShowCreate(false)
    navigate(`/projects/${created.id}`)
  }

  const formatDate = (isoStr) => {
    const d = new Date(isoStr)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="projects-layout">
      <Header onSettingsClick={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {showSetup && (
        <SetupWizardModal
          onClose={closeSetup}
          onComplete={closeSetup}
        />
      )}

      <main className="projects-page">
        {/* Hero / Create Modal */}
        {showCreate && (
          <div className="projects-page__modal-overlay" onClick={() => setShowCreate(false)}>
            <div className="projects-page__modal" onClick={(e) => e.stopPropagation()}>
              {/* Glow */}
              <div className="projects-page__modal-glow" />

              <div className="projects-page__modal-header">
                <h1 className="projects-page__modal-title font-headline">Create New Project</h1>
                <p className="projects-page__modal-desc">Initialize a new 3D workspace and generation pipeline.</p>
              </div>

              <form className="projects-page__form" onSubmit={handleCreate} id="create-project-form">
                <div className="projects-page__field">
                  <label className="projects-page__label font-label" htmlFor="project-name">Project Name</label>
                  <div className="projects-page__input-wrap">
                    <input
                      id="project-name"
                      type="text"
                      className="projects-page__input"
                      placeholder="e.g. Cyberpunk_District_V1"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      autoFocus
                    />
                    <div className="projects-page__input-underline" />
                  </div>
                </div>

                <div className="projects-page__field">
                  <label className="projects-page__label font-label" htmlFor="project-desc">Description</label>
                  <textarea
                    id="project-desc"
                    className="projects-page__textarea"
                    placeholder="Define the creative scope..."
                    rows="3"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>

                <div className="projects-page__field">
                  <label className="projects-page__label font-label" htmlFor="project-preset">Select Preset</label>
                  <div className="projects-page__select-wrap">
                    <select
                      id="project-preset"
                      className="projects-page__select"
                      value={formData.preset}
                      onChange={(e) => setFormData({ ...formData, preset: e.target.value })}
                    >
                      {PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <span className="material-symbols-outlined projects-page__select-icon">expand_more</span>
                  </div>
                </div>

                <div className="projects-page__form-actions">
                  <button type="submit" className="projects-page__btn-primary" id="submit-create-project">
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add_circle</span>
                    Create Project
                  </button>
                  <button
                    type="button"
                    className="projects-page__btn-secondary"
                    onClick={() => setShowCreate(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>

              {/* System Info */}
              <div className="projects-page__sys-info">
                <div className="projects-page__sys-item">
                  <div className="projects-page__sys-icon projects-page__sys-icon--secondary">
                    <span className="material-symbols-outlined filled" style={{ fontSize: '16px' }}>deployed_code</span>
                  </div>
                  <div>
                    <span className="projects-page__sys-label font-label">Engine</span>
                    <span className="projects-page__sys-value">Synthesis V4.2</span>
                  </div>
                </div>
                <div className="projects-page__sys-item">
                  <div className="projects-page__sys-icon projects-page__sys-icon--tertiary">
                    <span className="material-symbols-outlined filled" style={{ fontSize: '16px' }}>memory</span>
                  </div>
                  <div>
                    <span className="projects-page__sys-label font-label">Allocated GPU</span>
                    <span className="projects-page__sys-value">24GB VRAM</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {projectToDelete && (
          <div className="projects-page__modal-overlay" onClick={() => setProjectToDelete(null)}>
            <div className="projects-page__modal" onClick={(e) => e.stopPropagation()}>
              <div className="projects-page__modal-glow" />

              <div className="projects-page__modal-header">
                <h1 className="projects-page__modal-title font-headline">Delete Project</h1>
                <p className="projects-page__modal-desc">
                  Delete <strong>{projectToDelete.name}</strong>? Its assets (images, meshes) that aren&apos;t shared with another project can also be deleted.
                </p>
              </div>

              <div className="projects-page__form-actions">
                <button
                  type="button"
                  className="projects-page__btn-primary"
                  onClick={() => handleConfirmDelete(true)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>delete_forever</span>
                  Delete project & assets
                </button>
                <button
                  type="button"
                  className="projects-page__btn-secondary"
                  onClick={() => handleConfirmDelete(false)}
                >
                  Delete project only
                </button>
                <button
                  type="button"
                  className="projects-page__btn-secondary"
                  onClick={() => setProjectToDelete(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {showChangeLog && (
          <div className="projects-page__modal-overlay" onClick={() => setShowChangeLog(false)}>
            <div className="projects-page__modal projects-page__modal--changelog" onClick={(e) => e.stopPropagation()}>
              <div className="projects-page__modal-glow" />

              <div className="projects-page__modal-header projects-page__modal-header--split">
                <div>
                  <h1 className="projects-page__modal-title font-headline">Change Log</h1>
                </div>
                <button
                  type="button"
                  className="projects-page__icon-btn"
                  onClick={() => setShowChangeLog(false)}
                  aria-label="Close change log"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <div className="projects-page__changelog">
                {CHANGE_LOG_ENTRIES.map((entry) => (
                  <section key={entry.version} className="projects-page__changelog-entry">
                    <div className="projects-page__changelog-meta">
                      <span className="projects-page__changelog-version font-label">{entry.version}</span>
                      <span className="projects-page__changelog-date">{entry.date}</span>
                    </div>
                    <ul className="projects-page__changelog-list">
                      {entry.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Projects Grid */}
        <div className="projects-page__container">
          <div className="projects-page__header">
            <div>
              <h1 className="projects-page__page-title font-headline">Your Projects</h1>
              <p className="projects-page__page-desc">{projects.length} workspace{projects.length !== 1 ? 's' : ''} available</p>
            </div>
            <div className="projects-page__header-actions">
              <button className="projects-page__new-btn" onClick={() => setShowCreate(true)} id="open-create-modal">
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
                New Project
              </button>
              <button
                type="button"
                className="projects-page__setup-btn"
                onClick={openSetup}
                id="open-setup-modal"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>settings_suggest</span>
                Setup
              </button>
            </div>
          </div>

          <div className="projects-page__grid">
            {projects.map((project, i) => (
              <div
                key={project.id}
                className="project-card"
                style={{ animationDelay: `${i * 0.08}s` }}
                onClick={() => navigate(`/projects/${project.id}`)}
                id={`project-card-${project.id}`}
              >
                {/* Thumbnail area */}
                <div className="project-card__thumb">
                  <div className="project-card__thumb-inner">
                    <span className="material-symbols-outlined" style={{ fontSize: '40px', color: 'rgba(143, 245, 255, 0.15)' }}>
                      view_in_ar
                    </span>
                  </div>
                  <div className={`project-card__status ${STATUS_MAP[project.status]?.className || ''}`}>
                    {STATUS_MAP[project.status]?.label || project.status}
                  </div>
                </div>

                {/* Info */}
                <div className="project-card__info">
                  <h3 className="project-card__name font-headline">{project.name}</h3>
                  <p className="project-card__desc">{project.description}</p>

                  <div className="project-card__meta">
                    <div className="project-card__meta-item">
                      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>image</span>
                      <span>{project.imageCount} images</span>
                    </div>
                    <div className="project-card__meta-item">
                      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>deployed_code</span>
                      <span>{project.meshCount} meshes</span>
                    </div>
                  </div>

                  <div className="project-card__footer">
                    <span className="project-card__preset font-label">{project.preset}</span>
                    <span className="project-card__date">{formatDate(project.createdAt)}</span>
                  </div>
                </div>

                {/* Delete button */}
                <button
                  className="project-card__delete"
                  onClick={(e) => { e.stopPropagation(); setProjectToDelete(project) }}
                  title="Delete project"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                </button>
              </div>
            ))}

            {/* Empty state */}
            {projects.length === 0 && (
              <div className="projects-page__empty">
                <span className="material-symbols-outlined" style={{ fontSize: '48px', color: 'var(--outline-variant)' }}>
                  folder_off
                </span>
                <p>No projects yet. Create your first workspace.</p>
                <button className="projects-page__new-btn" onClick={() => setShowCreate(true)}>
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
                  Create Project
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      <Footer onChangeLogClick={() => setShowChangeLog(true)} />
    </div>
  )
}
