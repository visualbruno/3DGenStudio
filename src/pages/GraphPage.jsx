import { useCallback, useEffect, useState } from 'react'
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState
} from '@xyflow/react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import '@xyflow/react/dist/style.css'
import './KanbanPage.css'
import './GraphPage.css'

const DEFAULT_OUTPUT_ID = 'image-output'
const DEFAULT_INPUT_ID = 'image-input'

function getNodeKind(nodeTypeName = '') {
  return String(nodeTypeName).trim().toLowerCase() === 'image edit' ? 'imageEdit' : 'image'
}

function formatAssetDimensions(width, height) {
  if (!width || !height) {
    return null
  }

  return `${width} × ${height}`
}

function getAssetPreviewUrl(filename) {
  if (!filename) {
    return null
  }

  return `http://localhost:3001/assets/${encodeURI(filename)}`
}

function buildEdgeId(connection) {
  return `edge:${connection.sourceNodeId}:${connection.outputId}:${connection.targetNodeId}:${connection.inputId}`
}

function toFlowEdge(connection) {
  return {
    id: buildEdgeId(connection),
    source: String(connection.sourceNodeId),
    target: String(connection.targetNodeId),
    sourceHandle: connection.outputId || DEFAULT_OUTPUT_ID,
    targetHandle: connection.inputId || DEFAULT_INPUT_ID,
    type: 'smoothstep',
    animated: true
  }
}

function toFlowNode(node, onDelete) {
  const nodeKind = getNodeKind(node.nodeTypeName)

  return {
    id: String(node.id),
    type: nodeKind,
    position: {
      x: Number(node.xPos) || 0,
      y: Number(node.yPos) || 0
    },
    data: {
      ...node,
      nodeKind,
      onDelete
    }
  }
}

function GraphAssetNode({ data }) {
  const isImageEdit = data.nodeKind === 'imageEdit'
  const previewFilename = data.asset?.thumbnail || data.asset?.filename || null
  const previewUrl = getAssetPreviewUrl(previewFilename)
  const dimensions = formatAssetDimensions(data.asset?.width, data.asset?.height)
  const isProcessing = data.status === 'processing'
  const sourceLabel = isImageEdit ? 'IMAGE EDIT' : 'IMAGE'
  const metaLabel = isProcessing
    ? (Number.isFinite(data.progress) ? `${data.progress}%` : 'Processing…')
    : (dimensions || (isImageEdit ? 'Connect an input image and generate a result.' : 'Attach or generate a single image.'))

  return (
    <div className={`graph-node graph-node--${data.nodeKind}`}>
      {isImageEdit && (
        <Handle
          type="target"
          id={DEFAULT_INPUT_ID}
          position={Position.Left}
          className="graph-node__handle graph-node__handle--input"
        />
      )}

      <div className={`graph-node__card image-card ${isProcessing ? 'image-card--loading image-card--locked' : ''}`}>
        <div className="image-card__actions">
          <button
            type="button"
            className="image-card__action-btn image-card__delete nodrag"
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="image-card__thumb graph-node__thumb">
          {previewUrl ? (
            <div className="image-card__thumb-item">
              <img src={previewUrl} alt={data.asset?.name || data.name || sourceLabel} className="image-card__thumb-image" />
            </div>
          ) : (
            <div className="image-card__thumb-placeholder">
              <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.12)' }}>
                {isImageEdit ? 'photo_filter' : 'image'}
              </span>
            </div>
          )}

          {isImageEdit && (
            <div className="image-card__edit-preview-indicator font-label">
              INPUT • IMAGE
            </div>
          )}

          {dimensions && (
            <div className="image-card__thumb-dimensions font-label">
              {dimensions}
            </div>
          )}
        </div>

        <div className="image-card__info">
          <div className="image-card__row">
            <h3 className="image-card__name">{data.asset?.name || data.name || sourceLabel}</h3>
            <div className="image-card__badges">
              <span
                className="image-card__source"
                style={{
                  color: 'var(--primary)',
                  background: 'rgba(143,245,255,0.1)'
                }}
              >
                {sourceLabel}
              </span>
            </div>
          </div>

          <p className="image-card__meta font-label">{metaLabel}</p>

          {isProcessing && Number.isFinite(data.progress) && (
            <div className="image-card__progress graph-node__progress" aria-hidden="true">
              <div
                className="image-card__progress-bar"
                style={{ width: `${Math.max(0, Math.min(100, data.progress || 0))}%` }}
              />
            </div>
          )}

          <div className="graph-node__ports-summary font-label">
            {isImageEdit && <span className="graph-node__port-label">Input · Image</span>}
            <span className="graph-node__port-label graph-node__port-label--output">Output · Image</span>
          </div>
        </div>
      </div>

      <Handle
        type="source"
        id={DEFAULT_OUTPUT_ID}
        position={Position.Right}
        className="graph-node__handle graph-node__handle--output"
      />
    </div>
  )
}

const flowNodeTypes = {
  image: GraphAssetNode,
  imageEdit: GraphAssetNode
}

export default function GraphPage({ project }) {
  const {
    getProjectNodes,
    createProjectNode,
    updateProjectNodePosition,
    deleteProjectNode,
    getProjectConnections,
    createProjectConnection,
    deleteProjectConnection
  } = useProjects()

  const [showSettings, setShowSettings] = useState(false)
  const [loading, setLoading] = useState(true)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  const handleDeleteNode = useCallback(async (nodeId) => {
    await deleteProjectNode(project.id, Number(nodeId))
    setNodes(currentNodes => currentNodes.filter(node => node.id !== String(nodeId)))
    setEdges(currentEdges => currentEdges.filter(edge => edge.source !== String(nodeId) && edge.target !== String(nodeId)))
  }, [deleteProjectNode, project.id, setEdges, setNodes])

  useEffect(() => {
    let cancelled = false

    async function loadGraph() {
      setLoading(true)

      try {
        const [projectNodes, projectConnections] = await Promise.all([
          getProjectNodes(project.id),
          getProjectConnections(project.id)
        ])

        if (cancelled) {
          return
        }

        setNodes(projectNodes.map(node => toFlowNode(node, handleDeleteNode)))
        setEdges(projectConnections.map(toFlowEdge))
      } catch (err) {
        console.error('Failed to load workflow graph:', err)

        if (!cancelled) {
          setNodes([])
          setEdges([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadGraph()

    return () => {
      cancelled = true
    }
  }, [getProjectConnections, getProjectNodes, handleDeleteNode, project.id, setEdges, setNodes])

  const handleCreateNode = useCallback(async (nodeTypeName) => {
    const nextIndex = nodes.length
    const createdNode = await createProjectNode(project.id, {
      nodeTypeName,
      name: nodeTypeName,
      xPos: 96 + ((nextIndex % 4) * 48),
      yPos: 96 + (nextIndex * 32),
      metadata: {
        inputType: nodeTypeName === 'Image Edit' ? 'image' : null,
        outputType: 'image'
      }
    })

    setNodes(currentNodes => [...currentNodes, toFlowNode(createdNode, handleDeleteNode)])
  }, [createProjectNode, handleDeleteNode, nodes.length, project.id, setNodes])

  const handleConnect = useCallback(async (connection) => {
    if (!connection.source || !connection.target) {
      return
    }

    const createdConnection = await createProjectConnection(project.id, {
      sourceNodeId: Number(connection.source),
      targetNodeId: Number(connection.target),
      inputId: connection.targetHandle || DEFAULT_INPUT_ID,
      outputId: connection.sourceHandle || DEFAULT_OUTPUT_ID
    })

    setEdges(currentEdges => {
      const nextEdge = toFlowEdge(createdConnection)
      if (currentEdges.some(edge => edge.id === nextEdge.id)) {
        return currentEdges
      }

      return addEdge(nextEdge, currentEdges)
    })
  }, [createProjectConnection, project.id, setEdges])

  const handleNodeDragStop = useCallback(async (_event, node) => {
    try {
      await updateProjectNodePosition(project.id, Number(node.id), node.position)
    } catch (err) {
      console.error('Failed to persist node position:', err)
    }
  }, [project.id, updateProjectNodePosition])

  const handleEdgesDelete = useCallback(async (deletedEdges) => {
    await Promise.all(
      deletedEdges.map(edge => deleteProjectConnection(project.id, {
        sourceNodeId: Number(edge.source),
        targetNodeId: Number(edge.target),
        inputId: edge.targetHandle || DEFAULT_INPUT_ID,
        outputId: edge.sourceHandle || DEFAULT_OUTPUT_ID
      }).catch(err => {
        console.error('Failed to delete graph connection:', err)
      }))
    )
  }, [deleteProjectConnection, project.id])

  const showEmptyState = !loading && nodes.length === 0
  const minimapNodeColor = useCallback(node => node.type === 'imageEdit' ? '#ac89ff' : '#8ff5ff', [])

  return (
    <div className="graph-layout">
      <Header
        showSearch
        showCreateNew
        onSettingsClick={() => setShowSettings(true)}
        title={project?.name || 'Workspace'}
        centerTitle
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="graph-page__body">
        <main className="graph-page__main" id="graph-main">
          <div className="graph-page__toolbar">
            <div className="graph-page__toolbar-chip graph-page__toolbar-chip--primary">
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>hub</span>
              Graph Workspace
            </div>
            <div className="graph-page__toolbar-chip">
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>tune</span>
              Preset: {project?.preset || 'Graph'}
            </div>
            <div className="graph-page__toolbar-actions">
              <button type="button" className="graph-page__toolbar-btn" onClick={() => handleCreateNode('Image')}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>image</span>
                Add Image Node
              </button>
              <button type="button" className="graph-page__toolbar-btn graph-page__toolbar-btn--secondary" onClick={() => handleCreateNode('Image Edit')}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>photo_filter</span>
                Add Image Edit Node
              </button>
            </div>
          </div>

          <div className="graph-page__canvas-shell">
            {showEmptyState && (
              <div className="graph-page__empty-state">
                <div className="graph-page__empty-icon">
                  <span className="material-symbols-outlined">account_tree</span>
                </div>
                <div className="graph-page__empty-copy">
                  <h2 className="graph-page__empty-title font-headline">Empty workflow graph</h2>
                  <p className="graph-page__empty-text">
                    Start by adding an Image node or an Image Edit node.
                  </p>
                </div>
              </div>
            )}

            {loading && (
              <div className="graph-page__loading font-label">Loading graph…</div>
            )}

            <ReactFlow
              className="graph-page__canvas"
              nodes={nodes}
              edges={edges}
              nodeTypes={flowNodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              onNodeDragStop={handleNodeDragStop}
              onEdgesDelete={handleEdgesDelete}
              defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
              minZoom={0.2}
              maxZoom={2}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} color="rgba(143, 245, 255, 0.14)" />
              <MiniMap pannable zoomable className="graph-page__minimap" nodeColor={minimapNodeColor} />
              <Controls className="graph-page__controls" showInteractive={false} />
            </ReactFlow>
          </div>
        </main>
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
