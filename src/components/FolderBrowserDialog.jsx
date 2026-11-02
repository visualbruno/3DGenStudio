import { useCallback, useEffect, useState } from 'react'
import { browseFolders } from '../utils/meshExport'
import './FolderBrowserDialog.css'

export default function FolderBrowserDialog({ initialPath = '', onSelect, onClose }) {
  const [listing, setListing] = useState(null)
  // True from the start: the dialog opens by listing initialPath.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [manualPath, setManualPath] = useState(initialPath || '')

  const navigate = useCallback(async (path) => {
    setLoading(true)
    setError('')
    try {
      const result = await browseFolders(path)
      setListing(result)
      setManualPath(result.path || '')
    } catch (err) {
      setError(err.message || 'Failed to open folder')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on open the synchronous setLoading(true)/setError('') are no-ops (already the state); the listing is set after the request resolves
    navigate(initialPath || '')
  }, [navigate, initialPath])

  const entries = listing?.entries || []
  const currentPath = listing?.path || ''
  const canGoUp = listing && listing.parent !== null && listing.parent !== undefined

  return (
    <div className="folder-browser-overlay" role="presentation" onClick={onClose}>
      <div
        className="folder-browser"
        role="dialog"
        aria-modal="true"
        aria-label="Select output folder"
        onClick={event => event.stopPropagation()}
      >
        <div className="folder-browser__header">
          <h3 className="folder-browser__title font-headline">Select output folder</h3>
          <button type="button" className="folder-browser__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="folder-browser__path-row">
          <button
            type="button"
            className="folder-browser__up"
            onClick={() => canGoUp && navigate(listing.parent)}
            disabled={!canGoUp || loading}
            title="Up one level"
          >
            <span className="material-symbols-outlined">arrow_upward</span>
          </button>
          <input
            className="folder-browser__path-input"
            value={manualPath}
            onChange={event => setManualPath(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                navigate(manualPath.trim())
              }
            }}
            placeholder="Type a path and press Enter"
            spellCheck={false}
          />
          <button
            type="button"
            className="folder-browser__go"
            onClick={() => navigate(manualPath.trim())}
            disabled={loading}
          >
            Go
          </button>
        </div>

        <div className="folder-browser__body">
          {loading && <div className="folder-browser__status">Loading…</div>}
          {error && !loading && <div className="folder-browser__status folder-browser__status--error">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="folder-browser__status">No sub-folders here.</div>
          )}
          {!loading && !error && entries.map(entry => (
            <button
              type="button"
              key={entry.path}
              className="folder-browser__entry"
              onClick={() => navigate(entry.path)}
              title={entry.path}
            >
              <span className="material-symbols-outlined">folder</span>
              <span className="folder-browser__entry-name">{entry.name}</span>
            </button>
          ))}
        </div>

        <div className="folder-browser__actions">
          <span className="folder-browser__current" title={currentPath}>{currentPath || 'No folder selected'}</span>
          <div className="folder-browser__action-buttons">
            <button type="button" className="folder-browser__btn folder-browser__btn--secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="folder-browser__btn folder-browser__btn--primary"
              onClick={() => onSelect(currentPath)}
              disabled={!currentPath}
            >
              Select this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
