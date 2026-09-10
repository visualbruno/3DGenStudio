import { useState } from 'react'
import FolderBrowserDialog from '../FolderBrowserDialog'
import { exportVfxBundle } from '../../utils/vfxApi.js'
import '../ProjectIODialog.css'

// Export one effect as an engine bundle: the graph, the compiled IR, the
// compatibility table and every texture and mesh it uses.
//
// SHAPED LIKE ExportProjectDialog, and reusing its stylesheet, because it is the
// same interaction: the SERVER writes the folder, not the browser. A browser
// cannot write a directory of files, and the destination is a real path on the
// machine the user is sitting at - which is also why POST /vfx-export is kept
// off the gateway's forward list (see serverMode.js).
//
// THE ENGINE TARGET IS OPTIONAL AND CHANGES NOTHING IN THE BUNDLE'S CONTENT.
// It only decides whether the manifest also spells out what that one engine
// cannot take intact, instead of shipping the whole table for a plugin author
// to diff. Every bundle carries the full mapping either way.

// Mirrors the server's sanitizer so the preview matches what actually lands.
function sanitizeName(name) {
  const cleaned = String(name || '').trim().replace(/[<>:"/\\|?* -]+/g, '_').replace(/\.+$/, '').trim()
  return cleaned || 'effect'
}

/**
 * @param {Object} props
 * @param {number} props.assetId the saved effect
 * @param {string} props.name its name, to seed the folder name
 * @param {() => void} props.onClose
 */
export default function VfxExportDialog({ assetId, name: effectName, onClose }) {
  const [name, setName] = useState(effectName || 'effect')
  const [outputFolder, setOutputFolder] = useState('')
  const [engineTarget, setEngineTarget] = useState('')
  // On by default. The importer is the only thing that can read the bundle,
  // and a user of the packaged app has no other way to obtain it - there is
  // no repository to clone. Twenty-six kilobytes is not worth a decision.
  const [includeUnityImporter, setIncludeUnityImporter] = useState(true)
  const [showFolderBrowser, setShowFolderBrowser] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const folderBase = sanitizeName(name)

  const handleExport = async () => {
    const folder = outputFolder.trim()
    if (!folder) return setError('Choose a destination folder first.')
    if (!name.trim()) return setError('Enter a name for the export.')

    setExporting(true)
    setError('')
    setResult(null)
    try {
      setResult(await exportVfxBundle(assetId, {
        folder,
        name: name.trim(),
        engineTarget: engineTarget || null,
        includeUnityImporter,
      }))
    } catch (err) {
      setError(err.message || 'Failed to export the effect.')
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
        aria-label="Export effect"
        onClick={event => event.stopPropagation()}
      >
        <div className="project-io__header">
          <h3 className="project-io__title font-headline">Export for an engine</h3>
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
              onChange={event => { setName(event.target.value); setResult(null) }}
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

          <label className="project-io__field">
            <span className="project-io__label">Target engine (optional)</span>
            <select
              className="project-io__input"
              value={engineTarget}
              onChange={event => setEngineTarget(event.target.value)}
            >
              <option value="">Both — ship the whole compatibility table</option>
              <option value="unity">Unity VFX Graph</option>
              <option value="unreal">Unreal Niagara</option>
            </select>
          </label>

          <label className="project-io__field project-io__field--check">
            <input
              type="checkbox"
              checked={includeUnityImporter}
              onChange={event => setIncludeUnityImporter(event.target.checked)}
            />
            <span>Include the Unity importer</span>
          </label>

          <p className="project-io__hint">
            Creates <code>{folderBase}/</code> containing <code>manifest.json</code> — the graph,
            the compiled IR and the engine mapping — plus <code>vfx/</code> and
            <code> assets/</code> with every texture and mesh this effect uses. An importer plugin
            reads the IR, not the graph.
            {includeUnityImporter && (
              <> The Unity importer goes in <code>UnityImporter/</code> beside it, as both a
              Package Manager package and a <code>.unitypackage</code>, with a note saying how
              to install either.</>
            )}
          </p>

          {error && <div className="project-io__message project-io__message--error">{error}</div>}
          {result && (
            <div className="project-io__message project-io__message--success">
              Exported {result.fileCount} file{result.fileCount === 1 ? '' : 's'} to {result.folder}
              {result.unityImporter && ' with the Unity importer'}
              {/* Surfaced rather than buried in the manifest: a missing texture
                  does not fail the export, so this is the only place the author
                  finds out the bundle is short of something. */}
              {result.warnings?.length > 0 && (
                <>
                  {' '}— with {result.warnings.length} warning
                  {result.warnings.length === 1 ? '' : 's'}:{' '}
                  {result.warnings.map(w => w.code).join(', ')}
                </>
              )}
            </div>
          )}
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
