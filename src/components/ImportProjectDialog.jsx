import { useState } from 'react'
import { useProjects } from '../context/ProjectContext'
import FolderBrowserDialog from './FolderBrowserDialog'
import './ProjectIODialog.css'

// Derive a friendly default project name from a selected folder path.
function folderBaseName(folderPath) {
  const cleaned = String(folderPath || '').replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// Import a project from a previously exported .3dgp bundle folder. `onImported`
// receives the newly created project so the caller can navigate to it.
export default function ImportProjectDialog({ onImported, onClose }) {
  const { importProject } = useProjects()
  const [sourceFolder, setSourceFolder] = useState('')
  const [name, setName] = useState('')
  const [showFolderBrowser, setShowFolderBrowser] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  const handleImport = async () => {
    const folder = sourceFolder.trim()
    if (!folder) {
      setError('Choose the exported project folder first.')
      return
    }

    setImporting(true)
    setError('')

    try {
      const project = await importProject({ folder, name: name.trim() })
      onImported?.(project)
    } catch (err) {
      setError(err.message || 'Failed to import the project.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="project-io-overlay" role="presentation" onClick={onClose}>
      <div
        className="project-io"
        role="dialog"
        aria-modal="true"
        aria-label="Import project"
        onClick={event => event.stopPropagation()}
      >
        <div className="project-io__header">
          <h3 className="project-io__title font-headline">Import project</h3>
          <button type="button" className="project-io__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="project-io__body">
          <label className="project-io__field">
            <span className="project-io__label">Source folder (.3dgp)</span>
            <div className="project-io__folder-row">
              <input
                className="project-io__input"
                value={sourceFolder}
                onChange={event => setSourceFolder(event.target.value)}
                placeholder="Choose the exported project folder"
                spellCheck={false}
              />
              <button
                type="button"
                className="project-io__browse"
                onClick={() => setShowFolderBrowser(true)}
              >
                <span className="material-symbols-outlined">folder_open</span>
                Browse
              </button>
            </div>
          </label>

          <label className="project-io__field">
            <span className="project-io__label">Project name</span>
            <input
              className="project-io__input"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="Leave blank to keep the exported name"
              spellCheck={false}
            />
          </label>

          <p className="project-io__hint">
            Select the folder that contains the <code>.3dgp</code> file. All assets are copied in
            as fresh library entries and a brand-new project is created.
          </p>

          {error && <div className="project-io__message project-io__message--error">{error}</div>}
        </div>

        <div className="project-io__actions">
          <button type="button" className="project-io__btn project-io__btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="project-io__btn project-io__btn--primary"
            onClick={handleImport}
            disabled={importing}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>

      {showFolderBrowser && (
        <FolderBrowserDialog
          initialPath={sourceFolder.trim()}
          onSelect={path => {
            setSourceFolder(path)
            if (!name.trim()) setName(folderBaseName(path))
            setShowFolderBrowser(false)
          }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </div>
  )
}
