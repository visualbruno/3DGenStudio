// Animation edit dock: the full-width strip under the mesh-editor workspace that
// appears in Auto Rig mode while a retargeted clip is playing.
//
// Opening it PAUSES the preview and holds it at the selected frame — the whole
// point is to see one pose while you correct it. Playback is still available, but
// while it runs the frame controls are inert: following the mixer live would mean
// a state update (and a re-render of the whole editor page) every frame.
//
// The clip being edited is the RETARGETED one — your mesh's own bones, the same
// object the mixer is playing and the same one Save writes out — so edits show up
// on the mesh as you type, with no rebake.
//
// Presentational: every value comes from the clip description the page passes in,
// and every change goes back out through a handler.
import { useEffect, useMemo, useRef, useState } from 'react'
import { EDIT_SCOPES, MAX_EDIT_SPAN, readFrameValues } from '../../utils/animationEdit'

// One editable axis. Kept as local text so typing "-" or "1." is possible, and
// committed on Enter/blur — a commit per keystroke would rewrite the whole track
// on every character.
function AxisField({ label, value, disabled, onCommit }) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const display = editing ? text : (value == null ? '' : formatNumber(value))

  return (
    <label className="mesh-editor-anim-dock__axis">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        className="mesh-editor-panel__input"
        value={display}
        disabled={disabled}
        onFocus={e => { setEditing(true); setText(e.target.value) }}
        onChange={e => setText(e.target.value)}
        onBlur={() => { setEditing(false); commit(text, value, onCommit) }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          else if (e.key === 'Escape') { setEditing(false); e.currentTarget.blur() }
        }}
      />
    </label>
  )
}

// Drops this frame's own value for one track: the frame takes what interpolation
// between its neighbours gives, i.e. what deleting its key would look like. It cannot
// literally delete the key — a sparse track leaves the frame grid the whole dock is
// built on (frame == index) — and this is indistinguishable on screen.
function ClearButton({ disabled, onClick, what, frame }) {
  return (
    <button
      type="button"
      className="mesh-editor-icon-btn mesh-editor-anim-dock__clear"
      onClick={onClick}
      disabled={disabled}
      title={`Clear this bone's ${what} at frame ${frame} — the frame drops its own value and takes the one between its neighbours`}
      aria-label={`Clear ${what} at frame ${frame}`}
    >
      <span className="material-symbols-outlined">delete</span>
    </button>
  )
}

function commit(text, value, onCommit) {
  const next = Number(String(text).trim())
  if (!Number.isFinite(next) || next === value) return
  onCommit(next)
}

function formatNumber(v) {
  if (!Number.isFinite(v)) return ''
  const abs = Math.abs(v)
  return abs >= 100 ? v.toFixed(2) : abs >= 1 ? v.toFixed(3) : v.toFixed(4)
}

function timeLabel(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.round((s % 1) * 100)).padStart(2, '0')}`
}

// Save the clip on screen — hand edits included — to the custom-animation
// library, where it can be put on any other rigged mesh later.
//
// The name field is inline rather than a modal: this is a two-second action at
// the end of an edit, and the only decision in it is what to call the result.
// It defaults to the clip's own name, which is right more often than not.
function SaveAnimationControl({ clipName, saving, onSave }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (open) inputRef.current?.select() }, [open])

  if (!onSave) return null

  if (!open) {
    return (
      <button
        type="button"
        className="mesh-editor-btn mesh-editor-btn--ghost"
        onClick={() => { setName(clipName || ''); setOpen(true) }}
        title="Save this animation — with the edits — to your custom animations, so it can be applied to any other rigged mesh later"
      >
        <span className="material-symbols-outlined">bookmark_add</span>
        <span>Save animation</span>
      </button>
    )
  }

  const commit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await onSave(trimmed)
    setOpen(false)
  }

  return (
    <div className="mesh-editor-anim-dock__save">
      <input
        ref={inputRef}
        type="text"
        className="mesh-editor-panel__input"
        value={name}
        disabled={saving}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="Animation name"
        aria-label="Name for the saved animation"
      />
      <button
        type="button"
        className="mesh-editor-icon-btn"
        onClick={commit}
        disabled={saving || !name.trim()}
        title="Save it"
      >
        <span className="material-symbols-outlined">{saving ? 'progress_activity' : 'check'}</span>
      </button>
      <button
        type="button"
        className="mesh-editor-icon-btn"
        onClick={() => setOpen(false)}
        disabled={saving}
        title="Cancel"
      >
        <span className="material-symbols-outlined">close</span>
      </button>
    </div>
  )
}

export default function AnimationEditPanel({
  clipName,
  description,          // from describeClip: { fps, frameCount, duration, times, bones }
  clip,                 // the live clip object — read directly, see `revision`
  revision,             // bumped on every edit so the fields re-read the mutated clip
  frame,
  onFrameChange,
  playing,
  onTogglePlay,
  selectedBone,         // bone NAME, or null
  onSelectBone,
  scope,
  onScopeChange,
  span,
  onSpanChange,
  onEdit,               // (trackName, [x, y, z]) — nulls mean "leave this axis"
  onClearValue,         // (trackName) — this frame takes the value between its neighbours
  onClearBone,          // (boneName) — every frame of that bone takes its rest pose
  allBones,             // every bone NAME in the rig, hierarchy order — see `rows`
  onAddBone,            // (boneName) — give a bone the clip ignores a rotation track
  onFrameOperation,     // ('insert' | 'append' | 'delete' | 'trimBefore' | 'trimAfter')
  onSmoothLoop,         // ease the last `seamFrames` into the start pose
  seamFrames,
  onSeamFramesChange,
  gizmoMode,            // 'translate' | 'rotate' — which gizmo the bone carries
  onGizmoModeChange,
  onAddPositionTrack,
  canAddPositionTrack,
  onCopyPose,
  onPastePose,
  copiedPose,           // { frame, clipName, bones } or null — what the clipboard holds
  edited,
  onRevert,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSaveCustom,         // (name) — store this clip in the custom-animation library
  savingCustom,
  onClose,
}) {
  const [search, setSearch] = useState('')
  const rowRefs = useRef(new Map())
  const bones = useMemo(() => description?.bones || [], [description])
  // The list is the RIG, not the clip. A clip only carries tracks for the bones its
  // reference could be mapped onto, so a tail, an ear or one of Auto Rig's leftover
  // `extra_*` bones simply had no row — and no way to be animated at all. Bones the
  // clip does not drive are listed too, and adding one is a click.
  //
  // Hierarchy order comes from the skeleton; a described bone that is somehow not in
  // it (a renamed rig mid-session) is kept at the end rather than dropped.
  const rows = useMemo(() => {
    if (!allBones?.length) return bones
    const described = new Map(bones.map(b => [b.boneName, b]))
    const ordered = allBones.map(name => described.get(name) || {
      boneName: name, rotation: null, position: null, editable: true, keyCount: 0,
    })
    const seen = new Set(allBones)
    return [...ordered, ...bones.filter(b => !seen.has(b.boneName))]
  }, [bones, allBones])
  const animatedCount = bones.length
  const frameCount = description?.frameCount || 0
  const row = useMemo(
    () => rows.find(b => b.boneName === selectedBone) || null,
    [rows, selectedBone],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(b => b.boneName.toLowerCase().includes(q))
  }, [rows, search])

  // Values are read straight off the clip, which is mutated in place — `revision`
  // and `frame` are what make that safe to memoise.
  const rotation = useMemo(
    () => (clip && row?.rotation ? readFrameValues(clip, row.rotation, frame) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clip, row?.rotation, frame, revision],
  )
  const position = useMemo(
    () => (clip && row?.position ? readFrameValues(clip, row.position, frame) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clip, row?.position, frame, revision],
  )

  // Keep the selected bone's row visible when the selection comes from the
  // viewport or the skeleton tree rather than from this list.
  useEffect(() => {
    if (selectedBone) rowRefs.current.get(selectedBone)?.scrollIntoView({ block: 'nearest' })
  }, [selectedBone])

  const step = delta => onFrameChange(Math.max(0, Math.min(frameCount - 1, frame + delta)))
  const fieldsDisabled = playing || !row?.editable

  return (
    <section className="mesh-editor-anim-dock" aria-label="Animation edit">
      <header className="mesh-editor-anim-dock__head">
        <span className="mesh-editor-anim-dock__title">
          <span className="material-symbols-outlined">animation</span>
          <span>{clipName || 'Animation'}</span>
        </span>
        {edited && (
          <span className="mesh-editor-anim-dock__badge" title="This clip has hand edits">edited</span>
        )}

        <div className="mesh-editor-anim-dock__transport">
          <button type="button" className="mesh-editor-icon-btn" onClick={() => onFrameChange(0)}
            disabled={playing} title="First frame">
            <span className="material-symbols-outlined">first_page</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" onClick={() => step(-1)}
            disabled={playing || frame <= 0} title="Previous frame">
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" onClick={onTogglePlay}
            title={playing ? 'Pause at the current frame' : 'Play the clip'}>
            <span className="material-symbols-outlined">{playing ? 'pause' : 'play_arrow'}</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" onClick={() => step(1)}
            disabled={playing || frame >= frameCount - 1} title="Next frame">
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" onClick={() => onFrameChange(frameCount - 1)}
            disabled={playing} title="Last frame">
            <span className="material-symbols-outlined">last_page</span>
          </button>

          <input
            type="number"
            className="mesh-editor-panel__input mesh-editor-anim-dock__frame"
            min={0}
            max={Math.max(0, frameCount - 1)}
            step={1}
            value={frame}
            disabled={playing}
            onChange={e => onFrameChange(Number(e.target.value))}
            aria-label="Frame"
          />
          <span className="mesh-editor-panel__hint">
            / {Math.max(0, frameCount - 1)} · {timeLabel(description?.times?.[frame] ?? 0)}
            {description?.fps ? ` · ${Math.round(description.fps)} fps` : ''}
          </span>
        </div>

        <div className="mesh-editor-anim-dock__head-actions">
          <SaveAnimationControl
            clipName={clipName}
            saving={savingCustom}
            onSave={onSaveCustom}
          />
          <button type="button" className="mesh-editor-icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo the last edit">
            <span className="material-symbols-outlined">undo</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo">
            <span className="material-symbols-outlined">redo</span>
          </button>
          <button type="button" className="mesh-editor-btn mesh-editor-btn--ghost" onClick={onRevert} disabled={!edited}
            title="Throw the hand edits away and rebake this clip from the current settings">
            <span className="material-symbols-outlined">restart_alt</span>
            <span>Revert</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" onClick={onClose} title="Close the animation editor">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      </header>

      {/* Scrub bar, plus the frame-structure buttons on the same row — they cost no
          vertical space there, and the dock's height is a fixed budget.

          A range input rather than a canvas timeline: the bake puts a key on every
          frame, so there are no per-key marks to draw. */}
      <div className="mesh-editor-anim-dock__scrub-row">
        <input
          type="range"
          className="mesh-editor-anim-dock__scrub"
          min={0}
          max={Math.max(0, frameCount - 1)}
          step={1}
          value={frame}
          disabled={playing}
          onChange={e => onFrameChange(Number(e.target.value))}
          aria-label="Scrub to frame"
        />

        <div className="mesh-editor-anim-dock__frame-ops">
          <button type="button" className="mesh-editor-icon-btn" disabled={playing}
            onClick={() => onFrameOperation?.('insert')}
            title="Insert a copy of this frame after it — the pose is held one frame longer">
            <span className="material-symbols-outlined">add</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" disabled={playing || frameCount <= 2}
            onClick={() => onFrameOperation?.('delete')}
            title="Delete this frame — the clip gets one frame shorter, the speed does not change">
            <span className="material-symbols-outlined">remove</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" disabled={playing}
            onClick={() => onFrameOperation?.('append')}
            title="Append a copy of the last frame at the end of the clip">
            <span className="material-symbols-outlined">playlist_add</span>
          </button>
        </div>

        {/* Copy / paste the whole frame — every animated bone at once. The loop
            workflow in one line: copy frame 0, go to the last frame, paste. */}
        <div className="mesh-editor-anim-dock__frame-ops">
          <button type="button" className="mesh-editor-icon-btn" disabled={playing}
            onClick={onCopyPose}
            title="Copy this frame's pose — every animated bone's rotation, plus the hip position">
            <span className="material-symbols-outlined">content_copy</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" disabled={playing || !copiedPose}
            onClick={onPastePose}
            title={copiedPose
              ? `Paste the pose copied from frame ${copiedPose.frame}${copiedPose.clipName ? ` of “${copiedPose.clipName}”` : ''} (${copiedPose.bones} tracks) onto frame ${frame}. Follows "Apply to": with a falloff the neighbouring frames ease into it.`
              : 'Nothing copied yet — copy a frame first'}>
            <span className="material-symbols-outlined">content_paste</span>
          </button>

        </div>

        {/* The pair that actually closes a loop: a generated walk usually just ends a
            dozen frames past where the cycle repeats. */}
        <div className="mesh-editor-anim-dock__frame-ops">
          <button type="button" className="mesh-editor-icon-btn" disabled={playing || frame === 0}
            onClick={() => onFrameOperation?.('trimBefore')}
            title="Delete every frame BEFORE this one (this frame becomes frame 0)">
            <span className="material-symbols-outlined">keyboard_double_arrow_left</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" disabled={playing || frame >= frameCount - 1}
            onClick={() => onFrameOperation?.('trimAfter')}
            title="Delete every frame AFTER this one (this frame becomes the last) — the usual way to make a generated cycle loop">
            <span className="material-symbols-outlined">keyboard_double_arrow_right</span>
          </button>

          {/* The finishing move after a trim: the trim decides WHERE the cycle ends,
              this makes the crossing itself smooth. Its own frame count, because the
              answer here is "as few as get the job done" — every extra frame bends
              more of the tail towards the start pose. */}
          <button type="button" className="mesh-editor-icon-btn" disabled={playing || frameCount < 3}
            onClick={onSmoothLoop}
            title={`Smooth transition — rewrite the last ${seamFrames} frame${seamFrames === 1 ? '' : 's'} so the loop crosses the seam at the clip's own rate instead of jolting. Forward travel is left alone (blending it would slide the character backwards), as is anything already smooth.`}>
            <span className="material-symbols-outlined">all_inclusive</span>
          </button>
          <label className="mesh-editor-anim-dock__axis mesh-editor-anim-dock__seam"
            title="How many frames the transition is spread over. 1 rewrites only the last frame; raise it when the seam still jolts, lower it if the motion visibly runs backwards into the loop point.">
            <input
              type="number"
              className="mesh-editor-panel__input"
              min={1}
              max={Math.max(1, frameCount - 2)}
              step={1}
              value={seamFrames}
              disabled={playing}
              onChange={e => onSeamFramesChange?.(Math.max(1, Number(e.target.value) || 1))}
              aria-label="Transition frames"
            />
          </label>
        </div>
      </div>

      <div className="mesh-editor-anim-dock__body">
        <div className="mesh-editor-anim-dock__bones">
          <div className="mesh-editor-anim-dock__bones-head">
            <span className="mesh-editor-panel__hint">Bones ({rows.length}) · {animatedCount} animated</span>
          </div>
          {rows.length > 8 && (
            <div className="mesh-editor-anim__search">
              <span className="material-symbols-outlined">search</span>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search bones…"
                aria-label="Search animated bones"
              />
              {search && (
                <button type="button" className="mesh-editor-anim__search-clear" onClick={() => setSearch('')}
                  title="Clear search" aria-label="Clear search">
                  <span className="material-symbols-outlined">close</span>
                </button>
              )}
            </div>
          )}
          <div className="mesh-editor-anim-dock__bones-list">
            {filtered.length === 0 ? (
              <div className="mesh-editor-layers-panel__empty">No bone matches that.</div>
            ) : filtered.map(b => (
              <div
                key={b.boneName}
                role="button"
                tabIndex={0}
                ref={el => { if (el) rowRefs.current.set(b.boneName, el); else rowRefs.current.delete(b.boneName) }}
                className={`mesh-editor-anim-dock__bone ${b.boneName === selectedBone ? 'mesh-editor-anim-dock__bone--selected' : ''} ${b.rotation || b.position ? '' : 'mesh-editor-anim-dock__bone--idle'}`}
                onClick={() => onSelectBone(b.boneName)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectBone(b.boneName) }
                }}
                title={b.editable
                  ? (b.rotation || b.position
                    ? `${b.boneName} — ${b.rotation ? 'rotation' : ''}${b.rotation && b.position ? ' + ' : ''}${b.position ? 'position' : ''}`
                    : `${b.boneName} is not animated by this clip — add it to pose it`)
                  : `${b.boneName} is driven by the Hand curl sliders (${b.keyCount} keys, off the frame grid) and is rebuilt on every bake — not editable here`}
              >
                <span className="mesh-editor-anim-dock__bone-name">{b.boneName}</span>
                {b.position && <span className="material-symbols-outlined" title="Has a position track">open_with</span>}
                {!b.editable && <span className="material-symbols-outlined">lock</span>}
                {/* Two mutually exclusive actions, because a row is in one of two
                    states: a bone the clip drives can be cleared, and one it
                    ignores can be brought in. */}
                {b.editable && onClearBone && (b.rotation || b.position) && (
                  <button
                    type="button"
                    className="mesh-editor-icon-btn mesh-editor-anim-dock__bone-clear"
                    onClick={e => { e.stopPropagation(); onClearBone(b.boneName) }}
                    disabled={playing}
                    title={playing
                      ? 'Pause the clip to clear a bone'
                      : `Clear ${b.boneName}'s animation — every frame takes the bone's rest pose, so the clip stops moving it. Undoable.`}
                    aria-label={`Clear ${b.boneName}'s animation`}
                  >
                    <span className="material-symbols-outlined">delete_sweep</span>
                  </button>
                )}
                {b.editable && onAddBone && !b.rotation && !b.position && (
                  <button
                    type="button"
                    className="mesh-editor-icon-btn mesh-editor-anim-dock__bone-add"
                    onClick={e => { e.stopPropagation(); onAddBone(b.boneName) }}
                    disabled={playing}
                    title={playing
                      ? 'Pause the clip to add a bone'
                      : `Add ${b.boneName} to this animation — every frame starts at its rest pose, so nothing changes until you pose it`}
                    aria-label={`Add ${b.boneName} to this animation`}
                  >
                    <span className="material-symbols-outlined">add</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mesh-editor-anim-dock__editor">
          {!row ? (
            <div className="mesh-editor-layers-panel__empty">
              Pick a bone — on the list, in the Skeleton tab, or on the mesh — to edit its pose at
              this frame.
            </div>
          ) : (
            <>
              <div className="mesh-editor-anim-dock__editor-head">
                <strong>{row.boneName}</strong>
                <span className="mesh-editor-panel__hint">frame {frame}</span>
                {!row.editable && (
                  <span className="mesh-editor-anim-dock__badge mesh-editor-anim-dock__badge--warn">locked</span>
                )}

                {/* Which gizmo the bone carries in the viewport. Right-clicking the
                    bone on the mesh flips it too — this is the discoverable half. */}
                <div className="mesh-editor-anim-dock__gizmo">
                  {[
                    { value: 'translate', icon: 'open_with', label: 'Move' },
                    { value: 'rotate', icon: 'rotate_right', label: 'Rotate' },
                  ].map(m => (
                    <button
                      key={m.value}
                      type="button"
                      className={`mesh-editor-anim-dock__scope ${gizmoMode === m.value ? 'mesh-editor-anim-dock__scope--on' : ''}`}
                      onClick={() => onGizmoModeChange?.(m.value)}
                      aria-pressed={gizmoMode === m.value}
                      disabled={playing}
                      title={m.value === 'translate'
                        ? 'Drag the bone along the world axes. A bone with no position track gets one the first time you move it.'
                        : 'Rotate the bone about its own axes'}
                    >
                      <span className="material-symbols-outlined">{m.icon}</span>
                      <span>{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* The bone is in the rig but not in the clip. Adding it is the same
                  operation the gizmo performs on the first drag, offered here so it
                  does not depend on finding the gizmo first. */}
              {!rotation && row.editable && (
                <div className="mesh-editor-anim-dock__row">
                  <span className="mesh-editor-anim-dock__row-label">Rotation (°)</span>
                  <button
                    type="button"
                    className="mesh-editor-anim-dock__scope"
                    onClick={() => onAddBone?.(row.boneName)}
                    disabled={playing || !onAddBone}
                    title="Give this bone a rotation track, every key at its rest pose — nothing moves until you edit it. Rotating the bone with the gizmo does this for you."
                  >
                    <span className="material-symbols-outlined">add</span>
                    <span>Add to animation</span>
                  </button>
                  <span className="mesh-editor-panel__hint">
                    This clip does not animate this bone — the reference it came from had nothing
                    mapped onto it.
                  </span>
                </div>
              )}


              {rotation && (
                <div className="mesh-editor-anim-dock__row">
                  <span className="mesh-editor-anim-dock__row-label">Rotation (°)</span>
                  {['X', 'Y', 'Z'].map((axis, i) => (
                    <AxisField
                      key={axis}
                      label={axis}
                      value={rotation[i]}
                      disabled={fieldsDisabled}
                      onCommit={v => onEdit(row.rotation, [i === 0 ? v : null, i === 1 ? v : null, i === 2 ? v : null])}
                    />
                  ))}
                  <ClearButton
                    disabled={fieldsDisabled}
                    onClick={() => onClearValue?.(row.rotation)}
                    what="rotation"
                    frame={frame}
                  />
                </div>
              )}

              {/* Only some bones come out of the bake with a position track — the hips,
                  normally. Any bone can have one; it just has to exist before there is
                  anything to type into. */}
              {!position && row.editable && (
                <div className="mesh-editor-anim-dock__row">
                  <span className="mesh-editor-anim-dock__row-label">Position</span>
                  <button
                    type="button"
                    className="mesh-editor-anim-dock__scope"
                    onClick={onAddPositionTrack}
                    disabled={playing || !canAddPositionTrack}
                    title="Add a position track to this bone, every key at its rest position — nothing moves until you edit it. Moving the bone with the gizmo does this for you."
                  >
                    <span className="material-symbols-outlined">add</span>
                    <span>Add position track</span>
                  </button>
                  <span className="mesh-editor-panel__hint">This bone is rotation-only so far.</span>
                </div>
              )}

              {position && (
                <div className="mesh-editor-anim-dock__row">
                  <span className="mesh-editor-anim-dock__row-label">Position</span>
                  {['X', 'Y', 'Z'].map((axis, i) => (
                    <AxisField
                      key={axis}
                      label={axis}
                      value={position[i]}
                      disabled={fieldsDisabled}
                      onCommit={v => onEdit(row.position, [i === 0 ? v : null, i === 1 ? v : null, i === 2 ? v : null])}
                    />
                  ))}
                  <ClearButton
                    disabled={fieldsDisabled}
                    onClick={() => onClearValue?.(row.position)}
                    what="position"
                    frame={frame}
                  />
                </div>
              )}

              {/* The bake carries a key on EVERY frame, so an edit confined to one
                  frame is a 33 ms pop, not a fix. This is where you say how far the
                  correction should reach. */}
              <div className="mesh-editor-anim-dock__row mesh-editor-anim-dock__row--scope">
                <span className="mesh-editor-anim-dock__row-label">Apply to</span>
                {EDIT_SCOPES.map(s => (
                  <button
                    key={s.value}
                    type="button"
                    className={`mesh-editor-anim-dock__scope ${scope === s.value ? 'mesh-editor-anim-dock__scope--on' : ''}`}
                    onClick={() => onScopeChange(s.value)}
                    aria-pressed={scope === s.value}
                    title={s.value === 'falloff'
                      ? 'Blend the correction out over the neighbouring frames — what you want for a baked clip'
                      : s.value === 'frame'
                        ? 'Change this frame only (a deliberate one-frame spike)'
                        : 'Offset every frame by the same correction — for a pose that is wrong throughout'}
                  >
                    {s.label}
                  </button>
                ))}
                {scope === 'falloff' && (
                  <label className="mesh-editor-anim-dock__axis">
                    <span>±frames</span>
                    <input
                      type="number"
                      className="mesh-editor-panel__input"
                      min={1}
                      max={MAX_EDIT_SPAN}
                      step={1}
                      value={span}
                      onChange={e => onSpanChange(Number(e.target.value))}
                    />
                  </label>
                )}
              </div>

              <span className="mesh-editor-panel__hint">
                Drag the gizmo on the mesh to pose this bone at this frame; right-click a bone to
                switch between Move and Rotate. Rotations are stored as quaternions, so a committed
                angle is read back from the quaternion — 190° comes back as −170°, and the pose is
                identical.
                {edited ? ' This clip is hand-edited: the rest-pose, in-place and hand-curl settings no longer rebake it. Revert to hand it back to the bake.' : ''}
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
