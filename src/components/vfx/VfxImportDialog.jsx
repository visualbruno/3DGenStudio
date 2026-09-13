import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { importVfxBundle, readVfxBundle } from '../../utils/vfx/bundleImport.js'
import { saveVfxAsset } from '../../utils/vfxApi.js'
import '../ProjectIODialog.css'
import './VfxImportDialog.css'

// Import an effect that was exported with VfxExportDialog.
//
// A NATIVE DIRECTORY PICKER, NOT FolderBrowserDialog, and the asymmetry with
// Export is deliberate. Export browses the SERVER's filesystem because the
// server is what writes the folder; import needs the BYTES, and a directory
// input hands them straight to the page. See the header of
// src/utils/vfx/bundleImport.js for why that also makes this work unchanged
// against a shared Docker server, where the folder is on the user's machine and
// the database is not.
//
// READ FIRST, INSTALL SECOND. Picking a folder only parses its manifest and
// says what is in it. Nothing is written until Import is pressed - so a bundle
// from a newer build, or a folder that is not a bundle at all, is refused
// before six textures have been uploaded into the library.

const dateOf = (ms) => (ms ? new Date(ms).toLocaleDateString() : '')

/**
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {(asset: Object) => void} [props.onImported] called after a successful
 *   import, with the new Vfx asset row
 * @param {() => void} [props.onImportSingleFile] opens the plain .vfx.json
 *   importer instead; the dialog closes first
 */
export default function VfxImportDialog({ onClose, onImported, onImportSingleFile }) {
  const { getLibraryAssets, importLibraryAssets } = useProjects()

  const folderInputRef = useRef(null)
  const [bundle, setBundle] = useState(null)
  const [folderLabel, setFolderLabel] = useState('')
  const [name, setName] = useState('')
  const [reuseExisting, setReuseExisting] = useState(true)
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  // Set as ATTRIBUTES rather than in JSX. `webkitdirectory` is not a React DOM
  // property, and while React does pass unknown lowercase attributes through,
  // an input that silently becomes a plain file picker is a failure nobody
  // notices until a user picks a folder and gets nothing.
  useEffect(() => {
    const input = folderInputRef.current
    if (!input) return
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
  }, [])

  const handleFolderChange = useCallback(async (event) => {
    const selection = Array.from(event.target.files || [])
    // Cleared before the async read: the input keeps its selection, and a
    // second pick of the SAME folder has to re-read rather than do nothing.
    event.target.value = ''
    if (selection.length === 0) return

    setReading(true)
    setError('')
    setResult(null)
    setBundle(null)
    try {
      const read = await readVfxBundle(selection)
      setBundle(read)
      setName(read.name)
      // The folder the user actually picked, which is the label they recognise.
      setFolderLabel((read.root || '').replace(/\/$/, '') || read.name)
    } catch (err) {
      setFolderLabel('')
      setError(err?.message || 'That folder could not be read as a VFX bundle.')
    } finally {
      setReading(false)
    }
  }, [])

  const handleImport = async () => {
    if (!bundle) return
    setImporting(true)
    setError('')
    setResult(null)
    setProgress(null)
    try {
      const imported = await importVfxBundle(bundle, {
        name,
        reuseExisting,
        uploadAssets: importLibraryAssets,
        listLibrary: getLibraryAssets,
        saveEffect: saveVfxAsset,
        onProgress: setProgress,
      })
      setResult(imported)
      onImported?.(imported.asset)
    } catch (err) {
      setError(err?.message || 'Failed to import the effect.')
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  const summary = bundle?.summary
  const assetCount = summary ? summary.textures + summary.meshes + summary.effects : 0

  return (
    <div className="project-io-overlay" role="presentation" onClick={onClose}>
      <div
        className="project-io vfx-import"
        role="dialog"
        aria-modal="true"
        aria-label="Import an effect"
        onClick={event => event.stopPropagation()}
      >
        <div className="project-io__header">
          <h3 className="project-io__title font-headline">Import an exported effect</h3>
          <button type="button" className="project-io__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="project-io__body">
          <label className="project-io__field">
            <span className="project-io__label">Bundle folder</span>
            <div className="project-io__folder-row">
              <input
                className="project-io__input"
                value={folderLabel}
                placeholder="Choose the folder holding manifest.json"
                readOnly
                spellCheck={false}
              />
              <button
                type="button"
                className="project-io__browse"
                onClick={() => folderInputRef.current?.click()}
                disabled={reading || importing}
              >
                <span className="material-symbols-outlined">folder_open</span>
                {reading ? 'Reading…' : 'Browse'}
              </button>
            </div>
          </label>

          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="vfx-import__file-input"
            onChange={handleFolderChange}
          />

          {bundle && (
            <>
              <div className="vfx-import__summary">
                <div className="vfx-import__summary-head">
                  <span className="material-symbols-outlined">auto_awesome</span>
                  <strong>{summary.name || 'Untitled effect'}</strong>
                  {summary.appVersion && (
                    <span className="vfx-import__meta">
                      exported from v{summary.appVersion}
                      {summary.exportedAt ? ` on ${dateOf(summary.exportedAt)}` : ''}
                    </span>
                  )}
                </div>
                <ul className="vfx-import__counts">
                  <li>{summary.textures} texture{summary.textures === 1 ? '' : 's'}</li>
                  <li>{summary.meshes} mesh{summary.meshes === 1 ? '' : 'es'}</li>
                  {summary.effects > 0 && (
                    <li>{summary.effects} nested effect{summary.effects === 1 ? '' : 's'}</li>
                  )}
                </ul>
              </div>

              <label className="project-io__field">
                <span className="project-io__label">Save as</span>
                <input
                  className="project-io__input"
                  value={name}
                  onChange={event => { setName(event.target.value); setResult(null) }}
                  spellCheck={false}
                />
              </label>

              <label className="project-io__field vfx-import__check">
                <input
                  type="checkbox"
                  checked={reuseExisting}
                  onChange={event => setReuseExisting(event.target.checked)}
                />
                <span>
                  Reuse library assets with the same name
                  <em>
                    {' '}Off, the bundle&apos;s textures and meshes are added as fresh copies even
                    when you already have them.
                  </em>
                </span>
              </label>

              {/* THE BUNDLE'S OWN WARNINGS, SHOWN BEFORE THE IMPORT. Export
                  records them and ships anyway - a half-authored effect is the
                  normal case - so this is the only moment the person on the
                  receiving end can find out what will be missing. */}
              {(bundle.warnings.length > 0 || bundle.missingFiles.length > 0) && (
                <ul className="vfx-import__warnings">
                  {bundle.missingFiles.map(need => (
                    <li key={`file-${need.slot}`}>
                      <span className="material-symbols-outlined">folder_off</span>
                      <span>
                        The manifest lists <code>{need.file}</code>, which is not in the folder.
                        That slot will import empty.
                      </span>
                    </li>
                  ))}
                  {bundle.warnings.map((warning, index) => (
                    <li key={`warn-${warning.code}-${index}`}>
                      <span className="material-symbols-outlined">warning</span>
                      <span>{warning.message || warning.code}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <p className="project-io__hint">
            Choose the folder an effect was exported to — the one containing
            <code> manifest.json</code>, <code>vfx/</code> and <code>assets/</code>. Its textures and
            meshes are added to your library and the effect is re-pointed at them, so the asset ids
            from the machine it came from are never carried across.
            {onImportSingleFile && (
              <>
                {' '}A bare <code>.vfx.json</code> imports too, without any of its textures —{' '}
                <button
                  type="button"
                  className="vfx-import__link"
                  onClick={() => { onClose(); onImportSingleFile() }}
                >
                  choose a file instead
                </button>.
              </>
            )}
          </p>

          {progress && (
            <div className="project-io__message">
              Installing {progress.done} of {progress.total} — {progress.label}
            </div>
          )}
          {error && <div className="project-io__message project-io__message--error">{error}</div>}
          {result && (
            <div className="project-io__message project-io__message--success">
              Imported &ldquo;{result.name}&rdquo;
              {result.installed.length > 0 && ` — added ${result.installed.length} asset${result.installed.length === 1 ? '' : 's'}`}
              {result.reused.length > 0 && `, reused ${result.reused.length}`}.
              {/* A slot that came back empty draws with the built-in sprite,
                  which looks exactly like an effect nobody textured. Saying so
                  is the difference between a bug report and a known gap. */}
              {result.missing.length > 0 && (
                <ul className="vfx-import__warnings">
                  {result.missing.map(entry => (
                    <li key={`missing-${entry.slot}`}>
                      <span className="material-symbols-outlined">broken_image</span>
                      <span>
                        <code>{entry.name || entry.slot}</code> is empty in the imported effect: {entry.reason}.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="project-io__actions">
          <button type="button" className="project-io__btn project-io__btn--secondary" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            className="project-io__btn project-io__btn--primary"
            onClick={handleImport}
            disabled={!bundle || importing || reading}
            title={bundle ? `Adds ${assetCount} asset${assetCount === 1 ? '' : 's'} and one effect to your library` : 'Choose a bundle folder first'}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
