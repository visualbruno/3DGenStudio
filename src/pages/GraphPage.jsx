import { useCallback, useState } from 'react'
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState
} from '@xyflow/react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import '@xyflow/react/dist/style.css'
import './GraphPage.css'

function GraphCanvas() {
  const [nodes, , onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  const handleConnect = useCallback(
    connection => setEdges(currentEdges => addEdge({ ...connection, type: 'smoothstep', animated: true }, currentEdges)),
    [setEdges]
  )

  return (
    <div className="graph-page__canvas-shell">
      <div className="graph-page__empty-state">
        <div className="graph-page__empty-icon">
          <span className="material-symbols-outlined">account_tree</span>
        </div>
        <div className="graph-page__empty-copy">
          <h2 className="graph-page__empty-title font-headline">Empty workflow graph</h2>
          <p className="graph-page__empty-text">
            This Graph workspace starts empty so you can build a node workflow like ComfyUI.
          </p>
        </div>
      </div>

      <ReactFlow
        className="graph-page__canvas"
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="rgba(143, 245, 255, 0.14)" />
        <MiniMap pannable zoomable className="graph-page__minimap" />
        <Controls className="graph-page__controls" showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

export default function GraphPage({ project }) {
  const [showSettings, setShowSettings] = useState(false)

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
          </div>

          <ReactFlowProvider>
            <GraphCanvas />
          </ReactFlowProvider>
        </main>
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
