import { useState } from 'react'
import { useProjects } from '../context/ProjectContext'
import FolderBrowserDialog from './FolderBrowserDialog'
import './ProjectIODialog.css'

// Sanitize a project name into a filesystem-safe folder base (mirrors the
// server-side sanitizer so the preview matches what actually gets written).
function sanitizeName(name) {
  const cleaned = String(name || '').trim().replace(/[<>:"/\\|?* -]+/g, '_').replace(/\.+$/, '').trim()
  return cleaned || 'project'
}

// Export a project to a self-contained .3dgp bundle folder. Provide `project`
// (used to seed the default name) and an `onClose` handler.
export default function ExportProjectDialog({ project, onClose }) {
  const { exportProject } = useProjects()
  const [name, setName] = useState(project?.name || 'project')
  const [outputFolder, setOutputFolder] = useState('')
  const [showFolderBrowser, setShowFolderBrowser] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const folderBase = sanitizeName(name)

  const handleExport = async () => {
    const folder = outputFolder.trim()
    if (!folder) {
      setError('Choose a destination folder first.')
      return
    }
    if (!name.trim()) {
      setError('Enter a name for the export.')
      return
    }

    setExporting(true)
    setError('')
    setSuccess('')

    try {
      const result = await exportProject(project.id, { folder, name })
      setSuccess(`Exported "${result.name}" (${result.assetCount} asset${result.assetCount === 1 ? '' : 's'}, ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}) to ${result.folder}`)
    } catch (err) {
      setError(err.message || 'Failed to export the project.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="project-io-overlay" role="presentation" onClick={onClose}>
      <div
        className="project-io"
        role="dialog"
        aria-modal="true"
        aria-label="Export project"
        onClick={event => event.stopPropagation()}
      >
        <div className="project-io__header">
          <h3 className="project-io__title font-headline">Export project</h3>
          <button type="button" className="project-io__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="project-io__body">
          <label className="project-io__field">
            <span className="project-io__label">Name</span>
            <input
              className="project-io__input"
              value={name}
              onChange={event => { setName(event.target.value); setSuccess('') }}
              spellCheck={false}
              autoFocus
            />
          </label>

          <label className="project-io__field">
            <span className="project-io__label">Destination folder</span>
            <div className="project-io__folder-row">
              <input
                className="project-io__input"
                value={outputFolder}
                onChange={event => setOutputFolder(event.target.value)}
                placeholder="Choose a folder to export to"
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

          <p className="project-io__hint">
            Creates <code>{folderBase}/</code> containing <code>{folderBase}.3dgp</code> and an
            <code> assets/</code> folder with every linked asset, sub-asset and thumbnail.
          </p>

          {error && <div className="project-io__message project-io__message--error">{error}</div>}
          {success && <div className="project-io__message project-io__message--success">{success}</div>}
        </div>

        <div className="project-io__actions">
          <button type="button" className="project-io__btn project-io__btn--secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="project-io__btn project-io__btn--primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>

      {showFolderBrowser && (
        <FolderBrowserDialog
          initialPath={outputFolder.trim()}
          onSelect={path => { setOutputFolder(path); setShowFolderBrowser(false) }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </div>
  )
}
