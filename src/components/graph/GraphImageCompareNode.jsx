import { memo, useCallback, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import {
  IMAGE_COMPARE_INPUT_IDS,
  IMAGE_COMPARE_NODE_TYPE_NAME,
  appendCacheBust,
  getAssetPreviewUrl,
  getConnectorPosition,
  getConnectorTypeMeta
} from '../../utils/graphHelpers'

// Image comparison node: overlays two connected images with a draggable wipe slider.
const GraphImageCompareNode = memo(function GraphImageCompareNode({ data }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [compareState, setCompareState] = useState({ key: '', position: 50 })
  const inputConnectors = data.inputConnectors || IMAGE_COMPARE_INPUT_IDS.map(id => ({ id, type: 'image', isConnected: false }))
  const leftSource = (data.inputSources || []).find(source => source.connectorId === IMAGE_COMPARE_INPUT_IDS[0]) || null
  const rightSource = (data.inputSources || []).find(source => source.connectorId === IMAGE_COMPARE_INPUT_IDS[1]) || null
  const leftAsset = leftSource?.asset || null
  const rightAsset = rightSource?.asset || null
  const leftPreviewUrl = appendCacheBust(getAssetPreviewUrl(leftAsset?.thumbnail || leftAsset?.filename), refreshKey)
  const rightPreviewUrl = appendCacheBust(getAssetPreviewUrl(rightAsset?.thumbnail || rightAsset?.filename), refreshKey)
  const compareKey = `${leftPreviewUrl || ''}|${rightPreviewUrl || ''}`
  const comparePosition = compareState.key === compareKey ? compareState.position : 50
  const hasBothImages = Boolean(leftPreviewUrl && rightPreviewUrl)
  const nodeDisplayName = data.name || data.nodeTypeName || IMAGE_COMPARE_NODE_TYPE_NAME
  const connectedInputCount = inputConnectors.filter(connector => connector.isConnected).length

  const handlePointerMove = useCallback((event) => {
    if (!hasBothImages) {
      return
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width) {
      return
    }

    const nextPosition = ((event.clientX - bounds.left) / bounds.width) * 100
    setCompareState({
      key: compareKey,
      position: Math.max(0, Math.min(100, nextPosition))
    })
  }, [compareKey, hasBothImages])

  return (
    <div className="graph-node graph-node--imageCompare">
      {inputConnectors.map((connector, index) => {
        const connectorMeta = getConnectorTypeMeta(connector.type)

        return (
          <div
            key={connector.id}
            className="graph-node__connector graph-node__connector--input"
            style={getConnectorPosition(index, inputConnectors.length)}
          >
            <Handle
              type="target"
              id={connector.id}
              position={Position.Left}
              className="graph-node__handle graph-node__handle--input"
              style={{ borderColor: connectorMeta.color }}
            />
            <span
              className="graph-node__connector-badge font-label"
              style={{
                color: connectorMeta.color,
                background: connectorMeta.background,
                borderColor: connectorMeta.color
              }}
              title={connectorMeta.label}
            >
              {connectorMeta.letter}
            </span>
          </div>
        )
      })}

      <div className="graph-node__compare-card">
        <div className="graph-node__compare-header">
          <div className="graph-node__compare-title-group">
            <input
              type="text"
              className="graph-node__name-input nodrag"
              value={nodeDisplayName}
              placeholder={IMAGE_COMPARE_NODE_TYPE_NAME}
              onChange={event => data.onNodeNameChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeNameCommit?.(data.id, event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
            <span className="graph-node__compare-type font-label">COMPARE</span>
          </div>

          <button
            type="button"
            className="image-card__action-btn image-card__delete nodrag"
            style={{ opacity: 1, flexShrink: 0 }}
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="graph-node__compare-body">
          <div
            className={`graph-node__compare-stage nodrag ${hasBothImages ? 'graph-node__compare-stage--active' : ''}`}
            onPointerMove={handlePointerMove}
          >
            {hasBothImages ? (
              <>
                <img src={rightPreviewUrl} alt={rightAsset?.name || 'Right comparison image'} className="graph-node__compare-image" draggable={false} />
                <img
                  src={leftPreviewUrl}
                  alt={leftAsset?.name || 'Left comparison image'}
                  className="graph-node__compare-image graph-node__compare-image--overlay"
                  style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}
                  draggable={false}
                />
                <div className="graph-node__compare-divider" style={{ left: `${comparePosition}%` }}>
                  <span className="material-symbols-outlined">compare_arrows</span>
                </div>
              </>
            ) : (
              <div className="graph-node__compare-placeholder">
                {[leftSource, rightSource].map((source, index) => (
                  <div key={IMAGE_COMPARE_INPUT_IDS[index]} className="graph-node__compare-slot">
                    <span className="material-symbols-outlined">image</span>
                    <span>{source?.label || `Connect image ${index + 1}`}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="graph-node__compare-caption font-label">
              <span>{leftSource?.label || 'Left image'}</span>
              <span>{rightSource?.label || 'Right image'}</span>
            </div>
          </div>

          <p className="image-card__meta font-label">
            {hasBothImages
              ? 'Move across the preview to inspect the differences between both inputs.'
              : 'Connect two image outputs to enable the comparer.'}
          </p>

          <div className="graph-node__ports-summary font-label">
            <span className="graph-node__port-label">Inputs · {connectedInputCount}/2 connected</span>
          </div>

          <button
            type="button"
            className="image-card__edit-action-btn graph-node__compare-refresh nodrag"
            onClick={() => setRefreshKey(current => current + 1)}
            disabled={!hasBothImages}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
})

export default GraphImageCompareNode
