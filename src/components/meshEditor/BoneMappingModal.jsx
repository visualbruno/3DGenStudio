// Bone-mapping popup for the Auto Rig → Animations flow. Maps the reference
// animation skeleton's bones (source, left column) onto the user's rigged mesh
// bones (target, right column) so clips can be retargeted. Mirrors the
// mesh2motion mapping UI: drag a source bone onto a target row, or click a
// source then a target. Auto-Map fills the mapping heuristically.
//
// To make it obvious *where* each bone lives (names alone rarely tell you), the
// far-left column shows two live 3D skeletons — the reference (source) on top
// and the user's mesh (target) below. Click a bone in a view to select it (same
// as clicking its row), and hovering a list row flashes that bone in 3D.
import { useEffect, useMemo, useState } from 'react'
import BoneSkeletonView from './BoneSkeletonView'

export default function BoneMappingModal({
  referenceLabel,
  sourceBones,
  targetBones,
  sourceSkeleton,
  targetSkeleton,
  initialMapping,
  onAutoMap,
  onSave,
  onClose,
}) {
  const [mapping, setMapping] = useState(() => ({ ...(initialMapping || {}) }))
  const [sourceFilter, setSourceFilter] = useState('')
  const [targetFilter, setTargetFilter] = useState('')
  const [pickedSource, setPickedSource] = useState(null)
  const [pickedTarget, setPickedTarget] = useState(null)
  const [hoverSource, setHoverSource] = useState(null)
  const [hoverTarget, setHoverTarget] = useState(null)
  const [dragSource, setDragSource] = useState(null)

  // Close on Escape.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const mappedSources = useMemo(() => new Set(Object.values(mapping)), [mapping])
  const mappedTargets = useMemo(() => new Set(Object.keys(mapping)), [mapping])
  const mappedCount = Object.keys(mapping).length

  const filteredSources = useMemo(
    () => sourceBones.filter(n => n.toLowerCase().includes(sourceFilter.trim().toLowerCase())),
    [sourceBones, sourceFilter],
  )
  const filteredTargets = useMemo(
    () => targetBones.filter(n => n.toLowerCase().includes(targetFilter.trim().toLowerCase())),
    [targetBones, targetFilter],
  )

  const assign = (targetName, sourceName) => {
    setMapping(prev => {
      const next = { ...prev }
      // A source bone maps to at most one target — remove any prior use.
      for (const t of Object.keys(next)) if (next[t] === sourceName) delete next[t]
      next[targetName] = sourceName
      return next
    })
    setPickedSource(null)
  }

  const clearTarget = targetName => {
    setMapping(prev => {
      const next = { ...prev }
      delete next[targetName]
      return next
    })
  }

  const handleTargetClick = targetName => {
    setPickedTarget(targetName)
    if (pickedSource) assign(targetName, pickedSource)
  }

  // Clicking a target bone in the 3D view: assign the picked source if one is
  // held, otherwise toggle the label (click the selected bone again to hide it).
  const handleTargetViewClick = targetName => {
    if (pickedSource) { assign(targetName, pickedSource); setPickedTarget(targetName); return }
    setPickedTarget(prev => (prev === targetName ? null : targetName))
  }

  // Fill only the currently-unmapped target bones from the heuristic, leaving
  // existing mappings untouched and never reusing a source already in use.
  const finishMapping = () => {
    const auto = onAutoMap() || {}
    setMapping(prev => {
      const next = { ...prev }
      const usedSources = new Set(Object.values(next))
      for (const [target, source] of Object.entries(auto)) {
        if (next[target] || usedSources.has(source)) continue
        next[target] = source
        usedSources.add(source)
      }
      return next
    })
  }

  const handleDrop = targetName => {
    if (dragSource) assign(targetName, dragSource)
    setDragSource(null)
  }

  const toggleSource = name => setPickedSource(prev => (prev === name ? null : name))

  // Bones to highlight in each 3D view: what the user is hovering in the list
  // takes priority (so a hover flashes its location), else the current pick.
  const sourceHighlight = hoverSource || pickedSource
  const targetHighlight = hoverTarget || pickedTarget

  return (
    <div className="mesh-editor-bonemap__overlay" onClick={onClose}>
      <div className="mesh-editor-bonemap" onClick={e => e.stopPropagation()}>
        <div className="mesh-editor-bonemap__header">
          <div>
            <h2 className="mesh-editor-bonemap__title">Map bones — {referenceLabel}</h2>
            <p className="mesh-editor-bonemap__subtitle">
              Assign each animation (source) bone to a bone on your mesh (target). Rotate the 3D
              views and click a bone to select it, drag a source bone onto a target, or click a
              source then a target. {mappedCount} mapped.
            </p>
          </div>
          <button type="button" className="mesh-editor-bonemap__close" onClick={onClose} title="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="mesh-editor-bonemap__body">
          {/* 3D SKELETON VIEWS */}
          <div className="mesh-editor-bonemap__views">
            <BoneSkeletonView
              title={`Source · ${referenceLabel}`}
              skeleton={sourceSkeleton}
              selectedBone={sourceHighlight}
              mappedBones={mappedSources}
              onSelectBone={toggleSource}
              onBackgroundClick={() => setPickedSource(null)}
            />
            <BoneSkeletonView
              title="Target · your mesh"
              skeleton={targetSkeleton}
              selectedBone={targetHighlight}
              mappedBones={mappedTargets}
              onSelectBone={handleTargetViewClick}
              onBackgroundClick={() => setPickedTarget(null)}
            />
          </div>

          {/* SOURCE column */}
          <div className="mesh-editor-bonemap__col">
            <div className="mesh-editor-bonemap__col-head">
              <span className="mesh-editor-bonemap__col-title">Source · {referenceLabel}</span>
              <span className="mesh-editor-panel__hint">{sourceBones.length} bones</span>
            </div>
            <input
              className="mesh-editor-bonemap__filter"
              placeholder="Source bones filter"
              value={sourceFilter}
              onChange={e => setSourceFilter(e.target.value)}
            />
            <div className="mesh-editor-bonemap__list">
              {filteredSources.map(name => {
                const used = mappedSources.has(name)
                return (
                  <div
                    key={name}
                    className={`mesh-editor-bonemap__source ${pickedSource === name ? 'mesh-editor-bonemap__source--picked' : ''} ${used ? 'mesh-editor-bonemap__source--used' : ''}`}
                    draggable
                    onDragStart={() => setDragSource(name)}
                    onDragEnd={() => setDragSource(null)}
                    onClick={() => toggleSource(name)}
                    onMouseEnter={() => setHoverSource(name)}
                    onMouseLeave={() => setHoverSource(null)}
                    title={used ? `${name} (mapped)` : name}
                  >
                    <span className="material-symbols-outlined mesh-editor-bonemap__grip">drag_indicator</span>
                    <span className="mesh-editor-bonemap__source-name">{name}</span>
                    {used && <span className="material-symbols-outlined mesh-editor-bonemap__used-check">check</span>}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mesh-editor-bonemap__arrow">
            <span className="material-symbols-outlined">arrow_forward</span>
          </div>

          {/* TARGET column */}
          <div className="mesh-editor-bonemap__col">
            <div className="mesh-editor-bonemap__col-head">
              <span className="mesh-editor-bonemap__col-title">Target · your mesh</span>
              <div className="mesh-editor-bonemap__col-actions">
                <button type="button" className="mesh-editor-bonemap__mini-btn" onClick={() => setMapping(onAutoMap() || {})}>
                  Auto-Map
                </button>
                <button
                  type="button"
                  className="mesh-editor-bonemap__mini-btn"
                  onClick={finishMapping}
                  disabled={mappedCount >= targetBones.length}
                  title="Fill the remaining unmapped bones, keeping the ones you've already set"
                >
                  Finish Mapping
                </button>
                <button type="button" className="mesh-editor-bonemap__mini-btn" onClick={() => setMapping({})} disabled={!mappedCount}>
                  Clear
                </button>
              </div>
            </div>
            <input
              className="mesh-editor-bonemap__filter"
              placeholder="Target bones filter"
              value={targetFilter}
              onChange={e => setTargetFilter(e.target.value)}
            />
            <div className="mesh-editor-bonemap__list">
              {filteredTargets.map(name => {
                const src = mapping[name]
                return (
                  <div
                    key={name}
                    className={`mesh-editor-bonemap__target ${src ? 'mesh-editor-bonemap__target--mapped' : ''} ${pickedSource ? 'mesh-editor-bonemap__target--droppable' : ''}`}
                    onClick={() => handleTargetClick(name)}
                    onMouseEnter={() => setHoverTarget(name)}
                    onMouseLeave={() => setHoverTarget(null)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleDrop(name)}
                  >
                    {src ? (
                      <span className="mesh-editor-bonemap__chip" title={src}>{src}</span>
                    ) : (
                      <span className="mesh-editor-bonemap__chip mesh-editor-bonemap__chip--empty">unmapped</span>
                    )}
                    <span className="mesh-editor-bonemap__target-name">{name}</span>
                    {src && (
                      <button
                        type="button"
                        className="mesh-editor-bonemap__clear-btn"
                        onClick={e => { e.stopPropagation(); clearTarget(name) }}
                        title="Clear mapping"
                      >
                        <span className="material-symbols-outlined">close</span>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="mesh-editor-bonemap__footer">
          <span className="mesh-editor-panel__hint">{mappedCount} of {targetBones.length} target bones mapped</span>
          <div className="mesh-editor-bonemap__footer-actions">
            <button type="button" className="mesh-editor-btn mesh-editor-btn--ghost" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--primary"
              onClick={() => onSave(mapping)}
              disabled={!mappedCount}
            >
              <span className="material-symbols-outlined">check</span>
              <span>Save mapping</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
