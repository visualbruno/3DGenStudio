// One row in the Animations tab: an animation clip's mp4 preview (plays on hover)
// plus its name. Clicking the tile retargets + plays the clip on the user's mesh;
// the corner checkbox marks it for inclusion when the mesh is saved.
import { useRef, useState } from 'react'

export default function AnimationClipItem({ name, previewUrl, selected, busy, checked, onSelect, onToggleChecked }) {
  const videoRef = useRef(null)
  const [failed, setFailed] = useState(false)

  const handleEnter = () => {
    const v = videoRef.current
    if (v) { v.currentTime = 0; v.play().catch(() => {}) }
  }
  const handleLeave = () => {
    const v = videoRef.current
    if (v) { v.pause(); v.currentTime = 0 }
  }

  return (
    <div
      className={`mesh-editor-anim-item ${selected ? 'mesh-editor-anim-item--selected' : ''} ${checked ? 'mesh-editor-anim-item--checked' : ''}`}
      onClick={onSelect}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      title={`Play "${name}" on your mesh`}
    >
      <div className="mesh-editor-anim-item__thumb">
        {previewUrl && !failed ? (
          <video
            ref={videoRef}
            src={previewUrl}
            muted
            loop
            playsInline
            preload="none"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="material-symbols-outlined">movie</span>
        )}
        <label
          className="mesh-editor-anim-item__check"
          title={checked ? 'Remove from saved mesh' : 'Include in saved mesh'}
          onClick={e => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={!!checked}
            onChange={e => { e.stopPropagation(); onToggleChecked?.() }}
          />
        </label>
        {busy && (
          <span className="material-symbols-outlined mesh-editor-anim-item__spinner">progress_activity</span>
        )}
        {selected && !busy && (
          <span className="material-symbols-outlined mesh-editor-anim-item__playing">play_arrow</span>
        )}
      </div>
      <span className="mesh-editor-anim-item__name">{name}</span>
    </div>
  )
}
