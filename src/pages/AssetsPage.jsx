import { useEffect, useState } from 'react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import './AssetsPage.css'

export default function AssetsPage() {
  const { getLibraryAssets } = useProjects()
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [] })
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    async function loadLibrary() {
      try {
        const data = await getLibraryAssets()
        setLibraryAssets(data)
      } catch (err) {
        console.error('Failed to load assets library:', err)
      } finally {
        setLoading(false)
      }
    }

    loadLibrary()
  }, [getLibraryAssets])

  return (
    <div className="assets-layout">
      <Header showSearch onSettingsClick={() => setShowSettings(true)} />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="assets-page">
        <div className="assets-page__container">
          <div className="assets-page__header">
            <div>
              <h1 className="assets-page__title font-headline">Assets Library</h1>
              <p className="assets-page__desc">Browse local files stored in `assets/images` and `assets/meshes`.</p>
            </div>
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
          </div>

          {loading ? (
            <div className="assets-page__loading">
              <span className="material-symbols-outlined assets-page__spinner">progress_activity</span>
              <span>Loading asset folders...</span>
            </div>
          ) : (
            <>
              <section className="assets-section">
                <div className="assets-section__header">
                  <h2 className="assets-section__title font-headline">Images</h2>
                  <span className="assets-section__path font-label">assets/images</span>
                </div>

                {libraryAssets.images.length > 0 ? (
                  <div className="assets-grid assets-grid--images">
                    {libraryAssets.images.map(image => (
                      <article key={image.id} className="asset-card asset-card--image">
                        <div className="asset-card__preview asset-card__preview--image">
                          <img src={image.url} alt={image.name} className="asset-card__image" />
                        </div>
                        <div className="asset-card__body">
                          <h3 className="asset-card__name">{image.name}</h3>
                          <div className="asset-card__meta">
                            <span className="asset-card__badge">{image.extension}</span>
                            <a href={image.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="assets-page__empty-state">
                    <span className="material-symbols-outlined">image_not_supported</span>
                    <span>No images found in `assets/images`.</span>
                  </div>
                )}
              </section>

              <section className="assets-section">
                <div className="assets-section__header">
                  <h2 className="assets-section__title font-headline">Meshes</h2>
                  <span className="assets-section__path font-label">assets/meshes</span>
                </div>

                {libraryAssets.meshes.length > 0 ? (
                  <div className="assets-grid assets-grid--meshes">
                    {libraryAssets.meshes.map(mesh => (
                      <article key={mesh.id} className="asset-card asset-card--mesh">
                        <div className="asset-card__preview asset-card__preview--mesh">
                          <span className="material-symbols-outlined asset-card__mesh-icon">view_in_ar</span>
                          <span className="asset-card__mesh-label font-label">3D MESH</span>
                        </div>
                        <div className="asset-card__body">
                          <h3 className="asset-card__name">{mesh.name}</h3>
                          <div className="asset-card__meta">
                            <span className="asset-card__badge asset-card__badge--secondary">{mesh.extension}</span>
                            <a href={mesh.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="assets-page__empty-state">
                    <span className="material-symbols-outlined">deployed_code</span>
                    <span>No meshes found in `assets/meshes`.</span>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>

      <Footer />
    </div>
  )
}
