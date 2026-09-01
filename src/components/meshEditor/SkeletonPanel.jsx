// Right-hand panel shown in Auto Rig mode when the current mesh is rigged.
// Two tabs: "Skeleton" (a collapsible hierarchy tree of every bone) and
// "Animations".
//
// Bone selection is two-way with the viewport: clicking a bone row selects it
// (which highlights it on the mesh via SkeletonOverlay), and clicking a bone on
// the mesh selects the matching row here and scrolls it into view.
//
// The Skeleton tab doubles as the bone EDITOR: the "Edit" toggle in its header
// turns the tree into an editable one (rename, delete, drop unused bones) and
// arms the translate gizmo in the viewport — this is where an Auto Rig mistake
// gets fixed. Every operation is handed up through the `edit` prop bundle; the
// panel owns no rig state of its own.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ANIMATION_REFERENCES, animationPreviewUrl } from '../../utils/animationLibrary'
import AnimationClipItem from './AnimationClipItem'
import MeshToolProgress from './MeshToolProgress'

const EMPTY_SET = new Set()

// Build a children-index map + root list from the flat `parents` array.
function buildHierarchy(parents) {
  const children = new Map()
  const roots = []
  if (!parents) return { children, roots }
  parents.forEach((parent, index) => {
    if (parent < 0 || parent == null) {
      roots.push(index)
    } else {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(index)
    }
  })
  return { children, roots }
}

// A bone's share of the mesh's total skin weight, as a display string. This is
// the number that makes deleting safe to judge: 0% means the bone moves nothing.
function influenceLabel(influence, index) {
  if (!influence?.hasSkin) return null
  const weight = influence.weights[index] || 0
  if (!(influence.total > 0) || weight <= 0) return '0%'
  const pct = (weight / influence.total) * 100
  return pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`
}

function BoneNode({ index, depth, names, childMap, selectedBone, onSelectBone, collapsed, forcedOpen, onToggle, rowRefs, edit }) {
  const kids = childMap.get(index) || []
  const hasKids = kids.length > 0
  // A branch stays open if the user hasn't collapsed it, or if it's an ancestor
  // of the selected bone (so a bone picked on the mesh is always revealed).
  const isCollapsed = collapsed.has(index) && !forcedOpen.has(index)
  const isSelected = selectedBone === index

  return (
    <li className="mesh-editor-bone-tree__item">
      <div
        ref={el => { if (el) rowRefs.current.set(index, el); else rowRefs.current.delete(index) }}
        className={`mesh-editor-bone-tree__row ${isSelected ? 'mesh-editor-bone-tree__row--selected' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => onSelectBone(index)}
        title={names[index]}
      >
        {hasKids ? (
          <button
            type="button"
            className="mesh-editor-bone-tree__toggle"
            onClick={e => { e.stopPropagation(); onToggle(index) }}
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <span className="material-symbols-outlined">
              {isCollapsed ? 'chevron_right' : 'expand_more'}
            </span>
          </button>
        ) : (
          <span className="mesh-editor-bone-tree__toggle mesh-editor-bone-tree__toggle--leaf" />
        )}
        <span className="material-symbols-outlined mesh-editor-bone-tree__icon">
          {hasKids ? 'account_tree' : 'radio_button_unchecked'}
        </span>
        <span className="mesh-editor-bone-tree__name">{names[index]}</span>
        {edit?.active && (() => {
          const label = influenceLabel(edit.influence, index)
          if (!label) return null
          return (
            <span
              className={`mesh-editor-bone-tree__weight ${label === '0%' ? 'mesh-editor-bone-tree__weight--none' : ''}`}
              title={label === '0%'
                ? 'This bone moves no vertices'
                : `${edit.influence.counts[index]} vertices, ${label} of the mesh's skin weight`}
            >
              {label}
            </span>
          )
        })()}
        {edit?.active && (
          <>
            <button
              type="button"
              className="mesh-editor-bone-tree__action"
              onClick={e => { e.stopPropagation(); edit.onAddChild(index) }}
              title={`Add a child bone under ${names[index]}`}
            >
              <span className="material-symbols-outlined">add</span>
            </button>
            <button
              type="button"
              className="mesh-editor-bone-tree__action mesh-editor-bone-tree__action--danger"
              onClick={e => { e.stopPropagation(); edit.onDelete(index) }}
              title={`Delete ${names[index]} — its weights fold into its parent`}
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </>
        )}
      </div>
      {hasKids && !isCollapsed && (
        <ul className="mesh-editor-bone-tree__children">
          {kids.map(child => (
            <BoneNode
              key={child}
              index={child}
              depth={depth + 1}
              names={names}
              childMap={childMap}
              selectedBone={selectedBone}
              onSelectBone={onSelectBone}
              collapsed={collapsed}
              forcedOpen={forcedOpen}
              onToggle={onToggle}
              rowRefs={rowRefs}
              edit={edit}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

// Editing surface for the selected bone: rename, nudge along an axis, delete.
// The numeric fields are the precise counterpart to the viewport gizmo — dragging
// is for finding the spot, typing is for matching the other side of the body.
function BoneEditCard({ index, name, position, influence, canTakeWeights, edit }) {
  const [draftName, setDraftName] = useState(name)
  const [draftAxes, setDraftAxes] = useState(null)
  const [x, y, z] = position

  // Adopt whatever the rig now says whenever it changes underneath (selection,
  // gizmo drag, undo) — except for the field being typed in.
  useEffect(() => { setDraftName(name) }, [name])
  useEffect(() => { setDraftAxes(null) }, [index, x, y, z])

  const commitName = () => {
    if (draftName.trim() && draftName !== name) edit.onRename(index, draftName)
    else setDraftName(name)
  }

  const commitAxis = (axis, raw) => {
    const value = Number.parseFloat(raw)
    setDraftAxes(null)
    if (!Number.isFinite(value) || value === position[axis]) return
    const next = [...position]
    next[axis] = value
    edit.onMove(index, next)
  }

  const label = influenceLabel(influence, index)

  return (
    <div className="mesh-editor-bone-edit__card">
      <label className="mesh-editor-bone-edit__row">
        <span className="mesh-editor-panel__hint">Name</span>
        <input
          className="mesh-editor-panel__input"
          value={draftName}
          onChange={e => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { setDraftName(name); e.currentTarget.blur() }
          }}
        />
      </label>

      <div className="mesh-editor-bone-edit__axes">
        {['X', 'Y', 'Z'].map((axisName, axis) => (
          <label key={axisName} className="mesh-editor-bone-edit__axis">
            <span className="mesh-editor-panel__hint">{axisName}</span>
            <input
              className="mesh-editor-panel__input"
              type="number"
              step="0.01"
              value={draftAxes?.[axis] ?? position[axis].toFixed(4)}
              onChange={e => {
                const next = draftAxes ? [...draftAxes] : position.map(v => v.toFixed(4))
                next[axis] = e.target.value
                setDraftAxes(next)
              }}
              onBlur={e => commitAxis(axis, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
          </label>
        ))}
      </div>

      <span className="mesh-editor-panel__hint">
        {label
          ? `${influence.counts[index]} vertices · ${label} of skin weight`
          : 'No skin weights on this mesh'}
      </span>

      {/* A bone that moves nothing is either an attachment point or a joint that
          still needs its share of the surface — say which, and offer the fix. */}
      {label === '0%' && canTakeWeights && (
        <button
          type="button"
          className="mesh-editor-bone-edit__capture"
          onClick={() => edit.onTakeWeights(index)}
          title="Give this bone the parent's vertices that lie past it, blended across the joint"
        >
          <span className="material-symbols-outlined">colorize</span>
          <span>Take weights from parent</span>
        </button>
      )}

      <div className="mesh-editor-bone-edit__foot">
        <button
          type="button"
          className="mesh-editor-bone-edit__action-btn"
          onClick={() => edit.onAddChild(index)}
          title="Add a child bone under this one, then drag the gizmo to place it"
        >
          <span className="material-symbols-outlined">add</span>
          <span>Add child</span>
        </button>
        <button
          type="button"
          className="mesh-editor-bone-edit__action-btn mesh-editor-bone-edit__action-btn--danger"
          onClick={() => edit.onDelete(index)}
          title="Delete this bone — its weights fold into its parent and its children reattach there"
        >
          <span className="material-symbols-outlined">delete</span>
          <span>Delete bone</span>
        </button>
      </div>
    </div>
  )
}

// "Convert to in-place": strip the clip's horizontal travel so the character moves
// on the spot. A BAKE option, not a property of the motion — the clip keeps its
// travel and this is applied on the way onto the mesh, so it can be turned on and
// off for any clip (including ones generated before it existed) and it is what the
// animated GLB is saved with. Rebakes the clip, hence disabled mid-retarget.
function InPlaceToggle({ animation }) {
  return (
    <button
      type="button"
      className={`mesh-editor-anim__floor-btn ${animation?.inPlace ? 'mesh-editor-anim__floor-btn--on' : ''}`}
      onClick={animation?.onToggleInPlace}
      disabled={!!animation?.retargeting}
      aria-pressed={!!animation?.inPlace}
      title="Strip forward/sideways travel so the character animates on the spot. Jumps, crouches and turns are kept. Applies to the clip you play or save, not to the stored motion — untick it to get the travel back."
    >
      <span className="material-symbols-outlined">
        {animation?.inPlace ? 'check_box' : 'check_box_outline_blank'}
      </span>
      <span>Convert to in-place</span>
    </button>
  )
}

// The searchable clip grid + "save with N animations" button. Shared by the
// Animations tab (mesh2motion library clips) and the Kimodo tab (clips generated
// from a prompt): both feed the same retarget/preview/save pipeline, so the only
// difference is where the clips came from.
function ClipGallery({ animation, emptyLabel, previewsAvailable = true }) {
  const [search, setSearch] = useState('')
  const allClips = useMemo(() => animation?.clips || [], [animation?.clips])
  const checkedSet = animation?.checkedAnimations || EMPTY_SET
  const checkedCount = checkedSet.size
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allClips
    return allClips.filter(c => c.name.toLowerCase().includes(q))
  }, [allClips, search])

  if (!allClips.length) {
    return <div className="mesh-editor-layers-panel__empty">{emptyLabel}</div>
  }

  return (
    <>
      <div className="mesh-editor-layers-panel__header">
        <span className="mesh-editor-layers-panel__title">Animations</span>
        <span className="mesh-editor-panel__hint">
          {filtered.length}{search.trim() ? ` / ${allClips.length}` : ''}
        </span>
      </div>

      {allClips.length > 6 && (
        <div className="mesh-editor-anim__search">
          <span className="material-symbols-outlined">search</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search animations…"
            aria-label="Search animations by name"
          />
          {search && (
            <button
              type="button"
              className="mesh-editor-anim__search-clear"
              onClick={() => setSearch('')}
              title="Clear search"
              aria-label="Clear search"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>
      )}

      <div className="mesh-editor-anim__list">
        {filtered.length === 0 ? (
          <div className="mesh-editor-layers-panel__empty">No animations match “{search.trim()}”.</div>
        ) : filtered.map(clip => (
          <AnimationClipItem
            key={clip.name}
            name={clip.name}
            previewUrl={previewsAvailable ? animationPreviewUrl(animation.referenceId, clip.name) : null}
            selected={animation.selectedAnimation === clip.name}
            busy={animation.retargeting === clip.name}
            checked={checkedSet.has(clip.name)}
            edited={!!animation.editedClips?.has(clip.name)}
            onSelect={() => animation.onSelectAnimation(clip.name)}
            onToggleChecked={() => animation.onToggleChecked(clip.name)}
          />
        ))}
      </div>

      {/* The dock edits the clip that is PLAYING, so it needs a selection. */}
      {animation?.selectedAnimation && (
        <button
          type="button"
          className={`mesh-editor-anim__floor-btn ${animation?.editOpen ? 'mesh-editor-anim__floor-btn--on' : ''}`}
          onClick={animation?.onToggleEdit}
          aria-pressed={!!animation?.editOpen}
          title="Pause the animation and correct any bone's rotation or position, frame by frame"
        >
          <span className="material-symbols-outlined">tune</span>
          <span>{animation?.editOpen ? 'Close animation editor' : 'Edit animation'}</span>
        </button>
      )}

      <button
        type="button"
        className="mesh-editor-btn mesh-editor-btn--primary mesh-editor-anim__save"
        onClick={animation?.onSave}
        disabled={checkedCount === 0 || animation?.saving}
        title="Save the mesh with the selected animations embedded as a new version"
      >
        <span className="material-symbols-outlined">
          {animation?.saving ? 'progress_activity' : 'save'}
        </span>
        <span>
          {animation?.saving
            ? 'Saving…'
            : `Save mesh with ${checkedCount} animation${checkedCount === 1 ? '' : 's'}`}
        </span>
      </button>
      <span className="mesh-editor-panel__hint">
        Click an animation to preview it. Tick the ones to embed, then save the mesh as a new version.
      </span>
    </>
  )
}

// Hold the fingers in a chosen pose, for the tabs whose source never animates
// them. Shared by Kimodo and MoCap because the reason is the same in both and
// the controls are fiddly enough (per-hand, separate thumbs, a thumb axis that
// cannot be deduced reliably) that two copies would drift apart.
//
// This produces ONE CONSTANT POSE held for the whole clip, not animation. It is
// applied downstream by withHandPose, which only needs the HAND to be mapped —
// it walks the finger chains off the hand bone itself — so it works even when
// the finger bones are not being driven.
function HandCurlControls({ animation, hand, note }) {
  if (!animation?.hasMapping) return null
  const curl = hand?.handCurl

  return (
    <div className="mesh-editor-anim__arms">
      <div className="mesh-editor-anim__arms-head">
        <span className="mesh-editor-panel__hint">Hand curl (open → fist)</span>
        <button
          type="button"
          className="mesh-editor-anim__arms-reset"
          onClick={() => { hand?.onHandCurlReset?.(); hand?.onHandCurlCommit?.() }}
          title="Both hands back to the mesh's own pose"
        >
          <span className="material-symbols-outlined">restart_alt</span>
        </button>
      </div>
      {/* Separate per hand: a punch is a fist on one side and an open guard on
          the other, and one slider cannot express that. */}
      {[
        { side: 'left', label: 'Left' },
        { side: 'leftThumb', label: '— thumb' },
        { side: 'right', label: 'Right' },
        { side: 'rightThumb', label: '— thumb' },
      ].map(({ side, label }) => (
        <div className="mesh-editor-anim__arms-row" key={side}>
          <span className="mesh-editor-panel__hint" style={{ minWidth: '4.2em' }}>{label}</span>
          <input
            type="range" min="0" max="100" step="1"
            value={curl?.[side] ?? 0}
            onChange={e => hand?.onHandCurlChange?.(side, Number(e.target.value))}
            // Rebaking on every pixel of drag would be unusable, so the clip is
            // only rebuilt once the slider is let go.
            onPointerUp={() => hand?.onHandCurlCommit?.()}
            onKeyUp={() => hand?.onHandCurlCommit?.()}
            disabled={!!animation?.retargeting}
            aria-label={`${side.includes('Thumb') ? `${side.replace('Thumb', '')} thumb` : `${label} hand`} curl`}
          />
          <span className="mesh-editor-anim__arms-val">{curl?.[side] ?? 0}%</span>
        </div>
      ))}
      {/* Which local axis a thumb folds about is a rig convention, and deducing
          it from geometry failed on real rigs several times over. Auto still
          tries; these are here so a wrong guess costs a click rather than
          another round of heuristics. */}
      <div className="mesh-editor-anim__arms-row">
        <span className="mesh-editor-panel__hint" style={{ minWidth: '4.2em' }}>Axis</span>
        <select
          className="mesh-editor-panel__input mesh-editor-panel__select"
          value={curl?.thumbAxis || 'auto'}
          onChange={e => { hand?.onHandCurlChange?.('thumbAxis', e.target.value); hand?.onHandCurlCommit?.() }}
          disabled={!!animation?.retargeting}
          title="If the thumb folds the wrong way, try the other axes"
        >
          <option value="auto">Auto</option>
          <option value="x">Local X</option>
          <option value="y">Local Y</option>
          <option value="z">Local Z</option>
        </select>
        <button
          type="button"
          className={`mesh-editor-anim__floor-btn ${curl?.thumbFlip ? 'mesh-editor-anim__floor-btn--on' : ''}`}
          style={{ flex: '0 0 auto' }}
          onClick={() => { hand?.onHandCurlChange?.('thumbFlip', !curl?.thumbFlip); hand?.onHandCurlCommit?.() }}
          aria-pressed={!!curl?.thumbFlip}
          title="Fold the thumb the other way"
        >
          <span className="material-symbols-outlined">swap_horiz</span>
        </button>
      </div>
      <span className="mesh-editor-panel__hint">{note}</span>
    </div>
  )
}

// "Kimodo" tab: describe a motion, get an animation.
//
// The generated clip is retargeted through the same machinery as a library clip,
// which means it occupies the same single source-rig slot: mapping the Kimodo
// skeleton onto the mesh replaces whatever the Animations tab had mapped. Rather
// than hide that, the tab says so.
function KimodoTab({ animation, kimodo }) {
  const k = kimodo || {}
  const busy = !!k.running
  const segments = k.segments || 1
  const total = (Number(k.duration) || 0) * segments

  return (
    // --scroll: the form above the results is tall enough to leave the clip grid
    // no room, so this tab scrolls as a single column instead of nesting a
    // scrollable grid inside a full panel.
    <div className="mesh-editor-skeleton-panel__body mesh-editor-skeleton-panel__body--scroll">
      {k.serviceError && (
        <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
          <span className="material-symbols-outlined">error</span>
          <span>{k.serviceError}</span>
        </div>
      )}

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Describe the motion</span>

        <label className="mesh-editor-anim__field">
          <textarea
            className="mesh-editor-panel__input"
            rows={3}
            value={k.prompt || ''}
            onChange={e => k.onPromptChange?.(e.target.value)}
            disabled={busy}
            placeholder="A person walks forward and waves."
            aria-label="Motion prompt"
          />
        </label>
        {/* Kimodo's own guidance: prompts that start this way and describe one
            or two behaviours match how its training data was labelled. */}
        <span className="mesh-editor-panel__hint">
          Start with “A person…” and keep it to one or two actions. Kimodo knows locomotion,
          gestures, everyday activities, combat, dance, and styles like tired, drunk or sneaky.
        </span>

        <label className="mesh-editor-anim__field">
          <span className="mesh-editor-panel__hint">Duration per sentence (seconds)</span>
          <input
            type="number"
            className="mesh-editor-panel__input"
            min={0.5}
            max={10}
            step={0.5}
            value={k.duration ?? 5}
            onChange={e => k.onDurationChange?.(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        {/* The 10 s ceiling is the model's, not ours. Chaining sentences is the
            only way past it, so show what the prompt actually adds up to. */}
        <span className="mesh-editor-panel__hint">
          {segments > 1
            ? `${segments} sentences × ${k.duration}s = ${total.toFixed(1)}s total. Each is generated in turn and blended.`
            : 'Max 10s per sentence — add another sentence for a longer sequence.'}
        </span>

        {/* "Convert to in-place" is NOT here: it is a post-process on the clip,
            not a generation setting, so it lives with the other bake toggles down
            beside the clip gallery — where it applies to every motion, including
            the ones already generated. */}

        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={k.onGenerate}
          disabled={busy || !String(k.prompt || '').trim()}
          title="Generate an animation from this prompt"
        >
          <span className="material-symbols-outlined">{busy ? 'progress_activity' : 'auto_awesome'}</span>
          <span>{busy ? 'Generating…' : 'Generate motion'}</span>
        </button>

        {busy && <MeshToolProgress progress={k.progress} />}

        {k.error && (
          <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
            <span className="material-symbols-outlined">error</span>
            <span>{k.error}</span>
          </div>
        )}
      </div>

      {/* Same mapping step as the Animations tab, against the SOMA skeleton. It
          is offered up front (the service can hand over a rest-pose skeleton
          without loading the model), so the first generation is not followed by
          a second wait. */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Bone mapping</span>
        {k.ownsMapping && animation?.hasMapping ? (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em', color: k.autoMapped ? '#e0a030' : '#4caf50' }}>
              {k.autoMapped ? 'info' : 'check_circle'}
            </span>
            <span>
              {k.autoMapped
                ? 'Bones were mapped automatically. If the motion looks wrong, check the mapping.'
                : 'Kimodo’s skeleton is mapped to your mesh.'}
            </span>
          </div>
        ) : (
          <span className="mesh-editor-panel__hint">
            Map Kimodo&apos;s skeleton to your mesh once; every generated motion reuses it.
            {animation?.hasMapping && !k.ownsMapping
              ? ' This replaces the mapping the Animations tab is using.'
              : ''}
          </span>
        )}
        <button
          type="button"
          className="mesh-editor-btn"
          onClick={k.onOpenMapping}
          disabled={busy || k.loading}
          title="Map the Kimodo skeleton's bones to your mesh"
        >
          <span className="material-symbols-outlined">
            {k.loading ? 'progress_activity' : (k.ownsMapping && animation?.hasMapping ? 'edit' : 'link')}
          </span>
          <span>
            {k.loading ? 'Loading…' : (k.ownsMapping && animation?.hasMapping ? 'Edit mapping' : 'Map bones')}
          </span>
        </button>
      </div>

      {/* The library is a POPUP, not a list here. Inline, it grew without bound
          in a narrow column that already carries the prompt form, the mapping
          step, the hand-curl sliders and the clip gallery — at a few dozen
          motions everything below it was pushed off-screen. The popup also has
          room for the prompt text, which is what actually tells two motions
          apart once the generated names start repeating. */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Saved motions</span>
        <span className="mesh-editor-panel__hint">
          Everything you have generated, from any project. Apply one to the open mesh without
          regenerating it.
        </span>
        <button
          type="button"
          className="mesh-editor-btn"
          onClick={k.library?.onOpen}
          disabled={busy}
          title="Browse, search, apply or delete your saved motions"
        >
          <span className="material-symbols-outlined">
            {k.library?.loading ? 'progress_activity' : 'video_library'}
          </span>
          <span>
            Select saved motions
            {k.library?.items?.length ? ` (${k.library.items.length})` : ''}
          </span>
        </button>
        {k.library?.error && (
          <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
            <span className="material-symbols-outlined">error</span>
            <span>{k.library.error}</span>
          </div>
        )}
      </div>

      {/* Shown whenever clips exist, NOT only once a mapping does. Gating the
          whole gallery on hasMapping meant a successful generation could finish
          and render absolutely nothing — no tile, no error — if the user had not
          mapped bones first. A generated clip must always be visible; what a
          missing mapping removes is the ability to preview it, and that is what
          the callout below says. */}
      {k.ownsMapping && (animation?.clips?.length > 0 || animation?.hasMapping) && (
        <>
          {animation?.hasMapping ? (
            <>
              <button
                type="button"
                className={`mesh-editor-anim__floor-btn ${animation?.matchRestPose ? 'mesh-editor-anim__floor-btn--on' : ''}`}
                onClick={animation?.onToggleMatchRestPose}
                disabled={!!animation?.retargeting}
                title="Pose your mesh like the Kimodo skeleton before applying the animation. Turn off to keep your mesh's own stance."
                aria-pressed={!!animation?.matchRestPose}
              >
                <span className="material-symbols-outlined">
                  {animation?.matchRestPose ? 'check_box' : 'check_box_outline_blank'}
                </span>
                <span>Match reference rest pose</span>
              </button>

              <InPlaceToggle animation={animation} />
            </>
          ) : (
            <div className="mesh-editor-feedback mesh-editor-anim__error" style={{ color: '#e0a030' }}>
              <span className="material-symbols-outlined">warning</span>
              <span>
                These motions are generated but cannot play yet — map Kimodo&apos;s bones to your
                mesh above, then click a clip.
              </span>
            </div>
          )}

          {/* Kimodo animates no fingers at all — it solves a 30-joint skeleton and
              fills every knuckle from one fixed relaxed pose — so a punch lands
              with whatever hand the mesh was modelled with. */}
          <HandCurlControls
            animation={animation}
            hand={k}
            note={'Kimodo never moves fingers, so this is a fixed pose held for the whole clip. '
              + 'If the thumb folds the wrong way, change its axis above — which one a rig uses '
              + 'is a convention, not something that can be read off the shape.'}
          />

          {/* Kimodo generates no mp4 previews, so the tiles fall back to an icon. */}
          <ClipGallery
            animation={animation}
            previewsAvailable={false}
            emptyLabel="No motions yet — write a prompt above and generate one."
          />
        </>
      )}
    </div>
  )
}

// "Custom" tab: the animations you saved yourself.
//
// A custom animation is a clip that was corrected in the animation dock and saved
// together with the skeleton it was authored on — which is what makes it reusable:
// with its own rig travelling with it, it is an animation SOURCE, and applying it
// to a different mesh is the same mapping + retarget as a bundled reference clip.
//
// So this tab is deliberately the Animations tab with a different list at the top:
// pick an animation, map its bones once, then preview, edit and save exactly as
// everywhere else. Like Kimodo it takes the single source-rig slot, and says so.
function CustomTab({ animation, custom }) {
  const c = custom || {}
  const busy = !!c.applying

  return (
    // --scroll for the same reason as the Kimodo tab: the picker, the mapping
    // step and the clip gallery do not fit a fixed column between them.
    <div className="mesh-editor-skeleton-panel__body mesh-editor-skeleton-panel__body--scroll">
      {c.savedNotice && (
        <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '1.1em', color: '#4caf50' }}>check_circle</span>
          <span>&ldquo;{c.savedNotice}&rdquo; is in your custom animations.</span>
          <button type="button" className="mesh-editor-anim__search-clear" onClick={c.onDismissSaved}
            title="Dismiss" aria-label="Dismiss">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}

      {c.error && (
        <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
          <span className="material-symbols-outlined">error</span>
          <span>{c.error}</span>
        </div>
      )}

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Animation library</span>
        <span className="mesh-editor-panel__hint">
          Animations you saved from the editor, plus any you imported from an FBX, GLB or BVH file —
          a marketplace pack, a Mixamo download, anything with a skeleton in it. Each one carries the
          rig it was made on, so it can be retargeted onto this mesh whatever it came from.
        </span>
        <button
          type="button"
          className={`mesh-editor-btn ${c.ownsSource ? '' : 'mesh-editor-btn--primary'}`}
          onClick={c.onOpenLibrary}
          disabled={busy}
          title="Browse, search, import, apply or delete your animations"
        >
          <span className="material-symbols-outlined">
            {c.loading || busy ? 'progress_activity' : 'video_library'}
          </span>
          <span>
            {busy ? 'Applying…' : 'Select animations'}
            {c.animations?.length ? ` (${c.animations.length})` : ''}
          </span>
        </button>

        {!c.animations?.length && !c.loading && (
          <span className="mesh-editor-panel__hint">
            Nothing here yet — import a file, or edit a clip in the animation editor and use
            &ldquo;Save animation&rdquo;.
          </span>
        )}
      </div>

      {/* Same mapping step as everywhere else, against the skeleton stored with
          the animation. It is normally already done: an animation saved off a rig
          with the same bone names as this mesh maps bone-for-bone on its own. */}
      {c.ownsSource && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">Bone mapping</span>
          {animation?.hasMapping ? (
            <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
              <span className="material-symbols-outlined"
                style={{ fontSize: '1.1em', color: c.autoMapped ? '#e0a030' : '#4caf50' }}>
                {c.autoMapped ? 'info' : 'check_circle'}
              </span>
              <span>
                {c.autoMapped
                  ? 'Bones were mapped automatically. If the motion looks wrong, check the mapping.'
                  : c.mappingRestored
                    ? 'Bone mapping restored from this mesh — nothing to redo.'
                    : 'The animation’s skeleton is mapped to your mesh.'}
              </span>
            </div>
          ) : (
            <span className="mesh-editor-panel__hint">
              This animation was made on a skeleton this mesh does not share. Map its bones once —
              every animation saved off that same rig then reuses the mapping.
            </span>
          )}
          <button
            type="button"
            className={`mesh-editor-btn ${animation?.hasMapping ? '' : 'mesh-editor-btn--primary'}`}
            onClick={c.onOpenMapping}
            disabled={busy || animation?.loading}
            title="Map the saved animation's bones to your mesh"
          >
            <span className="material-symbols-outlined">
              {animation?.loading ? 'progress_activity' : (animation?.hasMapping ? 'edit' : 'link')}
            </span>
            <span>{animation?.hasMapping ? 'Edit mapping' : 'Map bones'}</span>
          </button>
          <span className="mesh-editor-panel__hint">
            The mapping is saved with the mesh, so the next time you open it these animations are
            ready to apply straight away.
          </span>
        </div>
      )}

      {c.ownsSource && animation?.hasMapping && (
        <>
          {/* A mesh whose pivot sits at its centre is drawn half-sunk at rest, so
              grounding it for playback looks like the mesh jumping upward. It is
              the preview that is right, but the choice belongs to the user. */}
          <button
            type="button"
            className={`mesh-editor-anim__floor-btn ${animation?.alignFloor ? 'mesh-editor-anim__floor-btn--on' : ''}`}
            onClick={animation?.onToggleAlignFloor}
            title="Sit the animated mesh on the floor grid. Turn it off to play the clip where the mesh sits at rest — which is what you want when the mesh's pivot is at its centre rather than on the ground."
            aria-pressed={!!animation?.alignFloor}
          >
            <span className="material-symbols-outlined">
              {animation?.alignFloor ? 'check_box' : 'check_box_outline_blank'}
            </span>
            <span>Auto-align to floor</span>
          </button>

          <button
            type="button"
            className={`mesh-editor-anim__floor-btn ${animation?.matchRestPose ? 'mesh-editor-anim__floor-btn--on' : ''}`}
            onClick={animation?.onToggleMatchRestPose}
            disabled={!!animation?.retargeting}
            title="Pose your mesh like the rig the animation was made on before applying it. Turn off to keep your mesh's own stance."
            aria-pressed={!!animation?.matchRestPose}
          >
            <span className="material-symbols-outlined">
              {animation?.matchRestPose ? 'check_box' : 'check_box_outline_blank'}
            </span>
            <span>Match reference rest pose</span>
          </button>

          <InPlaceToggle animation={animation} />

          <ClipGallery
            animation={animation}
            previewsAvailable={false}
            emptyLabel="No animation applied yet — pick one above."
          />
        </>
      )}

      {c.ownsSource && !animation?.hasMapping && (
        <div className="mesh-editor-feedback mesh-editor-anim__error" style={{ color: '#e0a030' }}>
          <span className="material-symbols-outlined">warning</span>
          <span>Map the bones above, then the animation plays on your mesh.</span>
        </div>
      )}
    </div>
  )
}

// "MoCap" tab: drive this rig with a video of something moving.
//
// Two steps, and the tab is honest that the first one exists. A video can only
// drive a rig that has been PREPARED (skeleton topology, joint-name embeddings,
// a reference pose, a rendered view) — minutes of Blender, cached per rig.
// Hiding that behind the Capture button would turn the first run into a long
// wait with no explanation.
//
// What that buys is a result needing no bone mapping at all: the service is
// conditioned on this rig, so the clip comes back on these exact bone names.
// That is why there is no "Map bones" step here and one in every other tab.
// A whole number stays whole: "10s" reads as a limit, "10.0s" reads as a
// measurement of one.
function formatSeconds(value) {
  const n = Number(value) || 0
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function formatFps(value) {
  const n = Number(value) || 0
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

function MoCapTab({ animation, mocap }) {
  const m = mocap || {}
  const cap = m.capture || {}
  const busy = !!m.running || !!m.preparing
  const ready = !!m.rigId && !!m.prepared

  return (
    <div className="mesh-editor-skeleton-panel__body mesh-editor-skeleton-panel__body--scroll">
      {m.serviceError && (
        <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
          <span className="material-symbols-outlined">error</span>
          <span>{m.serviceError}</span>
        </div>
      )}

      {/* Step 1 — the bake. Shown as done rather than hidden once it is: the
          user should be able to see this rig is ready, and redo it after
          editing the skeleton. */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">1 &middot; Prepare this rig</span>

        {ready ? (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em', color: '#4caf50' }}>check_circle</span>
            <span>Rig prepared &mdash; {m.preparedJoints} bones. Videos can drive it now.</span>
          </div>
        ) : (
          <span className="mesh-editor-panel__hint">
            The rig is analysed once so a video can be mapped onto it: its skeleton, a reference
            pose and a rendered view. Takes a few minutes and needs Blender. The result is cached,
            so you wait once per mesh, not once per video.
          </span>
        )}

        {m.staleRig && ready && (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#e0a030' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>warning</span>
            <span>
              The mesh changed since it was prepared. Prepare it again, or the capture will follow
              the old skeleton.
            </span>
          </div>
        )}

        <button
          type="button"
          className={ready ? 'mesh-editor-btn' : 'mesh-editor-btn mesh-editor-btn--primary'}
          onClick={m.onPrepare}
          disabled={busy || !m.canPrepare}
          title={ready ? 'Analyse this rig again' : 'Analyse this rig so videos can drive it'}
        >
          <span className="material-symbols-outlined">
            {m.preparing ? 'progress_activity' : (ready ? 'refresh' : 'precision_manufacturing')}
          </span>
          <span>{m.preparing ? 'Preparing…' : (ready ? 'Prepare again' : 'Prepare rig')}</span>
        </button>

        {m.preparing && <MeshToolProgress progress={m.prepareProgress} />}
      </div>

      {/* Step 2 — the clip. */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">2 &middot; Video</span>

        <label className="mesh-editor-anim__field">
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/x-msvideo,video/x-matroska"
            className="mesh-editor-panel__input"
            onChange={e => m.onVideoChange?.(e.target.files?.[0] || null)}
            disabled={busy}
            aria-label="Video file"
          />
        </label>
        {m.videoName && <span className="mesh-editor-panel__hint">{m.videoName}</span>}
        <span className="mesh-editor-panel__hint">
          One subject, whole body in frame, a single shot with a steady camera. A cut mid-clip
          reads as the body teleporting.
        </span>

        {/* Length is free-form rather than a preset list because the cost is
            continuous: one forward pass over the whole clip, so every extra
            second is more VRAM. The estimate below is the point of the field —
            it is what turns "how long?" into a question the user's card can
            answer. */}
        <label className="mesh-editor-anim__field">
          <span className="mesh-editor-panel__hint">Length to capture (seconds)</span>
          <input
            type="number"
            className="mesh-editor-panel__input"
            min={cap.minSeconds ? Math.ceil(cap.minSeconds * 2) / 2 : 1}
            max={cap.maxSeconds ? Math.floor(cap.maxSeconds * 2) / 2 : 10}
            step="0.5"
            value={cap.seconds ?? ''}
            onChange={e => m.onSecondsChange?.(e.target.value)}
            disabled={busy}
            aria-label="Length to capture in seconds"
          />
        </label>

        {cap.valid ? (
          <>
            <span
              className="mesh-editor-panel__hint"
              style={{ display: 'flex', alignItems: 'center', gap: '0.4em',
                color: cap.vram >= 10 ? '#e0a030' : '#8ff5ff' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>memory</span>
              <span>
                About {cap.vram.toFixed(1)} GB of VRAM &mdash; {cap.frames} frames
                at {formatFps(cap.fps)} fps.
              </span>
            </span>
            {/* Everything that can make the capture shorter than asked for. The
                cap is the model's and truncation upstream is silent, so it has
                to be said here or not at all. */}
            {cap.cappedSeconds != null && (
              <span className="mesh-editor-panel__hint">
                Capped at {formatSeconds(cap.cappedSeconds)}s &mdash; the model takes at most
                {' '}{cap.maxFrames} frames in one pass.
              </span>
            )}
            {cap.flooredSeconds != null && (
              <span className="mesh-editor-panel__hint">
                Raised to {formatSeconds(cap.flooredSeconds)}s &mdash; the model needs at least
                {' '}{cap.minFrames} frames.
              </span>
            )}
            {cap.videoSeconds != null && cap.videoSeconds < cap.effectiveSeconds - 0.05 && (
              <span className="mesh-editor-panel__hint">
                This video is only {formatSeconds(cap.videoSeconds)}s long, so that is all
                that will be captured.
              </span>
            )}
            {/* Seconds only become frames at the video's own rate, so which rate
                the estimate used is part of the estimate. */}
            {cap.probing ? (
              <span className="mesh-editor-panel__hint">Reading this video&apos;s frame rate…</span>
            ) : !cap.fpsKnown && (
              <span className="mesh-editor-panel__hint">
                {m.hasVideo
                  ? `This video's frame rate could not be read, so ${formatFps(cap.fps)} fps is assumed — at a different rate the capture covers a different length.`
                  : `Assuming ${formatFps(cap.fps)} fps until a video is chosen.`}
              </span>
            )}
          </>
        ) : (
          <span className="mesh-editor-panel__hint">Enter how many seconds to capture.</span>
        )}
        <span className="mesh-editor-panel__hint">
          Only the beginning of a longer video is used.
        </span>

        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={m.onGenerate}
          disabled={busy || !ready || !m.hasVideo}
          title={ready ? 'Capture the motion in this video onto your rig' : 'Prepare the rig first'}
        >
          <span className="material-symbols-outlined">{m.running ? 'progress_activity' : 'videocam'}</span>
          <span>{m.running ? 'Capturing…' : 'Capture motion'}</span>
        </button>

        {m.running && <MeshToolProgress progress={m.progress} />}

        {m.error && (
          <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
            <span className="material-symbols-outlined">error</span>
            <span>{m.error}</span>
          </div>
        )}
      </div>

      {/* Which chains the capture is allowed to drive.
          The model regresses every joint at once and was trained on animal and
          object motion, so it cannot hold a limb still on request: film only
          your arms and the legs still drift, and body orientation lands on the
          root, which swings the whole character to place a hand. Switching a
          chain off here leaves it at its rest pose. Applies to captures already
          taken — no need to shoot again. */}
      {m.canFilter && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">What the capture drives</span>
          <span className="mesh-editor-panel__hint">
            Switch off anything that should hold still. The model moves every joint it is
            allowed to, even parts that never moved on camera.
          </span>
          {(m.boneGroups || []).map(g => (
            <label key={g.id} className="mesh-editor-anim__field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5em' }}>
              <input
                type="checkbox"
                checked={!!m.drive?.has(g.id)}
                onChange={() => m.onDriveToggle?.(g.id)}
                disabled={busy}
              />
              <span>{g.label}</span>
              {g.hint && <span className="mesh-editor-panel__hint" style={{ margin: 0 }}>— {g.hint}</span>}
            </label>
          ))}
        </div>
      )}

      {/* MoCapAnything never animates fingers: which joints may move at all is
          decided when the rig is prepared, and the hands are always among the
          ones locked — the model has no view of them. Same fixed-pose control
          as the Kimodo tab, and it works here even with "Fingers" switched off
          above, because posing the fingers only needs the HAND to be driven. */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Hands</span>
        {animation?.hasMapping ? (
          <HandCurlControls
            animation={animation}
            hand={m}
            note={'Captured motion never includes fingers, so this is a fixed pose held for the '
              + 'whole clip. If the thumb folds the wrong way, change its axis above — which one '
              + 'a rig uses is a convention, not something that can be read off the shape.'}
          />
        ) : (
          <span className="mesh-editor-panel__hint">
            Capture a motion first — the finger pose is applied to the clip on your rig.
          </span>
        )}
      </div>

      {/* Stated, not discovered. The model returns joint ROTATIONS only — the
          root never translates — so a walk captured here runs on the spot. That
          is usually what a game clip wants, but finding it out after saving a
          version is not acceptable. */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">What you get</span>
        <span className="mesh-editor-panel__hint">
          Motion is captured in place: the pose is followed, but the character does not travel
          across the ground. Bones are driven directly, with no mapping step, because the capture
          is made for this skeleton.
        </span>
        {m.lastStats && (
          <div className="mesh-editor-texture-workflow-meta">
            <span><strong>Frames:</strong> {m.lastStats.frames}</span>
            <span><strong>Rate:</strong> {m.lastStats.fps} fps</span>
            <span><strong>Bones driven:</strong> {m.lastStats.joints}</span>
          </div>
        )}
        {/* The model puts the whole body orientation on the root bone and gets
            the upright part of it wrong, which used to swing the entire mesh
            around the hips. Said here so a corrected capture does not look like
            the model simply got it right. */}
        {m.lastStats?.rootTiltRemoved > 5 && (
          <span className="mesh-editor-panel__hint">
            Straightened the capture: {m.lastStats.rootTiltRemoved}° of body tilt was removed from
            the root bone. The direction it faces and all limb motion are kept.
          </span>
        )}
      </div>

      <ClipGallery animation={animation} emptyLabel="No captured motion yet." />
    </div>
  )
}

// The Auto Rig tabs. A table rather than hand-written buttons: the bar
// stays this size whether it carries four of them or six.
const RIG_TABS = [
  { id: 'skeleton', icon: 'accessibility_new', label: 'Skeleton',
    title: 'Every bone in the rig — and where an Auto Rig mistake gets fixed' },
  { id: 'animations', icon: 'animation', label: 'Animations',
    title: 'Retarget a clip from the bundled reference library' },
  { id: 'kimodo', icon: 'auto_awesome', label: 'Kimodo',
    title: 'Generate an animation from a text prompt (NVIDIA Kimodo)' },
  { id: 'mocap', icon: 'videocam', label: 'MoCap',
    title: 'Capture motion from a video and drive this rig with it (MoCapAnything)' },
  { id: 'custom', icon: 'bookmarks', label: 'Custom',
    title: 'Animations you edited and saved yourself — reusable on any rigged mesh' },
]

export default function SkeletonPanel({ skeleton, selectedBone, onSelectBone, animation, kimodo, mocap, custom, edit }) {
  const [tab, setTab] = useState('skeleton')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const rowRefs = useRef(new Map())

  const names = skeleton?.names || []
  const { children, roots } = useMemo(() => buildHierarchy(skeleton?.parents), [skeleton])

  const toggle = index => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // Ancestors of the selected bone are force-expanded during render so a bone
  // picked on the mesh is always revealed without mutating the collapse state.
  const forcedOpen = useMemo(() => {
    const open = new Set()
    if (selectedBone == null || !skeleton?.parents) return open
    let p = skeleton.parents[selectedBone]
    while (p != null && p >= 0) {
      open.add(p)
      p = skeleton.parents[p]
    }
    return open
  }, [selectedBone, skeleton])

  // Scroll the selected bone's row into view when the selection changes.
  useEffect(() => {
    if (selectedBone == null) return
    rowRefs.current.get(selectedBone)?.scrollIntoView({ block: 'nearest' })
  }, [selectedBone])

  // Ask the MoCap service whether this exact mesh is already prepared, but only
  // once the tab is actually opened: it costs a GLB export and an upload, which
  // is not worth paying on every rig change for a tab most sessions never open.
  const mocapOnOpen = mocap?.onOpen
  useEffect(() => {
    if (tab === 'mocap') mocapOnOpen?.()
  }, [tab, mocapOnOpen])

  // The custom-animation catalogue is fetched the first time the tab is opened,
  // for the same reason: rows nobody looked at cost a request each session.
  const customOnOpen = custom?.onOpen
  useEffect(() => {
    if (tab === 'custom') customOnOpen?.()
  }, [tab, customOnOpen])

  // The Animations tab owns the bundled references and nothing else. Kimodo, MoCap
  // and custom animations park their own id in the same single source slot, so an
  // id that is not in the reference list means the slot belongs to another tab —
  // and this one must show an empty dropdown rather than list somebody else's
  // clips under a blank selection.
  const libraryReferenceId = ANIMATION_REFERENCES.some(r => r.id === animation?.referenceId)
    ? animation.referenceId
    : ''


  const boneCount = skeleton?.jointCount ?? names.length

  return (
    <aside className="mesh-editor-layers-panel mesh-editor-skeleton-panel">
      {/* Five tabs no longer fit as labelled pills in this column, so they are
          icon-over-label buttons — the same shape the Tools panel uses, which
          keeps the two panels reading as one system. The labels stay (rather
          than icon-only) because "Kimodo", "MoCap" and "Custom" are not guessable
          from a glyph. */}
      <div className="mesh-editor-skeleton-panel__tabs" role="tablist">
        {RIG_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`mesh-editor-skeleton-panel__tab ${tab === t.id ? 'mesh-editor-skeleton-panel__tab--active' : ''}`}
            onClick={() => setTab(t.id)}
            title={t.title}
          >
            <span className="material-symbols-outlined">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'skeleton' ? (
        <div className="mesh-editor-skeleton-panel__body">
          <div className="mesh-editor-layers-panel__header">
            <span className="mesh-editor-layers-panel__title">Bones</span>
            <span className="mesh-editor-panel__hint">{boneCount}</span>
            {edit?.available && (
              <button
                type="button"
                className={`mesh-editor-bone-edit__toggle ${edit.active ? 'mesh-editor-bone-edit__toggle--on' : ''}`}
                onClick={edit.onToggle}
                aria-pressed={!!edit.active}
                title={edit.active
                  ? 'Leave bone editing'
                  : 'Move, rename and delete bones to fix what Auto Rig got wrong'}
              >
                <span className="material-symbols-outlined">{edit.active ? 'check' : 'edit'}</span>
                <span>{edit.active ? 'Done' : 'Edit'}</span>
              </button>
            )}
          </div>

          {edit?.active && (
            <div className="mesh-editor-bone-edit">
              <div className="mesh-editor-bone-edit__bar">
                <button
                  type="button"
                  className="mesh-editor-bone-edit__icon-btn"
                  onClick={edit.onUndo}
                  disabled={!edit.canUndo}
                  title="Undo the last bone edit"
                >
                  <span className="material-symbols-outlined">undo</span>
                </button>
                <button
                  type="button"
                  className="mesh-editor-bone-edit__icon-btn"
                  onClick={edit.onRedo}
                  disabled={!edit.canRedo}
                  title="Redo"
                >
                  <span className="material-symbols-outlined">redo</span>
                </button>
                <button
                  type="button"
                  className="mesh-editor-bone-edit__icon-btn mesh-editor-bone-edit__icon-btn--wide"
                  onClick={edit.onRevert}
                  disabled={!edit.dirty}
                  title="Put every bone back where it was when you started editing"
                >
                  <span className="material-symbols-outlined">restart_alt</span>
                  <span>Revert</span>
                </button>
                {edit.dirty && (
                  <span className="mesh-editor-bone-edit__dirty" title="The skeleton has unsaved edits">
                    edited
                  </span>
                )}
              </div>

              <button
                type="button"
                className={`mesh-editor-anim__floor-btn ${edit.moveChildren ? 'mesh-editor-anim__floor-btn--on' : ''}`}
                onClick={edit.onToggleMoveChildren}
                aria-pressed={!!edit.moveChildren}
                title="On: dragging a joint carries the bones below it. Off: only that joint moves, children stay put."
              >
                <span className="material-symbols-outlined">
                  {edit.moveChildren ? 'check_box' : 'check_box_outline_blank'}
                </span>
                <span>Move children with bone</span>
              </button>

              {edit.unusedCount > 0 && (
                <div className="mesh-editor-bone-edit__cleanup">
                  <span className="material-symbols-outlined">auto_delete</span>
                  <span>
                    {edit.unusedCount} bone{edit.unusedCount === 1 ? '' : 's'} move nothing
                  </span>
                  <button
                    type="button"
                    className="mesh-editor-bonemap__mini-btn"
                    onClick={edit.onRemoveUnused}
                    title="Delete every bone whose branch has no skin weight at all"
                  >
                    Remove
                  </button>
                </div>
              )}

              {selectedBone != null && names[selectedBone] ? (
                <BoneEditCard
                  index={selectedBone}
                  name={names[selectedBone]}
                  position={[
                    skeleton.joints[selectedBone * 3],
                    skeleton.joints[selectedBone * 3 + 1],
                    skeleton.joints[selectedBone * 3 + 2],
                  ]}
                  influence={edit.influence}
                  canTakeWeights={!!edit.influence?.hasSkin && skeleton.parents?.[selectedBone] >= 0}
                  edit={edit}
                />
              ) : (
                <span className="mesh-editor-panel__hint">
                  Select a bone — in the list or on the mesh — to move, rename or delete it.
                </span>
              )}
            </div>
          )}

          {roots.length === 0 ? (
            <div className="mesh-editor-layers-panel__empty">No bones in this skeleton.</div>
          ) : (
            <ul className="mesh-editor-bone-tree">
              {roots.map(root => (
                <BoneNode
                  key={root}
                  index={root}
                  depth={0}
                  names={names}
                  childMap={children}
                  selectedBone={selectedBone}
                  onSelectBone={onSelectBone}
                  collapsed={collapsed}
                  forcedOpen={forcedOpen}
                  onToggle={toggle}
                  rowRefs={rowRefs}
                  edit={edit}
                />
              ))}
            </ul>
          )}
          <span className="mesh-editor-panel__hint">
            {edit?.active
              ? 'Drag the gizmo to move the selected joint — the mesh stays put, only the pivot it bends around changes.'
              : 'Click a bone to highlight it on the mesh. Click a bone on the mesh to select it here.'}
          </span>
        </div>
      ) : tab === 'animations' ? (
        <div className="mesh-editor-skeleton-panel__body">
          {animation?.mappingRestored && (
            <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '1.1em', color: '#4caf50' }}>link</span>
              <span>
                Bone mapping restored from this mesh — the clips below are ready to play.
              </span>
            </div>
          )}
          {animation?.ownedByCustom && (
            <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>info</span>
              <span>
                Your mesh is currently mapped to a saved custom animation — it is on the Custom tab.
                Picking a reference below replaces that mapping.
              </span>
            </div>
          )}
          {animation?.ownedByKimodo && (
            <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>info</span>
              <span>
                Your mesh is currently mapped to Kimodo&apos;s skeleton — its motions are on the
                Kimodo tab. Picking a reference below replaces that mapping.
              </span>
            </div>
          )}
          <div className="mesh-editor-anim__controls">
            <label className="mesh-editor-anim__field">
              <span className="mesh-editor-panel__hint">Reference mesh</span>
              <select
                className="mesh-editor-panel__input mesh-editor-panel__select"
                value={libraryReferenceId}
                onChange={e => animation?.onSelectReference(e.target.value)}
                disabled={animation?.loading}
              >
                <option value="" disabled>Select a reference…</option>
                {ANIMATION_REFERENCES.map(ref => (
                  <option key={ref.id} value={ref.id}>{ref.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--primary"
              onClick={animation?.onOpenMapping}
              disabled={!libraryReferenceId || animation?.loading}
              title="Map the reference skeleton's bones to your mesh"
            >
              <span className="material-symbols-outlined">
                {animation?.loading ? 'progress_activity' : (animation?.hasMapping ? 'edit' : 'link')}
              </span>
              <span>{animation?.loading ? 'Loading…' : (animation?.hasMapping ? 'Edit mapping' : 'Map bones')}</span>
            </button>
          </div>

          {animation?.error && (
            <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
              <span className="material-symbols-outlined">error</span>
              <span>{animation.error}</span>
            </div>
          )}

          {!libraryReferenceId ? (
            <div className="mesh-editor-layers-panel__empty">
              Select a reference mesh, then map its bones to animate your mesh.
            </div>
          ) : !animation?.hasMapping ? (
            <div className="mesh-editor-layers-panel__empty">
              Map the reference bones to your mesh to load its animations.
            </div>
          ) : (
            <>
              <button
                type="button"
                className={`mesh-editor-anim__floor-btn ${animation?.alignFloor ? 'mesh-editor-anim__floor-btn--on' : ''}`}
                onClick={animation?.onToggleAlignFloor}
                title="Sit the animated mesh on the floor grid"
                aria-pressed={!!animation?.alignFloor}
              >
                <span className="material-symbols-outlined">
                  {animation?.alignFloor ? 'check_box' : 'check_box_outline_blank'}
                </span>
                <span>Auto-align to floor</span>
              </button>

              {/* Without this the clip is measured against your mesh's own rest
                  pose, so a character modelled with its legs apart walks with its
                  legs apart. Rebakes the clip, hence disabled mid-retarget. */}
              <button
                type="button"
                className={`mesh-editor-anim__floor-btn ${animation?.matchRestPose ? 'mesh-editor-anim__floor-btn--on' : ''}`}
                onClick={animation?.onToggleMatchRestPose}
                disabled={!!animation?.retargeting}
                title="Pose your mesh like the reference rig before applying the animation. Turn off to keep your mesh's own stance — a character whose rest pose has the legs or arms apart will then keep them apart while it moves."
                aria-pressed={!!animation?.matchRestPose}
              >
                <span className="material-symbols-outlined">
                  {animation?.matchRestPose ? 'check_box' : 'check_box_outline_blank'}
                </span>
                <span>Match reference rest pose</span>
              </button>

              <InPlaceToggle animation={animation} />

              {animation?.canAdjustArms && (
                <div className="mesh-editor-anim__arms">
                  <div className="mesh-editor-anim__arms-head">
                    <span className="mesh-editor-panel__hint">Expand / Contract arms</span>
                    <button
                      type="button"
                      className="mesh-editor-anim__arms-reset"
                      onClick={() => animation.onArmExtensionChange(0)}
                      title="Reset arm spread"
                    >
                      <span className="material-symbols-outlined">restart_alt</span>
                    </button>
                  </div>
                  <div className="mesh-editor-anim__arms-row">
                    <input
                      type="range" min="-100" max="100" step="1"
                      value={animation.armExtension}
                      onChange={e => animation.onArmExtensionChange(Number(e.target.value))}
                    />
                    <span className="mesh-editor-anim__arms-val">{animation.armExtension}%</span>
                  </div>
                </div>
              )}

              <ClipGallery animation={animation} emptyLabel="This reference has no animations." />
            </>
          )}
        </div>
      ) : tab === 'kimodo' ? (
        <KimodoTab animation={animation} kimodo={kimodo} />
      ) : tab === 'custom' ? (
        <CustomTab animation={animation} custom={custom} />
      ) : (
        <MoCapTab animation={animation} mocap={mocap} />
      )}
    </aside>
  )
}
