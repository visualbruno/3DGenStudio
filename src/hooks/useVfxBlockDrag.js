// Dragging a block row to reorder it inside a context node.
//
// Hand-rolled because there is no drag-and-drop library in this repo and one
// list is not worth adding one. It is ~150 lines, and all of the difficulty is
// in a single fact:
//
//   THE NODE LIVES INSIDE REACT FLOW'S `transform: scale(z)`, SO POINTER
//   DELTAS ARE SCREEN PIXELS WHILE offsetTop IS LAYOUT PIXELS.
//
// At zoom 0.5 a row 40 layout-pixels tall is 20 screen pixels on the glass, so
// a raw `clientY` delta compared against `offsetTop` makes the drag run at
// double speed and the row jumps two positions for every one the pointer
// crosses. At zoom 2 it runs at half speed and feels stuck. The fix is one
// division by `getZoom()`, read ONCE at drag start - re-reading it per frame
// would let a trackpad pinch mid-drag move the origin under the pointer.
//
// TWO KINDS OF MOTION, TWO MECHANISMS. The dragged row follows the pointer
// every frame, so its transform is written straight to the DOM - sixty React
// renders a second to move one row would also re-render every other row, every
// property field in them, and React Flow's edge paths. The OTHER rows only
// move when the insertion point changes, which is a handful of times per drag,
// so that lives in state as an integer and CSS does the shifting. Only that
// integer, and the final commit, ever reach React.
//
// CROSS-CONTEXT MOVES ARE NOT A DRAG. Dropping a Gravity block into an
// Initialize context is illegal (the catalog says which contexts accept it),
// and a drag that can fail on release is a drag that teaches nothing. Moving a
// block to another context is a menu item, which can show only the legal
// destinations. Reordering within a stack cannot fail, so it is a drag.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'

const DRAG_SLOP_PX = 4

/**
 * @param {Object} options
 * @param {{current: HTMLElement|null}} options.listRef the <ul> holding the rows
 * @param {Array<{id: string}>} options.blocks in document order
 * @param {(blockId: string, toIndex: number) => void} options.onReorder
 * @returns {{
 *   dragging: {blockId: string, fromIndex: number, toIndex: number}|null,
 *   startDrag: (event: PointerEvent, blockId: string, index: number) => void,
 * }}
 */
export default function useVfxBlockDrag({ listRef, blocks, onReorder }) {
  const { getZoom } = useReactFlow()
  const state = useRef(null)
  const [dragging, setDragging] = useState(null)

  // The row elements, by block id. Read from the DOM at drag start rather than
  // tracked with refs per row: the rows are rendered by a map and collecting a
  // ref per row would mean a callback ref on every one, invalidated on every
  // render.
  const rowsOf = useCallback(() => {
    const list = listRef.current
    if (!list) return []
    return Array.from(list.querySelectorAll('[data-block-id]'))
  }, [listRef])

  const clearTransforms = useCallback(() => {
    for (const row of rowsOf()) {
      row.style.transform = ''
      row.style.zIndex = ''
      row.classList.remove('is-dragging')
    }
  }, [rowsOf])

  // Declared before the handlers it detaches, so it is hoisted into their
  // closures - the pointer handlers and finish() are mutually recursive
  // through `detach`, which is why that one is a ref rather than a callback.
  const detach = useRef(() => {})

  const finish = useCallback(commit => {
    const current = state.current
    state.current = null
    detach.current()
    setDragging(null)
    clearTransforms()
    document.body.classList.remove('is-row-dragging')
    if (!current) return
    if (commit && current.toIndex !== current.fromIndex && current.moved) {
      onReorder?.(current.blockId, current.toIndex)
    }
  }, [clearTransforms, onReorder])

  const handleMove = useCallback(event => {
    const current = state.current
    if (!current) return

    // The division that makes this work at any zoom. See the header.
    const dy = (event.clientY - current.startY) / current.zoom

    if (!current.moved) {
      if (Math.abs(event.clientY - current.startY) < DRAG_SLOP_PX) return
      current.moved = true
      current.element.classList.add('is-dragging')
      current.element.style.zIndex = '5'
      document.body.classList.add('is-row-dragging')
      setDragging({
        blockId: current.blockId,
        fromIndex: current.fromIndex,
        toIndex: current.fromIndex,
      })
    }

    current.element.style.transform = `translateY(${dy}px)`

    // Where the dragged row's midpoint now sits, against the bands measured at
    // drag start. Bands are cached because measuring during a drag would read
    // back the transforms we just wrote and the insertion point would chase
    // itself.
    const centre = current.centre + dy
    let next = current.bands.length - 1
    for (let i = 0; i < current.bands.length; i += 1) {
      if (centre < current.bands[i].end) {
        next = i
        break
      }
    }

    if (next !== current.toIndex) {
      current.toIndex = next
      setDragging({
        blockId: current.blockId,
        fromIndex: current.fromIndex,
        toIndex: next,
      })
    }
  }, [])

  const handleUp = useCallback(() => finish(true), [finish])
  const handleCancel = useCallback(() => finish(false), [finish])

  const startDrag = useCallback((event, blockId, index) => {
    if (event.button !== 0) return
    const list = listRef.current
    if (!list) return
    const rows = rowsOf()
    const element = rows.find(row => row.dataset.blockId === blockId)
    if (!element) return

    event.preventDefault()
    event.stopPropagation()

    // Layout-space bands, one per row, in the coordinate space offsetTop uses.
    // A row's band ends at its own bottom edge, so a midpoint below that edge
    // belongs to the next row - which is what makes the insertion point flip
    // exactly when the dragged row has travelled half a row.
    const bands = rows.map(row => ({
      start: row.offsetTop,
      end: row.offsetTop + row.offsetHeight,
    }))

    state.current = {
      blockId,
      fromIndex: index,
      toIndex: index,
      startY: event.clientY,
      // Read once. A pinch-zoom mid-drag must not move the origin under the
      // author's hand.
      zoom: getZoom() || 1,
      element,
      bands,
      centre: element.offsetTop + element.offsetHeight / 2,
      moved: false,
    }

    // On the window, not on the row: pointer capture inside React Flow's
    // transformed subtree is unreliable when the node re-renders mid-drag (a
    // commit elsewhere on the page replaces the row element and the capture
    // goes with it). Window listeners survive that.
    //
    // They are removed by finish(), NOT by an effect keyed on `dragging` -
    // that was the first version and it was broken: `dragging` changes every
    // time the insertion point moves, so the effect's cleanup tore the
    // listeners down on the first band crossing and the drag died mid-gesture.
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleCancel)
    detach.current = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleCancel)
    }
  }, [getZoom, handleCancel, handleMove, handleUp, listRef, rowsOf])

  // A drag in flight when the block list changes underneath it - an undo, a
  // collaborator, a template load - has nothing coherent to commit to.
  useEffect(() => {
    if (state.current && !blocks.some(block => block.id === state.current.blockId)) {
      finish(false)
    }
  }, [blocks, finish])

  useEffect(() => () => {
    detach.current()
    document.body.classList.remove('is-row-dragging')
  }, [])

  return { dragging, startDrag }
}
