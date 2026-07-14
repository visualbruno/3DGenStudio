// Right-hand panel shown in Auto Rig mode when the current mesh is rigged.
// Two tabs: "Skeleton" (a collapsible hierarchy tree of every bone) and
// "Animations" (placeholder — wired up later).
//
// Bone selection is two-way with the viewport: clicking a bone row selects it
// (which highlights it on the mesh via SkeletonOverlay), and clicking a bone on
// the mesh selects the matching row here and scrolls it into view.
import { useEffect, useMemo, useRef, useState } from 'react'

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

function BoneNode({ index, depth, names, childMap, selectedBone, onSelectBone, collapsed, forcedOpen, onToggle, rowRefs }) {
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
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function SkeletonPanel({ skeleton, selectedBone, onSelectBone }) {
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

  const boneCount = skeleton?.jointCount ?? names.length

  return (
    <aside className="mesh-editor-layers-panel mesh-editor-skeleton-panel">
      <div className="mesh-editor-skeleton-panel__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'skeleton'}
          className={`mesh-editor-skeleton-panel__tab ${tab === 'skeleton' ? 'mesh-editor-skeleton-panel__tab--active' : ''}`}
          onClick={() => setTab('skeleton')}
        >
          <span className="material-symbols-outlined">accessibility_new</span>
          <span>Skeleton</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'animations'}
          className={`mesh-editor-skeleton-panel__tab ${tab === 'animations' ? 'mesh-editor-skeleton-panel__tab--active' : ''}`}
          onClick={() => setTab('animations')}
        >
          <span className="material-symbols-outlined">animation</span>
          <span>Animations</span>
        </button>
      </div>

      {tab === 'skeleton' ? (
        <div className="mesh-editor-skeleton-panel__body">
          <div className="mesh-editor-layers-panel__header">
            <span className="mesh-editor-layers-panel__title">Bones</span>
            <span className="mesh-editor-panel__hint">{boneCount}</span>
          </div>
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
                />
              ))}
            </ul>
          )}
          <span className="mesh-editor-panel__hint">
            Click a bone to highlight it on the mesh. Click a bone on the mesh to select it here.
          </span>
        </div>
      ) : (
        <div className="mesh-editor-skeleton-panel__body">
          <div className="mesh-editor-layers-panel__empty">
            Animations coming soon.
          </div>
        </div>
      )}
    </aside>
  )
}
