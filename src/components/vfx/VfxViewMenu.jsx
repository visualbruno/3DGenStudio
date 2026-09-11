// The viewport toggles, behind one button.
//
// THEY WERE SIX CHECKBOXES IN THE TOOLBAR, and the toolbar is a single wrapping
// row shared with the effect name, the save buttons, Export, Presets, Sprite and
// three icon buttons. Six labelled checkboxes are wide enough that on an
// existing effect - which has two more buttons than a new one - Export wrapped
// off the visible row entirely. A button the author cannot find is a feature
// they do not have.
//
// A POPOVER RATHER THAN A <select>. These are six independent booleans, and a
// native select is single-choice; a multiple select is a scrolling list box
// nobody can drive. The trigger states how many are on, so the collapsed form
// still says something true about the viewport.
import { useEffect, useRef } from 'react'
import './VfxViewMenu.css'

/**
 * @param {Object} props
 * @param {{key: string, label: string, value: boolean, onChange: Function, hint?: string}[]} props.items
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onOpenChange
 */
export default function VfxViewMenu({ items, open, onOpenChange }) {
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) onOpenChange(false)
    }
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        onOpenChange(false)
        // Focus goes back to the trigger, or Escape strands a keyboard user at
        // the top of the document.
        rootRef.current?.querySelector('button')?.focus()
      }
    }
    // Pointerdown rather than click: a click listener fires after the button
    // that opened the menu has already toggled it, which reopens it forever.
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  const on = items.filter(item => item.value).length

  return (
    <div className="vfx-viewmenu" ref={rootRef}>
      <button
        type="button"
        className={`vfx-viewmenu__trigger${open ? ' is-open' : ''}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Grid, scale references, emitter gizmos, the stats panel, the camera and the profiler"
      >
        <span className="material-symbols-outlined">visibility</span>
        View
        {/* The count is what keeps the collapsed form honest: an author who
            turned the grid off can see that something is off without opening
            it. */}
        <span className="vfx-viewmenu__count">{on}</span>
        <span className="material-symbols-outlined vfx-viewmenu__chevron">
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && (
        <div className="vfx-viewmenu__panel" role="group" aria-label="Viewport options">
          {items.map(item => (
            <label key={item.key} title={item.hint}>
              <input
                type="checkbox"
                checked={item.value}
                onChange={event => item.onChange(event.target.checked)}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
