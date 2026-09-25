import { describeCell, getGroupLabel, getStageLabel } from '../../utils/batchHelpers'
import { getAssetPreviewUrl } from '../../utils/graphHelpers'

// Rows = groups, columns = stages — the same axes as the configuration above,
// so a cell's position reads the same in both halves of the page.
//
// A cell's asset comes from the Card the run created for it (keyed by
// buildBatchCardKey); this grid only displays what those cards already hold.
export default function BatchResultsGrid({
  groups,
  stages,
  cells,
  assetsByCardKey,
  locked,
  onOpenAsset,
  onDeleteResult
}) {
  if (groups.length === 0 || stages.length === 0) {
    return null
  }

  return (
    <div className="batch-results">
      <div className="batch-results__header">
        <span className="batch-column__title font-label">RESULTS</span>
        <span className="batch-column__subtitle">
          One card per result, in the project like any other generation
          {onDeleteResult ? ' · delete one to run its stage again with Continue' : ''}
        </span>
      </div>

      <div className="batch-results__scroll">
        <table className="batch-results__table">
          <thead>
            <tr>
              <th className="batch-results__corner" />
              {stages.map((stage, stageIndex) => (
                <th key={stage.id} className="batch-results__col-head">
                  {getStageLabel(stage, stageIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group, groupIndex) => (
              <tr key={group.id}>
                <th className="batch-results__row-head">{getGroupLabel(group, groupIndex)}</th>
                {stages.map((stage, stageIndex) => {
                  const cell = cells?.[`${group.id}:${stage.id}`] || null
                  const asset = cell?.cardKey ? assetsByCardKey?.[cell.cardKey] || null : null
                  // A mesh without a thumbnail draws the status icon: pointing an
                  // <img> at the .glb itself would just be a broken image.
                  const previewUrl = getAssetPreviewUrl(asset?.thumbnail
                    || (asset?.type === 'mesh' ? null : asset?.filename)
                    || null)
                  const status = cell?.status || 'idle'
                  // Anything the run has already settled can be thrown away and
                  // regenerated; a cell still in flight owns its card.
                  const canDelete = Boolean(onDeleteResult)
                    && !locked
                    && status !== 'running'
                    && status !== 'queued'
                    && Boolean(asset?.id || cell?.assetId || cell?.cardKey)

                  return (
                    <td key={stage.id} className={`batch-results__cell batch-results__cell--${status}`}>
                      <div className="batch-results__cell-wrap">
                        {canDelete && (
                          <button
                            type="button"
                            className="batch-results__delete"
                            onClick={() => onDeleteResult({
                              group,
                              groupIndex,
                              stage,
                              stageIndex,
                              cell,
                              asset,
                              cellKey: `${group.id}:${stage.id}`
                            })}
                            title="Delete this result so the stage can be run again for this group"
                          >
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="batch-results__cell-btn"
                          onClick={() => asset && onOpenAsset?.(asset)}
                          disabled={!asset}
                          title={cell?.error
                            || (asset ? [asset.name, cell?.warning].filter(Boolean).join('\n') : describeCell(cell))}
                        >
                          {previewUrl ? (
                            <img className="batch-results__thumb" src={previewUrl} alt={asset?.name || ''} />
                          ) : (
                            <span className="material-symbols-outlined batch-results__icon">
                              {status === 'running' ? 'progress_activity'
                                : status === 'error' ? 'error'
                                : status === 'completed' ? 'check_circle'
                                : status === 'cancelled' ? 'block'
                                : 'schedule'}
                            </span>
                          )}
                          <span className="batch-results__caption font-label">{describeCell(cell)}</span>
                          {cell?.extraOutputs > 0 && (
                            <span className="batch-results__extra font-label">
                              +{cell.extraOutputs} more output{cell.extraOutputs === 1 ? '' : 's'}
                            </span>
                          )}
                          {/* Landed, but worth a look — a bake that reached little of
                              the UVs, an optimize that stopped short of its target.
                              Only the live run knows; a reload shows the result alone. */}
                          {status === 'completed' && cell?.warning && (
                            <span className="batch-results__extra font-label" style={{ color: '#e0a030' }}>
                              Check result — hover for why
                            </span>
                          )}
                        </button>
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
