// A hover card explaining a block, portalled to <body>.
//
// PORTALLED, and that is the whole reason this exists rather than a `title`
// attribute or an absolutely-positioned div inside the node. A card rendered
// inside a React Flow node is inside `transform: scale(z)`: at 0.4 zoom the
// explanation is unreadable, at 1.75 it covers the board, and either way it is
// clipped by the node's own `overflow: hidden`. Portalling to the body and
// positioning in SCREEN coordinates makes it the same size wherever the author
// has the board.
//
// IT SAYS WHAT THE BLOCK IS FOR AND WHAT PEOPLE GET WRONG. The catalog's
// `blurb` is the one-liner already visible in the palette; `teach` is the
// sentence that prevents this block's classic mistake, and it is the reason
// hover cards are worth building at all for an audience that has never authored
// an effect. A tooltip that repeats the label teaches nothing.
//
// IT NEVER TAKES THE POINTER. `pointer-events: none` throughout, so it cannot
// swallow a click meant for the row underneath it and cannot interpose itself
// between the pointer and a drag in progress. A card the author has to dodge is
// worse than no card.
//
// IT FLIPS RATHER THAN OVERFLOWING. Positioned to the right of its anchor
// unless that would leave the viewport, in which case it goes left; same
// vertically. Measured after mount, because the height depends on how long the
// `teach` sentence is.

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ENGINE_SUPPORT } from '../../../vfx/catalog.js'
import './VfxHoverCard.css'

const GAP = 10
const MARGIN = 8

const SUPPORT_TEXT = {
  [ENGINE_SUPPORT.NATIVE]: 'imports natively',
  [ENGINE_SUPPORT.APPROX]: 'imports as an approximation',
  [ENGINE_SUPPORT.NONE]: 'has no equivalent and will be dropped',
}

/**
 * @param {Object} props
 * @param {{x: number, y: number, width: number, height: number}} props.anchor
 *   the anchor's rect in SCREEN coordinates
 * @param {Object} props.def a catalog block or operator definition
 */
export default function VfxHoverCard({ anchor, def }) {
  const cardRef = useRef(null)
  const [placement, setPlacement] = useState({ left: -9999, top: -9999 })

  // Measured after mount rather than estimated: the card's height depends on
  // the length of the teach sentence, and guessing it is what makes a flip
  // decision wrong for exactly the longest, most useful cards.
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !anchor) return
    const rect = card.getBoundingClientRect()
    const viewport = { width: window.innerWidth, height: window.innerHeight }

    let left = anchor.x + anchor.width + GAP
    if (left + rect.width > viewport.width - MARGIN) {
      left = anchor.x - rect.width - GAP
    }
    // Both sides failed - a narrow window - so clamp rather than leaving it
    // half off screen.
    if (left < MARGIN) left = MARGIN

    let top = anchor.y
    if (top + rect.height > viewport.height - MARGIN) {
      top = viewport.height - rect.height - MARGIN
    }
    if (top < MARGIN) top = MARGIN

    setPlacement({ left, top })
  }, [anchor, def])

  if (!def || !anchor) return null

  const engines = [['unity', 'Unity'], ['unreal', 'Unreal']]
    .map(([key, name]) => ({ key, name, support: def.engines?.[key] }))
    .filter(row => row.support && row.support !== ENGINE_SUPPORT.NATIVE)

  return createPortal(
    <div ref={cardRef} className="vfx-hovercard" style={placement} role="tooltip">
      <div className="vfx-hovercard__head">
        <span className="vfx-hovercard__label">{def.label}</span>
        {def.category && <span className="vfx-hovercard__category">{def.category}</span>}
      </div>
      <p className="vfx-hovercard__blurb">{def.blurb}</p>
      {def.teach && (
        <p className="vfx-hovercard__teach">
          <span className="material-symbols-outlined">lightbulb</span>
          {def.teach}
        </p>
      )}
      {engines.length > 0 && (
        <ul className="vfx-hovercard__engines">
          {engines.map(row => (
            <li key={row.key} className={`is-${row.support}`}>
              <strong>{row.name}</strong> {SUPPORT_TEXT[row.support]}
            </li>
          ))}
        </ul>
      )}
      {def.engines?.note && <p className="vfx-hovercard__note">{def.engines.note}</p>}
    </div>,
    document.body,
  )
}
