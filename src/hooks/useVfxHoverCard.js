// Hover state for a portalled explanation card.
//
// The card itself is VfxHoverCard, which renders into <body> and positions in
// screen coordinates. What this hook owns is the two things that go wrong with
// hover cards:
//
// A DELAY BEFORE OPENING. Without one, running the pointer down a twenty-item
// palette flashes twenty cards. 350 ms is long enough that passing over an item
// costs nothing and short enough that a deliberate hover feels immediate.
//
// THE ANCHOR RECT IS CAPTURED AT OPEN TIME, in screen coordinates, from the
// element the pointer entered. That is what makes the card work inside React
// Flow's transformed viewport: `getBoundingClientRect` already reports the
// post-transform screen box, so the card lands beside the item at whatever zoom
// the board is at, while itself staying unscaled.
//
// It closes on pointerleave, on scroll and on wheel, because the anchor rect
// goes stale the moment anything moves and a card floating next to nothing is
// worse than no card.

import { useCallback, useEffect, useRef, useState } from 'react'

const OPEN_DELAY_MS = 350

/**
 * @returns {{
 *   card: {def: Object, anchor: DOMRect}|null,
 *   bind: (def: Object) => Object,
 *   close: () => void,
 * }}
 */
export default function useVfxHoverCard() {
  const timer = useRef(0)
  const [card, setCard] = useState(null)

  const close = useCallback(() => {
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = 0
    }
    setCard(current => (current ? null : current))
  }, [])

  /**
   * Spread onto the element that should show a card for `def`.
   *
   * Not memoised per def, because it returns a fresh object anyway and the
   * elements it lands on are palette rows and block titles - never a memo
   * boundary that this would defeat.
   */
  const bind = useCallback(def => ({
    onPointerEnter: event => {
      if (!def) return
      const element = event.currentTarget
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = 0
        // Read at OPEN time rather than at enter time: a list that scrolled
        // during the delay would otherwise anchor the card where the row used
        // to be.
        const rect = element.getBoundingClientRect()
        setCard({
          def,
          anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        })
      }, OPEN_DELAY_MS)
    },
    onPointerLeave: close,
    // A pointerdown means the author has decided; the card has served its
    // purpose and would otherwise hang over whatever they just opened.
    onPointerDown: close,
  }), [close])

  useEffect(() => {
    if (!card) return undefined
    // Capture-phase, so a scroll inside the palette closes it too rather than
    // only a scroll of the page.
    window.addEventListener('scroll', close, true)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('wheel', close)
    }
  }, [card, close])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  return { card, bind, close }
}
