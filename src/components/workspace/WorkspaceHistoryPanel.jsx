// Right-hand timeline of a Workspace project: running jobs first, then every
// generated / edited / imported asset, newest first.
import { useState } from 'react'
import { assetUrl } from '../../config'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'generate', label: 'Generated' },
  { id: 'edit', label: 'Edited' },
  { id: 'import', label: 'Imported' }
]

const ACTION_BADGES = {
  edit: { icon: 'edit', title: 'Edit of another image' },
  import: { icon: 'upload', title: 'Imported' }
}

function thumbnailFor(asset) {
  if (asset?.thumbnail) return assetUrl(asset.thumbnail)
  if (asset?.type === 'image' && asset?.filename) return assetUrl(asset.filename)
  return null
}

export default function WorkspaceHistoryPanel({
  entries,
  loading,
  error,
  hasMore,
  onLoadMore,
  pendingJobs,
  selectedEntryId,
  onSelect,
  onEdit,
  onRemove,
  onCancelJob
}) {
  const [filter, setFilter] = useState('all')
  const [menuEntryId, setMenuEntryId] = useState(null)

  const visible = filter === 'all' ? entries : entries.filter(entry => entry.action === filter)

  return (
    <aside className="workspace-history" aria-label="History">
      <div className="workspace-history__head">
        <span className="workspace-history__title">
          <span className="material-symbols-outlined">history</span>
          History
        </span>
        <span className="workspace-history__count">{entries.length}{hasMore ? '+' : ''}</span>
      </div>

      <div className="workspace-history__filters" role="tablist">
        {FILTERS.map(option => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={filter === option.id}
            className={`workspace-chip ${filter === option.id ? 'workspace-chip--active' : ''}`}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="workspace-history__scroll" onClick={() => setMenuEntryId(null)}>
        {error && <div className="workspace-history__message workspace-history__message--error">{error}</div>}

        <div className="workspace-history__grid">
          {pendingJobs.map(job => (
            <div key={job.id} className="workspace-history__tile workspace-history__tile--pending" title={job.detail || job.label}>
              <div className="workspace-history__progress">
                {job.cloud ? (
                  <span className="material-symbols-outlined workspace-history__cloud">cloud_sync</span>
                ) : (
                  <span className="workspace-history__percent">
                    {job.status === 'cancelling' ? '…' : `${Math.round(job.progressPercent || 0)}%`}
                  </span>
                )}
                <span className="workspace-history__pending-label">{job.label}</span>
                <div className={`workspace-history__bar ${job.cloud ? 'workspace-history__bar--indeterminate' : ''}`}>
                  <div className="workspace-history__bar-fill" style={job.cloud ? undefined : { width: `${Math.max(4, job.progressPercent || 0)}%` }} />
                </div>
              </div>
              {!job.cloud && <button
                type="button"
                className="workspace-history__tile-btn workspace-history__tile-btn--corner"
                onClick={(event) => { event.stopPropagation(); onCancelJob(job.id) }}
                disabled={job.status === 'cancelling'}
                title="Cancel this run"
              >
                <span className="material-symbols-outlined">close</span>
              </button>}
            </div>
          ))}

          {visible.map(entry => {
            const thumb = thumbnailFor(entry.asset)
            const badge = ACTION_BADGES[entry.action]
            return (
              <div
                key={entry.id}
                role="button"
                tabIndex={0}
                className={`workspace-history__tile ${selectedEntryId === entry.id ? 'workspace-history__tile--selected' : ''}`}
                onClick={() => onSelect(entry)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(entry) } }}
                title={entry.prompt || entry.asset.name}
              >
                {thumb
                  ? <img src={thumb} alt={entry.asset.name} loading="lazy" className="workspace-history__thumb" />
                  : <span className="material-symbols-outlined workspace-history__placeholder">deployed_code</span>}

                {badge && (
                  <span className="workspace-history__badge" title={badge.title}>
                    <span className="material-symbols-outlined">{badge.icon}</span>
                  </span>
                )}

                <button
                  type="button"
                  className="workspace-history__tile-btn workspace-history__tile-btn--corner"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuEntryId(current => (current === entry.id ? null : entry.id))
                  }}
                  title="More"
                  aria-haspopup="menu"
                  aria-expanded={menuEntryId === entry.id}
                >
                  <span className="material-symbols-outlined">more_horiz</span>
                </button>

                {menuEntryId === entry.id && (
                  <div className="workspace-history__menu" role="menu" onClick={(event) => event.stopPropagation()}>
                    {entry.asset.type === 'image' && (
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onEdit(entry) }} title="Use this image as the source of an edit">
                        <span className="material-symbols-outlined">edit</span>
                        Edit
                      </button>
                    )}
                    <a role="menuitem" href={assetUrl(entry.asset.filename)} download onClick={() => setMenuEntryId(null)} title="Download the file">
                      <span className="material-symbols-outlined">download</span>
                      Download
                    </a>
                    <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onRemove(entry) }} title="Remove from the history (the asset stays in the project)">
                      <span className="material-symbols-outlined">playlist_remove</span>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {!loading && !error && entries.length === 0 && pendingJobs.length === 0 && (
          <div className="workspace-history__message">
            Generated, edited and imported images appear here.
          </div>
        )}
        {!loading && entries.length > 0 && visible.length === 0 && (
          <div className="workspace-history__message">Nothing in this filter yet.</div>
        )}
        {loading && <div className="workspace-history__message">Loading…</div>}
        {hasMore && !loading && (
          <button type="button" className="workspace-history__more" onClick={onLoadMore}>Load more</button>
        )}
      </div>
    </aside>
  )
}
