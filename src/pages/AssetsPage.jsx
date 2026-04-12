import { useCallback, useEffect, useRef, useState } from 'react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import './AssetsPage.css'

const ASSETS_PER_PAGE = 20
const ASSET_SECTIONS = [
  {
    key: 'images',
    label: 'Images',
    icon: 'image',
    path: 'assets/images',
    emptyIcon: 'image_not_supported',
    emptyMessage: 'No images found in `assets/images`.'
  },
  {
    key: 'meshes',
    label: 'Meshes',
    icon: 'deployed_code',
    path: 'assets/meshes',
    emptyIcon: 'deployed_code',
    emptyMessage: 'No meshes found in `assets/meshes`.'
  }
]

export default function AssetsPage() {
  const { getLibraryAssets, importLibraryAssets } = useProjects()
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [] })
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [activeSection, setActiveSection] = useState('images')
  const [currentPage, setCurrentPage] = useState(1)
  const [importing, setImporting] = useState(false)
  const [importFeedback, setImportFeedback] = useState(null)
  const fileInputRef = useRef(null)

  const loadLibrary = useCallback(async () => {
    try {
      const data = await getLibraryAssets()
      setLibraryAssets(data)
    } catch (err) {
      console.error('Failed to load assets library:', err)
    } finally {
      setLoading(false)
    }
  }, [getLibraryAssets])

  useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

  useEffect(() => {
    setCurrentPage(1)
  }, [activeSection])

  const activeConfig = ASSET_SECTIONS.find(section => section.key === activeSection) || ASSET_SECTIONS[0]
  const activeAssets = libraryAssets[activeConfig.key] || []
  const totalPages = Math.max(1, Math.ceil(activeAssets.length / ASSETS_PER_PAGE))
  const pageStart = (currentPage - 1) * ASSETS_PER_PAGE
  const paginatedAssets = activeAssets.slice(pageStart, pageStart + ASSETS_PER_PAGE)
  const pageRangeStart = activeAssets.length === 0 ? 0 : pageStart + 1
  const pageRangeEnd = Math.min(pageStart + ASSETS_PER_PAGE, activeAssets.length)

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleImportChange = async (event) => {
    const files = Array.from(event.target.files || [])

    if (files.length === 0) {
      return
    }

    setImporting(true)
    setImportFeedback(null)

    try {
      const result = await importLibraryAssets(files)
      await loadLibrary()

      const importedCount = result.imported?.length || 0
      const skippedCount = result.skipped?.length || 0

      setImportFeedback({
        type: skippedCount > 0 ? 'warning' : 'success',
        message: skippedCount > 0
          ? `Imported ${importedCount} assets. ${skippedCount} files were skipped.`
          : `Imported ${importedCount} assets.`
      })
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to import assets.'
      })
    } finally {
      setImporting(false)
      event.target.value = ''
    }
  }

  return (
    <div className="assets-layout">
      <Header showSearch onSettingsClick={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="assets-page">
        <div className="assets-page__container">
          <div className="assets-page__header">
            <div>
              <h1 className="assets-page__title font-headline">Assets Library</h1>
              <p className="assets-page__desc">Browse and import local files stored in `assets/images` and `assets/meshes`.</p>
            </div>
            <div className="assets-page__header-actions">
              <div className="assets-page__stats">
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">image</span>
                  <span>{libraryAssets.images.length} Images</span>
                </div>
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">deployed_code</span>
                  <span>{libraryAssets.meshes.length} Meshes</span>
                </div>
              </div>
              <button type="button" className="assets-page__import-btn" onClick={handleImportClick} disabled={importing}>
                <span className="material-symbols-outlined">upload_file</span>
                <span>{importing ? 'Importing...' : 'Import'}</span>
              </button>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="assets-page__file-input"
            accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.glb,.gltf,.obj,.fbx,.stl,.ply"
            onChange={handleImportChange}
          />

          {loading ? (
            <div className="assets-page__loading">
              <span className="material-symbols-outlined assets-page__spinner">progress_activity</span>
              <span>Loading asset folders...</span>
            </div>
          ) : (
            <div className="assets-page__content">
              <aside className="assets-sidebar">
                {ASSET_SECTIONS.map(section => (
                  <button
                    key={section.key}
                    type="button"
                    className={`assets-sidebar__item ${activeSection === section.key ? 'assets-sidebar__item--active' : ''}`}
                    onClick={() => setActiveSection(section.key)}
                  >
                    <span className="material-symbols-outlined">{section.icon}</span>
                    <span className="assets-sidebar__label">{section.label}</span>
                    <span className="assets-sidebar__count">{libraryAssets[section.key]?.length || 0}</span>
                  </button>
                ))}
              </aside>

              <section className="assets-section">
                <div className="assets-section__header">
                  <div>
                    <h2 className="assets-section__title font-headline">{activeConfig.label}</h2>
                    <span className="assets-section__path font-label">{activeConfig.path}</span>
                  </div>
                  <div className="assets-section__summary">
                    <span>{activeAssets.length} total assets</span>
                    <span>{pageRangeStart}-{pageRangeEnd || 0} shown</span>
                  </div>
                </div>

                {importFeedback && (
                  <div className={`assets-page__feedback assets-page__feedback--${importFeedback.type}`}>
                    <span className="material-symbols-outlined">
                      {importFeedback.type === 'error' ? 'error' : importFeedback.type === 'warning' ? 'warning' : 'check_circle'}
                    </span>
                    <span>{importFeedback.message}</span>
                  </div>
                )}

                {activeAssets.length > 0 ? (
                  <>
                    <div className={`assets-grid ${activeSection === 'images' ? 'assets-grid--images' : 'assets-grid--meshes'}`}>
                      {paginatedAssets.map(asset => (
                        <article key={asset.id} className={`asset-card ${activeSection === 'images' ? 'asset-card--image' : 'asset-card--mesh'}`}>
                          {activeSection === 'images' ? (
                            <div className="asset-card__preview asset-card__preview--image">
                              <img src={asset.url} alt={asset.name} className="asset-card__image" />
                            </div>
                          ) : (
                            <div className="asset-card__preview asset-card__preview--mesh">
                              <span className="material-symbols-outlined asset-card__mesh-icon">view_in_ar</span>
                              <span className="asset-card__mesh-label font-label">3D MESH</span>
                            </div>
                          )}
                          <div className="asset-card__body">
                            <h3 className="asset-card__name">{asset.name}</h3>
                            <div className="asset-card__meta">
                              <span className={`asset-card__badge ${activeSection === 'meshes' ? 'asset-card__badge--secondary' : ''}`}>{asset.extension}</span>
                              <a href={asset.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>

                    <div className="assets-pagination">
                      <div className="assets-pagination__summary">
                        Showing {pageRangeStart}-{pageRangeEnd} of {activeAssets.length}
                      </div>
                      <div className="assets-pagination__controls">
                        <button type="button" className="assets-pagination__button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={currentPage === 1}>
                          Previous
                        </button>
                        <span className="assets-pagination__page">Page {currentPage} / {totalPages}</span>
                        <button type="button" className="assets-pagination__button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={currentPage === totalPages}>
                          Next
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="assets-page__empty-state">
                    <span className="material-symbols-outlined">{activeConfig.emptyIcon}</span>
                    <span>{activeConfig.emptyMessage}</span>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  )
}
