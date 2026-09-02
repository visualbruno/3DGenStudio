// Tools-panel mode picker. The 13 modes used to sit in the sidebar as a plain
// 2-column grid — 7 rows, ~400px of a 300px-wide column — which pushed the
// selected mode's own options below the fold on a 1080p screen. Collapsed here
// into a trigger + grouped popover so tool options start at the top of the panel.
// Presentational: `activeMenu` and the texture-support gate come from MeshEditorPage.
import { useEffect, useRef, useState } from 'react'

// `texture: true` marks the modes gated behind textureModesSupported (they need
// UVs and a texture), so the disabled state and its reason live in one place.
const TOOL_MODE_GROUPS = [
  {
    label: 'Model',
    modes: [
      { id: 'modeling', icon: 'deployed_code', label: 'Modeling' },
      { id: 'sculpting', icon: 'back_hand', label: 'Sculpting', title: 'Sculpt the mesh with brushes' },
      { id: 'boolean', icon: 'difference', label: 'Displace', title: 'Apply brush-based displacement operations' },
    ],
  },
  {
    label: 'Texture',
    modes: [
      { id: 'texturing', icon: 'texture', label: 'Texturing', texture: true },
      { id: 'painting', icon: 'brush', label: 'Painting', texture: true },
      { id: 'projection', icon: 'filter_center_focus', label: 'Projection', texture: true },
    ],
  },
  {
    label: 'Automate',
    modes: [
      { id: 'autouv', icon: 'dashboard_customize', label: 'Auto UV', title: 'Automatic UV unwrapping (Python service)' },
      { id: 'autoretopo', icon: 'grid_4x4', label: 'Auto Retopo', title: 'Automatic retopology (Python service)' },
      { id: 'autorig', icon: 'accessibility_new', label: 'Auto Rig', title: 'Automatically generate a skeleton and skin weights (SkinTokens rigging service)' },
      { id: 'segmentation', icon: 'shape_line', label: 'Segmentation', title: 'Split the mesh into parts by thickness and creases (Python service)' },
    ],
  },
  {
    label: 'Finish',
    modes: [
      { id: 'optimize', icon: 'compress', label: 'Optimize / LOD', title: 'Simplify the mesh or build an LOD chain with gltfpack (meshoptimizer)' },
      { id: 'bake', icon: 'flare', label: 'Bake', title: "Bake a high-poly source's detail onto this mesh (normal, AO, base colour)" },
      { id: 'gameready', icon: 'fact_check', label: 'Game-Ready', title: 'Check the mesh against engine-readiness budgets (read-only)' },
    ],
  },
]

const ALL_MODES = TOOL_MODE_GROUPS.flatMap(group => group.modes)

// Gap between the trigger and the popover, and the margin we keep off the
// viewport edge when deciding which way to open.
const POPOVER_GAP = 6
const VIEWPORT_MARGIN = 8
// Below this much free space the popover would be mostly scrollbar, so prefer
// whichever side has more room.
const MIN_COMFORTABLE = 260

export default function ToolModeMenu({
  activeMenu,
  onSelect,
  textureModesSupported = true,
  textureModesDisabledReason = '',
}) {
  const [open, setOpen] = useState(false)
  // Trigger geometry, re-measured while open. The popover is `position: fixed`
  // because the Tools panel and the sidebar are both `overflow-y: auto` — an
  // absolutely-positioned one gets clipped by them. Nothing in the page's
  // ancestor chain sets transform/filter/backdrop-filter, so fixed really does
  // resolve against the viewport here.
  const [anchor, setAnchor] = useState(null)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Measured when the menu opens rather than from an effect, so the popover's
  // very first render already has its placement — no frame at a stale position.
  const measure = () => {
    const el = triggerRef.current
    if (!el) return null
    const box = el.getBoundingClientRect()
    // A fresh object every time, so a resize that leaves the rect unchanged
    // still re-renders the popover against the new viewport height.
    return { left: box.left, top: box.top, bottom: box.bottom, width: box.width }
  }

  useEffect(() => {
    if (!open) return undefined
    const place = () => setAnchor(measure())
    window.addEventListener('resize', place)
    // Capture phase, so the sidebar's own scrolling counts and not just the window's.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const active = ALL_MODES.find(mode => mode.id === activeMenu)

  const isDisabled = mode => !!mode.texture && !textureModesSupported
  const titleFor = mode => (isDisabled(mode) ? textureModesDisabledReason || undefined : mode.title || undefined)

  const handleSelect = (mode) => {
    if (isDisabled(mode)) return
    onSelect(mode.id)
    setOpen(false)
  }

  // Hidden until measured, so the popover never paints one frame at 0,0.
  let popoverStyle = { visibility: 'hidden' }
  if (anchor) {
    const spaceBelow = window.innerHeight - anchor.bottom - POPOVER_GAP - VIEWPORT_MARGIN
    const spaceAbove = anchor.top - POPOVER_GAP - VIEWPORT_MARGIN
    const dropUp = spaceBelow < MIN_COMFORTABLE && spaceAbove > spaceBelow
    popoverStyle = {
      left: `${anchor.left}px`,
      minWidth: `${anchor.width}px`,
      maxHeight: `${Math.max(MIN_COMFORTABLE, dropUp ? spaceAbove : spaceBelow)}px`,
      ...(dropUp
        ? { bottom: `${window.innerHeight - anchor.top + POPOVER_GAP}px` }
        : { top: `${anchor.bottom + POPOVER_GAP}px` }),
    }
  }

  return (
    <div className="mesh-editor-mode-select" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`mesh-editor-mode-trigger ${open ? 'mesh-editor-mode-trigger--open' : ''}`}
        onClick={() => {
          if (open) { setOpen(false); return }
          setAnchor(measure())
          setOpen(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active ? titleFor(active) : undefined}
      >
        <span className="material-symbols-outlined">{active?.icon || 'handyman'}</span>
        <span className="mesh-editor-mode-trigger__label">{active?.label || 'Select a tool'}</span>
        <span className="material-symbols-outlined mesh-editor-mode-trigger__chevron">
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && (
        <div className="mesh-editor-mode-popover" style={popoverStyle} role="menu">
          {TOOL_MODE_GROUPS.map(group => (
            <div className="mesh-editor-mode-popover__group" key={group.label}>
              <span className="mesh-editor-panel__section-title">{group.label}</span>
              <div className="mesh-editor-mode-menu">
                {group.modes.map(mode => (
                  <button
                    key={mode.id}
                    type="button"
                    role="menuitem"
                    className={`mesh-editor-mode-btn ${activeMenu === mode.id ? 'mesh-editor-mode-btn--active' : ''}`}
                    onClick={() => handleSelect(mode)}
                    disabled={isDisabled(mode)}
                    title={titleFor(mode)}
                  >
                    <span className="material-symbols-outlined">{mode.icon}</span>
                    <span>{mode.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
