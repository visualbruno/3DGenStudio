// Right-hand timeline of a Workspace project: running jobs first, then every
// generated / edited / imported asset, newest first.
import { useState } from 'react'
import { assetUrl } from '../../config'
import { setEntryDragData } from '../../utils/workspaceDrag'

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'image', label: 'Images', test: entry => entry.asset.type === 'image' },
  { id: 'mesh', label: 'Meshes', test: entry => entry.asset.type === 'mesh' },
  { id: 'edit', label: 'Edits', test: entry => entry.action === 'edit' },
  { id: 'import', label: 'Imports', test: entry => entry.action === 'import' }
]

const ACTION_BADGES = {
  edit: { icon: 'edit', title: 'A new version of another asset' },
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
  onMakeMesh,
  onRetopo,
  onAutoUv,
  onTexture,
  onRig,
  onOpenInEditor,
  onRemove,
  onCancelJob
}) {
  const [filter, setFilter] = useState('all')
  const [menuEntryId, setMenuEntryId] = useState(null)

  const activeFilter = FILTERS.find(option => option.id === filter) || FILTERS[0]
  const visible = entries.filter(activeFilter.test)

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
                {job.cloud && job.progressPercent == null ? (
                  <span className="material-symbols-outlined workspace-history__cloud">cloud_sync</span>
                ) : (
                  <span className="workspace-history__percent">
                    {job.status === 'cancelling' ? '…' : `${Math.round(job.progressPercent || 0)}%`}
                  </span>
                )}
                <span className="workspace-history__pending-label">{job.label}</span>
                <div className={`workspace-history__bar ${job.cloud && job.progressPercent == null ? 'workspace-history__bar--indeterminate' : ''}`}>
                  <div
                    className="workspace-history__bar-fill"
                    style={job.cloud && job.progressPercent == null ? undefined : { width: `${Math.max(4, job.progressPercent || 0)}%` }}
                  />
                </div>
              </div>
              {(!job.cloud || job.stoppable) && <button
                type="button"
                className="workspace-history__tile-btn workspace-history__tile-btn--corner"
                onClick={(event) => { event.stopPropagation(); onCancelJob(job.id) }}
                disabled={job.status === 'cancelling'}
                title={job.stoppable
                  ? 'Stop waiting for this result (the provider still finishes — and bills — the task)'
                  : 'Cancel this run'}
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
                // Images and meshes can be dragged onto the panels' inputs.
                draggable={entry.asset.type === 'image' || entry.asset.type === 'mesh'}
                onDragStart={(entry.asset.type === 'image' || entry.asset.type === 'mesh') ? (event) => setEntryDragData(event, entry) : undefined}
                onClick={() => onSelect(entry)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(entry) } }}
                title={entry.prompt || entry.asset.name}
              >
                {thumb
                  ? <img src={thumb} alt={entry.asset.name} loading="lazy" className="workspace-history__thumb" draggable={false} />
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
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onMakeMesh(entry) }} title="Turn this image into a 3D model">
                        <span className="material-symbols-outlined">deployed_code</span>
                        Make 3D
                      </button>
                    )}
                    {entry.asset.type === 'image' && (
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onEdit(entry) }} title="Use this image as the source of an edit">
                        <span className="material-symbols-outlined">edit</span>
                        Edit
                      </button>
                    )}
                    {entry.asset.type === 'mesh' && (
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onRetopo(entry) }} title="Repair, retopologize or optimize this mesh">
                        <span className="material-symbols-outlined">grid_4x4</span>
                        Retopo
                      </button>
                    )}
                    {entry.asset.type === 'mesh' && (
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onAutoUv(entry) }} title="Unwrap new UVs for this mesh">
                        <span className="material-symbols-outlined">view_quilt</span>
                        Auto UV
                      </button>
                    )}
                    {entry.asset.type === 'mesh' && (
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onTexture(entry) }} title="Texture this mesh">
                        <span className="material-symbols-outlined">texture</span>
                        Texture
                      </button>
                    )}
                    {entry.asset.type === 'mesh' && (
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onRig(entry) }} title="Add a skeleton and skin weights">
                        <span className="material-symbols-outlined">accessibility_new</span>
                        Auto Rig
                      </button>
                    )}
                    {entry.asset.type === 'mesh' && (
                      <button type="button" role="menuitem" onClick={() => { setMenuEntryId(null); onOpenInEditor(entry) }} title="Open in the full Mesh Editor">
                        <span className="material-symbols-outlined">open_in_new</span>
                        Mesh Editor
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
