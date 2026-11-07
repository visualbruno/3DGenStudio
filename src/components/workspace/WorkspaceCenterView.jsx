// Center of the Workspace: the selected history entry, large (an image, or a
// mesh in an orbitable viewer), with what made it and what can be done next.
import { useState } from 'react'
import { assetUrl } from '../../config'
import { workflowLabel } from '../../utils/workspaceImage'
import { formatFaceCount, meshWorkflowLabel } from '../../utils/workspaceMesh'
import Viewer from '../Viewer'
import WorkspaceViewToolbar from './WorkspaceViewToolbar'

const ACTION_LABELS = { generate: 'Generated', edit: 'Edited', import: 'Imported' }

function formatDate(timestamp) {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

const VIEW_SETTINGS_KEY = 'workspace.meshView.v1'
const DEFAULT_VIEW_SETTINGS = { wireframe: false, shading: 'textured', texture: 'pbr', skeleton: true }

// Per-viewer convenience: the display mode survives a reload when storage works.
function readViewSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VIEW_SETTINGS_KEY) || 'null')
    return parsed && typeof parsed === 'object' ? { ...DEFAULT_VIEW_SETTINGS, ...parsed } : DEFAULT_VIEW_SETTINGS
  } catch {
    return DEFAULT_VIEW_SETTINGS
  }
}

function writeViewSettings(settings) {
  try {
    window.localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable — nothing to keep
  }
}

// Keyed by asset id by the caller, so the stats reset with the model. The
// display settings live one level up, so they carry over between meshes.
function MeshStage({ url, view, onViewChange, clipRequest, showBoneLabels = false }) {
  const [stats, setStats] = useState(null)
  const [rigged, setRigged] = useState(false)
  const [clips, setClips] = useState([])
  const [clip, setClip] = useState(null)
  const [appliedRequest, setAppliedRequest] = useState(null)
  // The Animate module asks for the clip it just saved; honoured once the
  // model (and its clip list) has loaded.
  if (clipRequest && clipRequest.nonce !== appliedRequest && clips.some(c => c.name === clipRequest.clip)) {
    setAppliedRequest(clipRequest.nonce)
    setClip(clipRequest.clip)
  }
  return (
    <div className="workspace-center__mesh">
      <WorkspaceViewToolbar settings={view} onChange={onViewChange} rigged={rigged} />
      {clips.length > 0 && (
        <div className="workspace-center__clips" role="toolbar" aria-label="Animations">
          <span className="material-symbols-outlined" title="Animations in this mesh">animation</span>
          <button type="button" className={`workspace-center__clip ${clip ? '' : 'workspace-center__clip--active'}`} onClick={() => setClip(null)} title="Rest pose">
            <span className="material-symbols-outlined">stop</span>
          </button>
          {clips.map(c => (
            <button
              key={c.name}
              type="button"
              className={`workspace-center__clip ${clip === c.name ? 'workspace-center__clip--active' : ''}`}
              onClick={() => setClip(clip === c.name ? null : c.name)}
              title={`${c.name} - ${c.duration}s`}
            >
              {clip === c.name && <span className="material-symbols-outlined">play_arrow</span>}
              {c.name}
            </button>
          ))}
        </div>
      )}
      <Viewer
        height="100%"
        modelUrl={url}
        // True placement: a mesh that floats or sinks shows it, and Align to
        // the Ground is seen to drop it onto the grid.
        fitMode="actual"
        showWireframe={view.wireframe}
        showSolid={view.shading === 'solid'}
        wireframeColor={view.shading === 'solid' ? '#22262b' : '#ffffff'}
        wireframeOpacity={view.shading === 'solid' ? 0.55 : 0.36}
        showNormals={view.shading === 'normal'}
        showAlbedo={view.shading === 'textured' && view.texture === 'unlit'}
        // Bone labels (Rig module) bring the skeleton with them: names floating
        // over hidden bones would only confuse.
        showSkeleton={rigged && (Boolean(view.skeleton) || showBoneLabels)}
        showBoneNames={rigged && showBoneLabels}
        animationClip={clip}
        onModelLoaded={({ stats: loaded, isRigged, clips: loadedClips }) => {
          setStats(loaded || null)
          setRigged(Boolean(isRigged))
          setClips(Array.isArray(loadedClips) ? loadedClips : [])
        }}
      />
      {stats && (
        <div className="workspace-center__stats">
          <span><strong>{stats.faceCount.toLocaleString()}</strong> faces</span>
          <span><strong>{stats.vertexCount.toLocaleString()}</strong> vertices</span>
        </div>
      )}
    </div>
  )
}

export default function WorkspaceCenterView({
  entry,
  sourceEntry,
  emptyTitle,
  emptyText,
  onEdit,
  onMakeMesh,
  onRetopo,
  onAutoUv,
  onTexture,
  onRig,
  onReuse,
  onSelectEntry,
  onOpenInEditor,
  onAnimate,
  clipRequest,
  showBoneLabels = false
}) {
  const [view, setView] = useState(readViewSettings)
  const changeView = (next) => {
    setView(next)
    writeViewSettings(next)
  }

  if (!entry) {
    return (
      <div className="workspace-center workspace-center--empty">
        <span className="material-symbols-outlined workspace-center__empty-icon">imagesmode</span>
        <h2 className="workspace-center__empty-title">{emptyTitle}</h2>
        <p className="workspace-center__empty-text">{emptyText}</p>
      </div>
    )
  }

  const { asset } = entry
  const isImage = asset.type === 'image'
  const isMesh = asset.type === 'mesh'
  const params = entry.params || {}
  const modelLabel = entry.workflowName
    ? (entry.module === 'mesh' ? meshWorkflowLabel({ name: entry.workflowName }) : workflowLabel({ name: entry.workflowName }))
    : ''

  return (
    <div className="workspace-center">
      <div className={`workspace-center__stage ${isMesh ? 'workspace-center__stage--mesh' : ''}`}>
        {isImage && (
          <img key={asset.id} src={assetUrl(asset.filename)} alt={asset.name} className="workspace-center__image" />
        )}
        {isMesh && (
          <MeshStage
            key={asset.id}
            url={assetUrl(asset.filename)}
            view={view}
            onViewChange={changeView}
            clipRequest={clipRequest?.assetId === asset.id ? clipRequest : null}
            showBoneLabels={showBoneLabels}
          />
        )}
        {!isImage && !isMesh && (
          <div className="workspace-center__empty-text">No preview for this kind of asset.</div>
        )}
      </div>

      <div className="workspace-center__info">
        <div className="workspace-center__meta">
          <span className={`workspace-center__tag workspace-center__tag--${entry.action}`}>
            {isMesh && entry.action === 'generate' ? '3D Model' : (ACTION_LABELS[entry.action] || entry.action)}
          </span>
          {modelLabel && (
            <span className="workspace-center__meta-item" title={entry.workflowName}>
              <span className="material-symbols-outlined">account_tree</span>
              {modelLabel}
            </span>
          )}
          {isImage && asset.width > 0 && (
            <span className="workspace-center__meta-item">
              <span className="material-symbols-outlined">aspect_ratio</span>
              {asset.width} × {asset.height}
            </span>
          )}
          {params.faces && (
            <span className="workspace-center__meta-item" title="Target face count">
              <span className="material-symbols-outlined">change_history</span>
              {formatFaceCount(params.faces)} target
            </span>
          )}
          {params.textureSize && (
            <span className="workspace-center__meta-item" title="Texture size">
              <span className="material-symbols-outlined">texture</span>
              {params.textureSize}px
            </span>
          )}
          {Array.isArray(params.summary) && params.summary.map(row => (
            <span key={row.label} className="workspace-center__meta-item">
              {row.label}: <strong>{String(row.value)}</strong>
            </span>
          ))}
          {params.seed !== undefined && (
            <span className="workspace-center__meta-item" title="Seed">
              <span className="material-symbols-outlined">casino</span>
              {params.seed}
            </span>
          )}
          <span className="workspace-center__meta-item">
            <span className="material-symbols-outlined">schedule</span>
            {formatDate(entry.createdAt)}
          </span>
          {sourceEntry && (
            <button type="button" className="workspace-center__link" onClick={() => onSelectEntry(sourceEntry)}>
              <span className="material-symbols-outlined">subdirectory_arrow_left</span>
              {isMesh ? 'Show source image' : 'Show source'}
            </button>
          )}
        </div>

        {entry.prompt && <p className="workspace-center__prompt">{entry.prompt}</p>}

        <div className="workspace-center__actions">
          {isImage && (
            <button type="button" className="workspace-action-btn workspace-action-btn--primary" onClick={() => onMakeMesh(entry)}>
              <span className="material-symbols-outlined">deployed_code</span>
              Make 3D model
            </button>
          )}
          {isImage && (
            <button type="button" className="workspace-action-btn" onClick={() => onEdit(entry)}>
              <span className="material-symbols-outlined">auto_fix_high</span>
              Edit this image
            </button>
          )}
          {isMesh && (
            <button type="button" className="workspace-action-btn workspace-action-btn--primary" onClick={() => onRetopo(entry)} title="Repair, retopologize or optimize this mesh">
              <span className="material-symbols-outlined">grid_4x4</span>
              Retopology
            </button>
          )}
          {isMesh && (
            <button type="button" className="workspace-action-btn" onClick={() => onAutoUv(entry)} title="Unwrap new UVs for this mesh">
              <span className="material-symbols-outlined">view_quilt</span>
              Auto UV
            </button>
          )}
          {isMesh && (
            <button type="button" className="workspace-action-btn" onClick={() => onTexture(entry)} title="Texture this mesh from an image, or bake a high poly onto it">
              <span className="material-symbols-outlined">texture</span>
              Texture
            </button>
          )}
          {isMesh && (
            <button type="button" className="workspace-action-btn" onClick={() => onRig(entry)} title="Add a skeleton and skin weights">
              <span className="material-symbols-outlined">accessibility_new</span>
              Auto Rig
            </button>
          )}
          {isMesh && onAnimate && (
            <button type="button" className="workspace-action-btn" onClick={() => onAnimate(entry)} title="Describe a motion and let an AI animate this rigged mesh">
              <span className="material-symbols-outlined">animation</span>
              Animate
            </button>
          )}
          {entry.action !== 'import' && (
            <button type="button" className="workspace-action-btn" onClick={() => onReuse(entry)} title="Load this model and its settings into the panel">
              <span className="material-symbols-outlined">replay</span>
              Reuse settings
            </button>
          )}
          {(isImage || isMesh) && (
            <button
              type="button"
              className="workspace-action-btn"
              onClick={() => onOpenInEditor(entry)}
              title={isMesh ? 'Sculpt, texture, rig… in the full Mesh Editor' : 'Layers, paint, crop, inpaint… in the full Image Editor'}
            >
              <span className="material-symbols-outlined">open_in_new</span>
              {isMesh ? 'Mesh Editor' : 'Image Editor'}
            </button>
          )}
          <a className="workspace-action-btn" href={assetUrl(asset.filename)} download>
            <span className="material-symbols-outlined">download</span>
            Download
          </a>
        </div>
      </div>
    </div>
  )
}
