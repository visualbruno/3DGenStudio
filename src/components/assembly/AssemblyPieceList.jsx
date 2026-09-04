// The assembly's piece list: the base body plus every garment being fitted to
// it, with per-piece display controls.
//
// Presentational — every mutation goes out through a callback to
// useAssemblyDocument. Nothing here reads or writes the document directly.
import { assetUrl } from '../../config'

// A piece's thumbnail may be a stored path ('thumbnails/x.png') or already a
// URL. buildAssetUrl in meshTexturing.js handles the mesh case; thumbnails are
// simpler, so normalise here rather than pulling in that module.
function thumbnailSrc(thumbnail) {
  if (!thumbnail) return ''
  if (/^(https?:|blob:|data:|\/)/i.test(thumbnail)) return thumbnail
  return assetUrl(thumbnail.replace(/^data\/assets\//, ''))
}

const FIT_STATUS_LABELS = {
  idle: '',
  queued: 'Queued',
  running: 'Fitting…',
  ready: 'Fitted',
  error: 'Failed',
}

export default function AssemblyPieceList({
  doc,
  onAddClick,
  onSelect,
  onSetBase,
  onPatchPiece,
  onRemovePiece,
  onReorder,
  onIsolate,
}) {
  const { pieces, basePieceId, settings } = doc
  const isolatedId = settings.isolatedPieceId

  return (
    <div className="assembly-pieces">
      <div className="assembly-pieces__header">
        <span className="assembly-pieces__title">Pieces</span>
        <button type="button" className="assembly-pieces__add" onClick={onAddClick}>
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add</span>
          Add meshes
        </button>
      </div>

      {pieces.length === 0 ? (
        <div className="assembly-pieces__empty">
          <span className="material-symbols-outlined" style={{ fontSize: '32px' }}>deployed_code</span>
          <p>No meshes yet.</p>
          <p className="assembly-pieces__empty-hint">
            Add the body first — it becomes the base everything else is fitted to.
            Pieces can come from any project.
          </p>
        </div>
      ) : (
        <ul className="assembly-pieces__list">
          {pieces.map((piece, index) => {
            const isBase = piece.id === basePieceId
            const isSelected = piece.id === settings.selectedPieceId
            const isIsolated = piece.id === isolatedId
            const isMissing = piece.assetId === null
            const statusLabel = FIT_STATUS_LABELS[piece.fit?.status] || ''

            return (
              <li
                key={piece.id}
                className={[
                  'assembly-piece',
                  isSelected ? 'assembly-piece--selected' : '',
                  isBase ? 'assembly-piece--base' : '',
                  isMissing ? 'assembly-piece--missing' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onSelect(piece.id)}
                draggable
                onDragStart={event => {
                  event.dataTransfer.setData('text/assembly-piece-index', String(index))
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={event => event.preventDefault()}
                onDrop={event => {
                  event.preventDefault()
                  const from = Number(event.dataTransfer.getData('text/assembly-piece-index'))
                  if (Number.isInteger(from)) onReorder(from, index)
                }}
              >
                <div className="assembly-piece__thumb">
                  {isMissing ? (
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>error_outline</span>
                  ) : piece.thumbnail ? (
                    <img src={thumbnailSrc(piece.thumbnail)} alt="" />
                  ) : (
                    <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>deployed_code</span>
                  )}
                </div>

                <div className="assembly-piece__body">
                  <div className="assembly-piece__name-row">
                    <span className="assembly-piece__name" title={piece.name}>{piece.name}</span>
                    {isBase && <span className="assembly-piece__badge">BASE</span>}
                    {statusLabel && (
                      <span className={`assembly-piece__status assembly-piece__status--${piece.fit.status}`}>
                        {statusLabel}
                      </span>
                    )}
                  </div>

                  {isMissing ? (
                    <span className="assembly-piece__missing-note">
                      Mesh no longer available — remove or re-add it
                    </span>
                  ) : (
                    <div className="assembly-piece__controls" onClick={event => event.stopPropagation()}>
                      <button
                        type="button"
                        className={`assembly-piece__toggle ${piece.visible ? '' : 'assembly-piece__toggle--off'}`}
                        title={piece.visible ? 'Hide' : 'Show'}
                        onClick={() => onPatchPiece(piece.id, { visible: !piece.visible })}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                          {piece.visible ? 'visibility' : 'visibility_off'}
                        </span>
                      </button>

                      <button
                        type="button"
                        className={`assembly-piece__toggle ${piece.locked ? 'assembly-piece__toggle--on' : ''}`}
                        title={piece.locked ? 'Unlock' : 'Lock (no gizmo, not pickable)'}
                        onClick={() => onPatchPiece(piece.id, { locked: !piece.locked })}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                          {piece.locked ? 'lock' : 'lock_open'}
                        </span>
                      </button>

                      <button
                        type="button"
                        className={`assembly-piece__toggle ${isIsolated ? 'assembly-piece__toggle--on' : ''}`}
                        title={isIsolated ? 'Exit isolate' : 'Isolate with the base'}
                        onClick={() => onIsolate(isIsolated ? null : piece.id)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>filter_center_focus</span>
                      </button>

                      <button
                        type="button"
                        className={`assembly-piece__toggle ${piece.wireframe ? 'assembly-piece__toggle--on' : ''}`}
                        title="Wireframe"
                        onClick={() => onPatchPiece(piece.id, { wireframe: !piece.wireframe })}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>grid_3x3</span>
                      </button>

                      <button
                        type="button"
                        className={`assembly-piece__toggle ${piece.xray ? 'assembly-piece__toggle--on' : ''}`}
                        title="X-ray (see pieces through this one)"
                        onClick={() => onPatchPiece(piece.id, { xray: !piece.xray })}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>visibility_lock</span>
                      </button>

                      <input
                        type="range"
                        className="assembly-piece__opacity"
                        min="0.1"
                        max="1"
                        step="0.05"
                        value={piece.opacity}
                        title={`Opacity ${Math.round(piece.opacity * 100)}%`}
                        onChange={event => onPatchPiece(piece.id, { opacity: Number(event.target.value) }, { history: false })}
                      />

                      {!isBase && (
                        <button
                          type="button"
                          className="assembly-piece__toggle"
                          title="Make this the base"
                          onClick={() => onSetBase(piece.id)}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>accessibility_new</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="assembly-piece__remove"
                  title="Remove from assembly"
                  onClick={event => { event.stopPropagation(); onRemovePiece(piece.id) }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
