import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjects } from '../context/ProjectContext'
import Header from '../components/Header'
import Footer from '../components/Footer'
import './ProjectsPage.css'

const PRESETS = [
  'Photorealistic ArchViz',
  'Stylized Game Asset',
  'Rapid Concept Sculpt',
  'Raw Voxel Mesh',
]

const STATUS_MAP = {
  active: { label: 'Active', className: 'project-card__status--active' },
  processing: { label: 'Processing', className: 'project-card__status--processing' },
  complete: { label: 'Complete', className: 'project-card__status--complete' },
}

export default function ProjectsPage() {
  const { projects, createProject, deleteProject } = useProjects()
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    preset: PRESETS[0],
  })

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
      <Header showSearch showCreateNew />

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

        {/* Projects Grid */}
        <div className="projects-page__container">
          <div className="projects-page__header">
            <div>
              <h1 className="projects-page__page-title font-headline">Your Projects</h1>
              <p className="projects-page__page-desc">{projects.length} workspace{projects.length !== 1 ? 's' : ''} available</p>
            </div>
            <button className="projects-page__new-btn" onClick={() => setShowCreate(true)} id="open-create-modal">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
              New Project
            </button>
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
                  onClick={(e) => { e.stopPropagation(); deleteProject(project.id) }}
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

      <Footer />
    </div>
  )
}
