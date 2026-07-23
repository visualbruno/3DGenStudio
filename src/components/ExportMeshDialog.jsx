import { useEffect, useState } from 'react'
import FolderBrowserDialog from './FolderBrowserDialog'
import {
  EXPORT_FORMATS,
  browseFolders,
  exportObject3D,
  isGlbUrl,
  loadObject3DFromUrl,
  sanitizeBaseName,
  writeExportedFiles
} from '../utils/meshExport'
import { convertMesh, ensureDesktopService } from '../utils/meshTools'
import './ExportMeshDialog.css'

const LAST_OUTPUT_FOLDER_KEY = 'exportMeshDialog:lastOutputFolder'

// Reusable export popup. Provide either `getObject3D` (an async function that
// returns the in-memory THREE.Object3D to export) or `meshUrl` (a mesh URL the
// dialog loads itself). `defaultName` seeds the output file name.
//
// Engine presets (Blender/Unity/Unreal/FBX) are only offered in `meshUrl` mode:
// they exist to carry the rig + animation clips of saved assets, while
// `getObject3D` callers (the mesh editor) hand over rig-free geometry.
export default function ExportMeshDialog({ getObject3D, meshUrl, defaultName = 'mesh', onClose }) {
  const [format, setFormat] = useState('glb')
  const [fileName, setFileName] = useState(sanitizeBaseName(defaultName))
  const [outputFolder, setOutputFolder] = useState('')
  const [showFolderBrowser, setShowFolderBrowser] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const formats = getObject3D ? EXPORT_FORMATS.filter(entry => entry.kind === 'local') : EXPORT_FORMATS
  const selectedFormat = formats.find(entry => entry.value === format) || formats[0]

  // Recall the last folder used, but drop it silently if it no longer exists.
  useEffect(() => {
    const saved = localStorage.getItem(LAST_OUTPUT_FOLDER_KEY)
    if (!saved) return
    browseFolders(saved)
      .then(() => setOutputFolder(saved))
      .catch(() => localStorage.removeItem(LAST_OUTPUT_FOLDER_KEY))
  }, [])

  // Source GLB for the preset paths. When the asset is already a .glb, use its
  // original bytes (perfect fidelity — skin weights, clips and textures
  // untouched); otherwise serialize through three.js, which now carries the
  // loaded animations onto the exported GLB.
  const getSourceGlbBlob = async base => {
    if (!getObject3D && meshUrl && isGlbUrl(meshUrl)) {
      const response = await fetch(meshUrl)
      if (!response.ok) {
        throw new Error('Could not fetch the source mesh.')
      }
      return await response.blob()
    }
    const object = getObject3D ? await getObject3D() : await loadObject3DFromUrl(meshUrl)
    if (!object) {
      throw new Error('No mesh is available to export.')
    }
    const files = await exportObject3D(object, { format: 'glb', baseName: base })
    return files[0].blob
  }

  const handleExport = async () => {
    const folder = outputFolder.trim()
    const base = sanitizeBaseName(fileName)

    if (!folder) {
      setError('Choose an output folder first.')
      return
    }

    setExporting(true)
    setError('')
    setSuccess('')
    setProgress(null)

    try {
      let files
      let convertNote = ''

      if (selectedFormat.value === 'glb') {
        // Byte-passthrough when the source is a .glb (rig/animations/textures
        // untouched); three.js re-export otherwise.
        setProgress({ frac: 0.2, message: 'Preparing GLB…' })
        files = [{ filename: `${base}.glb`, blob: await getSourceGlbBlob(base) }]
      } else if (selectedFormat.kind !== 'preset') {
        const object = getObject3D ? await getObject3D() : await loadObject3DFromUrl(meshUrl)
        if (!object) {
          throw new Error('No mesh is available to export.')
        }
        files = await exportObject3D(object, { format: selectedFormat.value, baseName: base })
      } else {
        setProgress({ frac: 0.05, message: 'Preparing source GLB…' })
        const glbBlob = await getSourceGlbBlob(base)
        setProgress({ frac: 0.1, message: 'Starting the Mesh Tools service…' })
        await ensureDesktopService('meshtools')
        const { blob, stats } = await convertMesh(glbBlob, {
          options: { preset: selectedFormat.preset },
          fileName: `${base}.glb`,
          onProgress: evt => setProgress({
            frac: 0.1 + 0.85 * (evt.frac ?? 0),
            message: evt.message || 'Converting to FBX…'
          })
        })
        files = [{ filename: `${base}.fbx`, blob }]
        const tool = stats?.tool
        if (tool) {
          const clipCount = Array.isArray(tool.clips) ? tool.clips.length : 0
          convertNote = ` — ${tool.bones || 0} bones, ${clipCount} animation clip${clipCount === 1 ? '' : 's'}`
        }
      }

      setProgress({ frac: 0.97, message: 'Writing files…' })
      const result = await writeExportedFiles(folder, files)
      localStorage.setItem(LAST_OUTPUT_FOLDER_KEY, folder)
      const writtenNames = (result?.written || files.map(file => file.filename)).join(', ')
      setSuccess(`Exported ${files.length} file${files.length === 1 ? '' : 's'}: ${writtenNames}${convertNote}`)
    } catch (err) {
      setError(err.message || 'Failed to export the mesh.')
    } finally {
      setExporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="export-mesh-overlay" role="presentation" onClick={onClose}>
      <div
        className="export-mesh"
        role="dialog"
        aria-modal="true"
        aria-label="Export mesh"
        onClick={event => event.stopPropagation()}
      >
        <div className="export-mesh__header">
          <h3 className="export-mesh__title font-headline">Export mesh</h3>
          <button type="button" className="export-mesh__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="export-mesh__body">
          <label className="export-mesh__field">
            <span className="export-mesh__label">Format</span>
            <select
              className="export-mesh__select"
              value={format}
              onChange={event => { setFormat(event.target.value); setSuccess('') }}
            >
              {formats.map(entry => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>

          <label className="export-mesh__field">
            <span className="export-mesh__label">File name</span>
            <div className="export-mesh__filename-row">
              <input
                className="export-mesh__input"
                value={fileName}
                onChange={event => setFileName(event.target.value)}
                spellCheck={false}
              />
              <span className="export-mesh__ext">.{selectedFormat.extension}</span>
            </div>
          </label>

          <label className="export-mesh__field">
            <span className="export-mesh__label">Output folder</span>
            <div className="export-mesh__folder-row">
              <input
                className="export-mesh__input"
                value={outputFolder}
                onChange={event => setOutputFolder(event.target.value)}
                placeholder="Choose a folder to export to"
                spellCheck={false}
              />
              <button
                type="button"
                className="export-mesh__browse"
                onClick={() => setShowFolderBrowser(true)}
              >
                <span className="material-symbols-outlined">folder_open</span>
                Browse
              </button>
            </div>
          </label>

          {selectedFormat.hint && (
            <p className="export-mesh__hint">{selectedFormat.hint}</p>
          )}

          {progress && (
            <div className="export-mesh__progress" role="status">
              <div className="export-mesh__progress-track">
                <div
                  className="export-mesh__progress-bar"
                  style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.frac)) * 100)}%` }}
                />
              </div>
              <span className="export-mesh__progress-message">{progress.message}</span>
            </div>
          )}

          {error && <div className="export-mesh__message export-mesh__message--error">{error}</div>}
          {success && <div className="export-mesh__message export-mesh__message--success">{success}</div>}
        </div>

        <div className="export-mesh__actions">
          <button type="button" className="export-mesh__btn export-mesh__btn--secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="export-mesh__btn export-mesh__btn--primary"
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
