// The animation dock's dopesheet: bone names on the left, one scrollable time grid
// on the right, the two locked to the same vertical scroll.
//
// Why a canvas and not rows of divs: a rig is ~60 bones and a generated clip a few
// hundred frames, so the grid is tens of thousands of cells. As DOM that is a
// scroll-jank machine; as one canvas redrawn from the visible window it is a
// fraction of a millisecond.
//
// What a marker MEANS here is the one thing to understand before reading the
// drawing code. The bake puts a key on every frame of every animated track, so
// "draw a diamond where a key exists" would fill every animated row solid. The
// markers therefore show MOTION — the frames where the value actually changes —
// which is what makes a row readable at a glance ("this arm only moves between 20
// and 50"). Off-grid tracks (the hand-curl finger tracks) have no frame grid to
// diff, so they draw their real, sparse keys, hollow and locked.
//
// A selection is a rectangle of tracks × frames. Delete flattens it (the frames
// take the interpolation across the selection), and dragging it sideways shifts
// those values in time — see flattenFrameRange / shiftFrameRange.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { activeRuns } from '../../utils/animationDopesheet'

export const SHEET_ROW_H = 20        // must match --anim-sheet-row-h in the CSS
const RULER_H = 22
const MIN_PX_PER_FRAME = 2
const MAX_PX_PER_FRAME = 40
const DRAG_SLOP = 3                  // px before a click becomes a drag

const COLOR = {
  gridLine: 'rgba(255, 255, 255, 0.06)',
  gridLineMajor: 'rgba(255, 255, 255, 0.13)',
  rowAlt: 'rgba(255, 255, 255, 0.022)',
  rowSelected: 'rgba(143, 245, 255, 0.07)',
  baseline: 'rgba(255, 255, 255, 0.10)',
  marker: '#7fdfe8',
  markerSelected: '#ffffff',
  locked: 'rgba(190, 195, 205, 0.75)',
  selectFill: 'rgba(143, 245, 255, 0.13)',
  selectEdge: 'rgba(143, 245, 255, 0.55)',
  ghostEdge: 'rgba(255, 209, 102, 0.9)',
  playhead: '#ffffff',
  rulerText: 'rgba(226, 232, 240, 0.75)',
}

// Tick every 1/2/5/10/… frames — whichever is the first that leaves ≥48px between
// labels at the current zoom.
function tickStep(pxPerFrame) {
  let step = 1
  while (step * pxPerFrame < 48 && step < 1e6) step = nextStep(step)
  return step
}

function nextStep(step) {
  const pow = 10 ** Math.floor(Math.log10(step))
  const lead = step / pow
  if (lead < 2) return 2 * pow
  if (lead < 5) return 5 * pow
  return 10 * pow
}

// The tracks a row contributes to a selection. Locked bones are left out: their
// tracks are rebuilt by every bake, so an edit to one would be thrown away.
function rowTracks(row) {
  if (!row) return []
  if (row.type === 'track') return row.bone.editable ? [row.trackName] : []
  if (!row.bone.editable) return []
  return [row.bone.rotation, row.bone.position].filter(Boolean)
}

export default function AnimationDopesheet({
  rows,                 // [{ boneName, rotation, position, editable, keyCount }], hierarchy order
  sheet,                // buildDopesheet(clip, description)
  frameCount,
  frame,
  onFrameChange,
  selectedBone,
  onSelectBone,
  onClearBone,
  onAddBone,
  onDeleteRange,        // (trackNames, from, to)
  onShiftRange,         // (trackNames, from, to, delta)
  playing,
  animatedCount,
}) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [pxPerFrame, setPxPerFrame] = useState(8)
  const [selectionState, setSelectionState] = useState(null)   // { rowFrom, rowTo, from, to, stamp }
  // Only a re-render trigger: the drag itself lives in `dragRef` (pointer events
  // outrun React), and the layout effect below repaints after every render.
  const [, setDrag] = useState(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  const gridRef = useRef(null)
  const namesRef = useRef(null)
  const canvasRef = useRef(null)
  const rulerRef = useRef(null)
  const scrollRef = useRef({ left: 0, top: 0 })
  const dragRef = useRef(null)
  const rafRef = useRef(0)
  const autoFitRef = useRef(0)
  const paintRef = useRef(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(b => b.boneName.toLowerCase().includes(q))
  }, [rows, search])

  // One flat list drives BOTH columns — that is what guarantees the names line up
  // with the lanes, whatever is expanded or filtered out.
  const flat = useMemo(() => {
    const out = []
    for (const bone of filtered) {
      out.push({ type: 'bone', bone, key: bone.boneName })
      if (expanded.has(bone.boneName)) {
        if (bone.rotation) out.push({ type: 'track', bone, kind: 'rotation', trackName: bone.rotation, key: bone.rotation })
        if (bone.position) out.push({ type: 'track', bone, kind: 'position', trackName: bone.position, key: bone.position })
      }
    }
    return out
  }, [filtered, expanded])

  const contentW = Math.max(1, frameCount * pxPerFrame)
  const contentH = Math.max(1, flat.length * SHEET_ROW_H)

  // Fit the clip to the width the first time it is measured (and whenever the clip
  // length changes), then leave the zoom to the user.
  useEffect(() => {
    if (!size.w || !frameCount) return
    if (autoFitRef.current === frameCount) return
    autoFitRef.current = frameCount
    const fit = size.w / frameCount
    setPxPerFrame(Math.max(MIN_PX_PER_FRAME, Math.min(14, fit)))
  }, [size.w, frameCount])

  useEffect(() => {
    const el = gridRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })   // only the zoom-to-fit needs this
      paintRef.current?.()
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Selection rows are indices into `flat`, so filtering, collapsing a bone or a
  // clip that changed length would silently move a selection onto other bones. It
  // carries the shape it was made against and is ignored once that no longer holds
  // — derived rather than cleared in an effect, so there is no render where a stale
  // rectangle is still live.
  const sheetStamp = `${flat.length}:${frameCount}`
  const selection = selectionState?.stamp === sheetStamp ? selectionState : null
  const setSelection = useCallback(
    rect => setSelectionState(rect ? { ...rect, stamp: sheetStamp } : null),
    [sheetStamp],
  )

  const selectedTracks = useMemo(() => {
    if (!selection) return []
    const names = new Set()
    for (let i = selection.rowFrom; i <= selection.rowTo; i++) {
      for (const t of rowTracks(flat[i])) names.add(t)
    }
    return [...names]
  }, [selection, flat])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = gridRef.current
    if (!canvas || !wrap) return
    const vw = wrap.clientWidth
    const vh = wrap.clientHeight
    if (!vw || !vh) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
      canvas.width = Math.round(vw * dpr)
      canvas.height = Math.round(vh * dpr)
    }
    canvas.style.width = `${vw}px`
    canvas.style.height = `${vh}px`

    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, vw, vh)

    const { left: scrollX, top: scrollY } = scrollRef.current
    const x0 = f => f * pxPerFrame - scrollX
    const firstFrame = Math.max(0, Math.floor(scrollX / pxPerFrame) - 1)
    const lastFrame = Math.min(frameCount - 1, Math.ceil((scrollX + vw) / pxPerFrame) + 1)
    const firstRow = Math.max(0, Math.floor(scrollY / SHEET_ROW_H))
    const lastRow = Math.min(flat.length - 1, Math.ceil((scrollY + vh) / SHEET_ROW_H))

    // Row bands: alternating stripes, plus the selected bone's own band so the
    // lane matching the numeric editor is obvious.
    for (let r = firstRow; r <= lastRow; r++) {
      const row = flat[r]
      const y = r * SHEET_ROW_H - scrollY
      if (row.bone.boneName === selectedBone) {
        ctx.fillStyle = COLOR.rowSelected
        ctx.fillRect(0, y, vw, SHEET_ROW_H)
      } else if (r % 2) {
        ctx.fillStyle = COLOR.rowAlt
        ctx.fillRect(0, y, vw, SHEET_ROW_H)
      }
    }

    // Time grid.
    const step = tickStep(pxPerFrame)
    ctx.lineWidth = 1
    for (let f = Math.ceil(firstFrame / step) * step; f <= lastFrame; f += step) {
      const x = Math.round(x0(f)) + 0.5
      ctx.strokeStyle = f === 0 ? COLOR.gridLineMajor : COLOR.gridLine
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, vh)
      ctx.stroke()
    }

    // The selection: its wash goes UNDER the markers (so the keys inside it stay
    // legible), its border and drag ghost go over them, further down.
    const live = dragRef.current
    const rect = live?.mode === 'select' ? live.rect : selection
    const rectBox = rect ? {
      x: x0(rect.from) - pxPerFrame / 2,
      w: (rect.to - rect.from + 1) * pxPerFrame,
      y: rect.rowFrom * SHEET_ROW_H - scrollY,
      h: (rect.rowTo - rect.rowFrom + 1) * SHEET_ROW_H,
    } : null
    if (rectBox) {
      ctx.fillStyle = COLOR.selectFill
      ctx.fillRect(rectBox.x, rectBox.y, rectBox.w, rectBox.h)
    }

    const inSelection = (rowIndex) => rect && rowIndex >= rect.rowFrom && rowIndex <= rect.rowTo
    const diamond = Math.max(3, Math.min(pxPerFrame - 1, SHEET_ROW_H - 9, 9))
    const half = diamond / 2

    for (let r = firstRow; r <= lastRow; r++) {
      const row = flat[r]
      const y = r * SHEET_ROW_H - scrollY
      const cy = y + SHEET_ROW_H / 2

      const entries = row.type === 'track'
        ? [sheet?.tracks.get(row.trackName)].filter(Boolean)
        : [sheet?.bones.get(row.bone.boneName)].filter(Boolean)
      if (!entries.length) continue

      for (const entry of entries) {
        // The clip drives this bone: a hairline across the whole clip says so even
        // where nothing moves, so an animated-but-still bone never reads as absent.
        ctx.strokeStyle = COLOR.baseline
        ctx.beginPath()
        ctx.moveTo(Math.max(0, x0(0)), Math.round(cy) + 0.5)
        ctx.lineTo(Math.min(vw, x0(frameCount - 1)), Math.round(cy) + 0.5)
        ctx.stroke()

        // Off-grid tracks: their literal keys, hollow, because they are not editable.
        if (entry.keys) {
          ctx.strokeStyle = COLOR.locked
          for (let f = firstFrame; f <= lastFrame; f++) {
            if (!entry.keys[f]) continue
            const x = x0(f)
            ctx.strokeRect(x - 3.5, cy - 3.5, 7, 7)
          }
        }
        if (!entry.active) continue

        const runs = activeRuns(entry.active, firstFrame, lastFrame)
        if (pxPerFrame < 5) {
          // Too tight for one shape per frame: draw the moving spans as bars.
          for (const [a, b] of runs) {
            const selected = inSelection(r) && b >= rect.from && a <= rect.to
            ctx.fillStyle = selected ? COLOR.markerSelected : COLOR.marker
            ctx.globalAlpha = 0.85
            ctx.fillRect(x0(a) - pxPerFrame / 2, cy - 3, (b - a + 1) * pxPerFrame, 6)
            ctx.globalAlpha = 1
          }
          continue
        }

        // One path per colour rather than per marker — a walk cycle is a few
        // thousand diamonds and each fill() has a cost.
        for (const selected of [false, true]) {
          ctx.beginPath()
          let any = false
          for (const [a, b] of runs) {
            for (let f = a; f <= b; f++) {
              const isSel = !!(inSelection(r) && rect.from <= f && f <= rect.to)
              if (isSel !== selected) continue
              const x = x0(f)
              ctx.moveTo(x, cy - half)
              ctx.lineTo(x + half, cy)
              ctx.lineTo(x, cy + half)
              ctx.lineTo(x - half, cy)
              ctx.closePath()
              any = true
            }
          }
          if (!any) continue
          ctx.fillStyle = selected ? COLOR.markerSelected : COLOR.marker
          ctx.fill()
        }
      }
    }

    // The selection's border, and where a move drag would drop it.
    if (rectBox) {
      const { x, y, w, h } = rectBox
      ctx.strokeStyle = COLOR.selectEdge
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
      if (live?.mode === 'move' && live.delta) {
        ctx.setLineDash([4, 3])
        ctx.strokeStyle = COLOR.ghostEdge
        ctx.strokeRect(Math.round(x + live.delta * pxPerFrame) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
        ctx.setLineDash([])
      }
    }

    // Playhead last, over everything.
    const px = Math.round(x0(frame)) + 0.5
    if (px >= 0 && px <= vw) {
      ctx.strokeStyle = COLOR.playhead
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, vh)
      ctx.stroke()
    }

    // --- ruler ---
    const ruler = rulerRef.current
    if (ruler) {
      if (ruler.width !== Math.round(vw * dpr) || ruler.height !== Math.round(RULER_H * dpr)) {
        ruler.width = Math.round(vw * dpr)
        ruler.height = Math.round(RULER_H * dpr)
      }
      ruler.style.width = `${vw}px`
      ruler.style.height = `${RULER_H}px`
      const rc = ruler.getContext('2d')
      rc.setTransform(dpr, 0, 0, dpr, 0, 0)
      rc.clearRect(0, 0, vw, RULER_H)
      rc.font = '10px system-ui, sans-serif'
      rc.textBaseline = 'middle'
      for (let f = Math.ceil(firstFrame / step) * step; f <= lastFrame; f += step) {
        const x = Math.round(x0(f)) + 0.5
        rc.strokeStyle = COLOR.gridLineMajor
        rc.beginPath()
        rc.moveTo(x, RULER_H - 6)
        rc.lineTo(x, RULER_H)
        rc.stroke()
        rc.fillStyle = COLOR.rulerText
        rc.fillText(String(f), x + 3, RULER_H / 2 - 2)
      }
      if (px >= 0 && px <= vw) {
        rc.fillStyle = COLOR.playhead
        rc.beginPath()
        rc.moveTo(px - 4, 2)
        rc.lineTo(px + 4, 2)
        rc.lineTo(px, 9)
        rc.closePath()
        rc.fill()
        rc.strokeStyle = COLOR.playhead
        rc.beginPath()
        rc.moveTo(px, 8)
        rc.lineTo(px, RULER_H)
        rc.stroke()
      }
    }
  }, [flat, sheet, frameCount, frame, pxPerFrame, selection, selectedBone])

  // The canvas is repainted through a REF, not through state, and after every render.
  //
  // The first version scheduled repaints from an effect keyed on a `size` state that
  // a ResizeObserver wrote. Anything that changed the pane's height without changing
  // that state — a later layout pass, a wrapped toolbar settling, the dock's resize
  // grip — left the canvas sized and drawn for the OLD box: a few pixels tall at the
  // top of a pane that still scrolled and still mapped clicks correctly, i.e. an
  // empty sheet you can click in. Painting from a ref removes the whole class:
  // whatever caused a change, the next frame redraws from the live geometry.
  useLayoutEffect(() => { paintRef.current = paint })
  const schedule = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; paintRef.current?.() })
  }, [])

  useLayoutEffect(() => { schedule() })
  // The reset is load-bearing, not tidiness: `schedule` dedupes on this id, so a
  // cleanup that cancels the frame without clearing it LATCHES the guard and no
  // render ever repaints again. StrictMode hits that on the very first mount (it
  // runs effects, cleans up, re-runs), and so does closing and reopening the dock
  // with a frame in flight. The symptom is a sheet that draws once — the
  // ResizeObserver still paints directly — then freezes: a playhead that ignores
  // the frame and zoom buttons that change nothing.
  useEffect(() => () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
  }, [])

  // ONE vertical scroll for both columns, and it belongs to the grid: the names are
  // translated to match rather than scrolled themselves.
  //
  // Two elements each scrolling their own copy would drift, because the grid gives
  // up height to its horizontal scrollbar and so has a longer scroll range than the
  // names beside it — at the bottom of a long rig the names would sit a row off
  // their own keys. A transform cannot drift.
  const handleGridScroll = useCallback(e => {
    scrollRef.current = { left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }
    if (namesRef.current) namesRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`
    schedule()
  }, [schedule])

  // The names column has no scrollbar of its own, so a wheel over it would do
  // nothing (or scroll something behind it). Hand it to the grid.
  useEffect(() => {
    const el = namesRef.current?.parentElement
    if (!el) return undefined
    const onWheel = (e) => {
      if (!gridRef.current) return
      e.preventDefault()
      gridRef.current.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Keep the selected bone's row on screen when the selection came from the
  // viewport or the skeleton tree rather than from this list.
  useEffect(() => {
    if (!selectedBone) return
    const index = flat.findIndex(r => r.type === 'bone' && r.bone.boneName === selectedBone)
    if (index < 0) return
    const el = gridRef.current
    if (!el) return
    const top = index * SHEET_ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + SHEET_ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + SHEET_ROW_H - el.clientHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBone])

  const pointToCell = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left + scrollRef.current.left
    const y = e.clientY - rect.top + scrollRef.current.top
    const f = Math.max(0, Math.min(frameCount - 1, Math.round(x / pxPerFrame)))
    const r = Math.max(0, Math.min(flat.length - 1, Math.floor(y / SHEET_ROW_H)))
    return { frame: f, row: r, clientX: e.clientX }
  }, [frameCount, pxPerFrame, flat.length])

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0 || !flat.length) return
    const cell = pointToCell(e)
    if (!cell) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    gridRef.current?.focus?.()

    const insideSelection = !playing && selection
      && cell.row >= selection.rowFrom && cell.row <= selection.rowTo
      && cell.frame >= selection.from && cell.frame <= selection.to

    if (insideSelection && !e.shiftKey) {
      dragRef.current = { mode: 'move', startX: cell.clientX, delta: 0, moved: false }
    } else if (e.shiftKey && selection) {
      // Extend: the anchor becomes the corner FURTHEST from the click, so dragging
      // on from here grows or shrinks the existing rectangle instead of starting a
      // new one at the click.
      const anchor = {
        row: Math.abs(cell.row - selection.rowFrom) > Math.abs(cell.row - selection.rowTo)
          ? selection.rowFrom : selection.rowTo,
        frame: Math.abs(cell.frame - selection.from) > Math.abs(cell.frame - selection.to)
          ? selection.from : selection.to,
        clientX: cell.clientX,
      }
      const rect = {
        rowFrom: Math.min(anchor.row, cell.row), rowTo: Math.max(anchor.row, cell.row),
        from: Math.min(anchor.frame, cell.frame), to: Math.max(anchor.frame, cell.frame),
      }
      dragRef.current = { mode: 'select', anchor, rect, moved: true, startX: cell.clientX }
      setSelection(rect)
    } else {
      const rect = { rowFrom: cell.row, rowTo: cell.row, from: cell.frame, to: cell.frame }
      dragRef.current = { mode: 'select', anchor: cell, rect, moved: false, startX: cell.clientX }
    }
    setDrag(dragRef.current)
  }, [flat.length, playing, pointToCell, selection, setSelection])

  const handlePointerMove = useCallback((e) => {
    const live = dragRef.current
    if (!live) return
    const cell = pointToCell(e)
    if (!cell) return
    if (live.mode === 'move') {
      const delta = Math.round((e.clientX - live.startX) / pxPerFrame)
      if (delta === live.delta) return
      live.delta = delta
      live.moved = live.moved || Math.abs(e.clientX - live.startX) > DRAG_SLOP
    } else {
      if (!live.moved && Math.abs(e.clientX - live.startX) < DRAG_SLOP && cell.row === live.anchor.row) return
      live.moved = true
      live.rect = {
        rowFrom: Math.min(live.anchor.row, cell.row), rowTo: Math.max(live.anchor.row, cell.row),
        from: Math.min(live.anchor.frame, cell.frame), to: Math.max(live.anchor.frame, cell.frame),
      }
    }
    setDrag({ ...live })
    schedule()
  }, [pointToCell, pxPerFrame, schedule])

  const handlePointerUp = useCallback((e) => {
    const live = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!live) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)

    if (live.mode === 'move') {
      if (live.delta && selection && selectedTracks.length) {
        onShiftRange?.(selectedTracks, selection.from, selection.to, live.delta)
        const clamped = Math.max(-selection.from, Math.min(frameCount - 1 - selection.to, live.delta))
        setSelection({ ...selection, from: selection.from + clamped, to: selection.to + clamped })
      }
      return
    }

    setSelection(live.rect)
    // A click, not a drag: pick the bone and put the playhead on the frame — the
    // two things a single click on a timeline is expected to do.
    if (!live.moved) {
      const row = flat[live.anchor.row]
      if (row) onSelectBone?.(row.bone.boneName)
      if (!playing) onFrameChange?.(live.anchor.frame)
    }
  }, [flat, frameCount, onFrameChange, onSelectBone, onShiftRange, playing, selection, selectedTracks, setSelection])

  // Ctrl/⌘ + wheel zooms about the cursor. A native listener because React's own
  // wheel handler is passive — preventDefault there would be ignored, and the page
  // would zoom instead of the sheet.
  useEffect(() => {
    const el = gridRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const canvas = canvasRef.current
      if (!canvas) return
      const offsetX = e.clientX - canvas.getBoundingClientRect().left
      setPxPerFrame(prev => {
        const next = Math.max(MIN_PX_PER_FRAME, Math.min(MAX_PX_PER_FRAME, prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
        const anchorFrame = (offsetX + scrollRef.current.left) / prev
        // Keep the frame under the cursor under the cursor.
        requestAnimationFrame(() => {
          if (gridRef.current) gridRef.current.scrollLeft = Math.max(0, anchorFrame * next - offsetX)
        })
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const deleteSelection = useCallback(() => {
    if (!selection || !selectedTracks.length || playing) return
    onDeleteRange?.(selectedTracks, selection.from, selection.to)
  }, [onDeleteRange, playing, selection, selectedTracks])

  const nudge = useCallback((delta) => {
    if (!selection || !selectedTracks.length || playing) return
    onShiftRange?.(selectedTracks, selection.from, selection.to, delta)
    const clamped = Math.max(-selection.from, Math.min(frameCount - 1 - selection.to, delta))
    setSelection({ ...selection, from: selection.from + clamped, to: selection.to + clamped })
  }, [frameCount, onShiftRange, playing, selection, selectedTracks, setSelection])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection() }
    else if (e.key === 'Escape') setSelection(null)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      e.preventDefault()
      if (e.altKey) nudge(dir * (e.shiftKey ? 5 : 1))
      else if (!playing) onFrameChange?.(Math.max(0, Math.min(frameCount - 1, frame + dir)))
    }
  }, [deleteSelection, frame, frameCount, nudge, onFrameChange, playing, setSelection])

  // The ruler scrubs, with the same click-and-drag as the scrub bar above.
  const scrubFrom = useCallback((e) => {
    if (playing) return
    const ruler = rulerRef.current
    if (!ruler) return
    const rect = ruler.getBoundingClientRect()
    const f = Math.round((e.clientX - rect.left + scrollRef.current.left) / pxPerFrame)
    onFrameChange?.(Math.max(0, Math.min(frameCount - 1, f)))
  }, [frameCount, onFrameChange, playing, pxPerFrame])

  const toggleExpand = useCallback((boneName) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(boneName)) next.delete(boneName)
      else next.add(boneName)
      return next
    })
  }, [])

  const selectionLabel = selection
    ? `${selectedTracks.length} track${selectedTracks.length === 1 ? '' : 's'} · frames ${selection.from}–${selection.to}`
    : 'Drag on the sheet to select keys'

  return (
    <div className="mesh-editor-anim-sheet">
      <div className="mesh-editor-anim-sheet__toolbar">
        <div className="mesh-editor-anim__search">
          <span className="material-symbols-outlined">search</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search bones…"
            aria-label="Search bones"
          />
          {search && (
            <button type="button" className="mesh-editor-anim__search-clear" onClick={() => setSearch('')}
              title="Clear search" aria-label="Clear search">
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>

        <span className={`mesh-editor-anim-sheet__selection ${selection ? 'mesh-editor-anim-sheet__selection--on' : ''}`}>
          {selectionLabel}
        </span>

        <div className="mesh-editor-anim-dock__frame-ops">
          <button type="button" className="mesh-editor-icon-btn" disabled={!selection || playing}
            onClick={() => nudge(-1)}
            title="Move the selected keys one frame earlier (Alt+← , with Shift for 5)">
            <span className="material-symbols-outlined">keyboard_arrow_left</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" disabled={!selection || playing}
            onClick={() => nudge(1)}
            title="Move the selected keys one frame later (Alt+→ , with Shift for 5)">
            <span className="material-symbols-outlined">keyboard_arrow_right</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn mesh-editor-anim-dock__clear" disabled={!selection || playing}
            onClick={deleteSelection}
            title="Delete the selected keys — those frames stop holding their own values and take the interpolation across the selection (Delete)">
            <span className="material-symbols-outlined">delete</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn" disabled={!selection}
            onClick={() => setSelection(null)} title="Clear the selection (Esc)">
            <span className="material-symbols-outlined">deselect</span>
          </button>
        </div>

        <div className="mesh-editor-anim-dock__frame-ops mesh-editor-anim-sheet__zoom">
          <button type="button" className="mesh-editor-icon-btn"
            onClick={() => setPxPerFrame(p => Math.max(MIN_PX_PER_FRAME, p / 1.4))} title="Zoom out (Ctrl + wheel)">
            <span className="material-symbols-outlined">zoom_out</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn"
            onClick={() => setPxPerFrame(p => Math.min(MAX_PX_PER_FRAME, p * 1.4))} title="Zoom in (Ctrl + wheel)">
            <span className="material-symbols-outlined">zoom_in</span>
          </button>
          <button type="button" className="mesh-editor-icon-btn"
            onClick={() => {
              if (!size.w || !frameCount) return
              setPxPerFrame(Math.max(MIN_PX_PER_FRAME, size.w / frameCount))
              if (gridRef.current) gridRef.current.scrollLeft = 0
            }}
            title="Fit the whole clip in the window">
            <span className="material-symbols-outlined">fit_screen</span>
          </button>
        </div>
      </div>

      <div className="mesh-editor-anim-sheet__body">
        <div className="mesh-editor-anim-sheet__left">
          <div className="mesh-editor-anim-sheet__left-head">
            <span className="mesh-editor-panel__hint">{rows.length} bones · {animatedCount} animated</span>
          </div>
          <div className="mesh-editor-anim-sheet__names">
            <div className="mesh-editor-anim-sheet__names-inner" ref={namesRef}>
            {flat.length === 0 ? (
              <div className="mesh-editor-layers-panel__empty">No bone matches that.</div>
            ) : flat.map(row => (
              row.type === 'bone' ? (
                <div
                  key={row.key}
                  role="button"
                  tabIndex={0}
                  className={`mesh-editor-anim-sheet__name ${row.bone.boneName === selectedBone ? 'mesh-editor-anim-sheet__name--selected' : ''} ${row.bone.rotation || row.bone.position ? '' : 'mesh-editor-anim-sheet__name--idle'}`}
                  onClick={() => onSelectBone?.(row.bone.boneName)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectBone?.(row.bone.boneName) }
                  }}
                  title={row.bone.editable
                    ? (row.bone.rotation || row.bone.position
                      ? `${row.bone.boneName} — ${row.bone.rotation ? 'rotation' : ''}${row.bone.rotation && row.bone.position ? ' + ' : ''}${row.bone.position ? 'position' : ''}`
                      : `${row.bone.boneName} is not animated by this clip — add it to pose it`)
                    : `${row.bone.boneName} is driven by the Hand curl sliders (${row.bone.keyCount} keys, off the frame grid) and is rebuilt on every bake — not editable here`}
                >
                  {(row.bone.rotation || row.bone.position) ? (
                    <button
                      type="button"
                      className="mesh-editor-anim-sheet__caret"
                      onClick={e => { e.stopPropagation(); toggleExpand(row.bone.boneName) }}
                      title={expanded.has(row.bone.boneName) ? 'Collapse' : 'Show this bone’s rotation and position lanes'}
                      aria-label={expanded.has(row.bone.boneName) ? 'Collapse' : 'Expand'}
                    >
                      <span className="material-symbols-outlined">
                        {expanded.has(row.bone.boneName) ? 'arrow_drop_down' : 'arrow_right'}
                      </span>
                    </button>
                  ) : <span className="mesh-editor-anim-sheet__caret-spacer" />}

                  <span className="mesh-editor-anim-sheet__name-text">{row.bone.boneName}</span>
                  {!row.bone.editable && <span className="material-symbols-outlined">lock</span>}
                  {row.bone.editable && onClearBone && (row.bone.rotation || row.bone.position) && (
                    <button
                      type="button"
                      className="mesh-editor-icon-btn mesh-editor-anim-sheet__row-btn"
                      onClick={e => { e.stopPropagation(); onClearBone(row.bone.boneName) }}
                      disabled={playing}
                      title={playing
                        ? 'Pause the clip to clear a bone'
                        : `Clear ${row.bone.boneName}'s animation — every frame takes the bone's rest pose. Undoable.`}
                      aria-label={`Clear ${row.bone.boneName}'s animation`}
                    >
                      <span className="material-symbols-outlined">delete_sweep</span>
                    </button>
                  )}
                  {row.bone.editable && onAddBone && !row.bone.rotation && !row.bone.position && (
                    <button
                      type="button"
                      className="mesh-editor-icon-btn mesh-editor-anim-sheet__row-btn"
                      onClick={e => { e.stopPropagation(); onAddBone(row.bone.boneName) }}
                      disabled={playing}
                      title={playing
                        ? 'Pause the clip to add a bone'
                        : `Add ${row.bone.boneName} to this animation — every frame starts at its rest pose`}
                      aria-label={`Add ${row.bone.boneName} to this animation`}
                    >
                      <span className="material-symbols-outlined">add</span>
                    </button>
                  )}
                </div>
              ) : (
                <div
                  key={row.key}
                  className="mesh-editor-anim-sheet__name mesh-editor-anim-sheet__name--track"
                  title={row.trackName}
                >
                  <span className="mesh-editor-anim-sheet__caret-spacer" />
                  <span className="material-symbols-outlined">
                    {row.kind === 'position' ? 'open_with' : 'rotate_right'}
                  </span>
                  <span className="mesh-editor-anim-sheet__name-text">
                    {row.kind === 'position' ? 'Position' : 'Rotation'}
                  </span>
                </div>
              )
            ))}
            </div>
          </div>
        </div>

        <div className="mesh-editor-anim-sheet__right">
          <div className="mesh-editor-anim-sheet__ruler">
            <canvas
              ref={rulerRef}
              onPointerDown={e => {
                e.currentTarget.setPointerCapture?.(e.pointerId)
                scrubFrom(e)
              }}
              onPointerMove={e => { if (e.buttons & 1) scrubFrom(e) }}
              onPointerUp={e => e.currentTarget.releasePointerCapture?.(e.pointerId)}
            />
          </div>
          <div
            className="mesh-editor-anim-sheet__grid"
            ref={gridRef}
            tabIndex={0}
            onScroll={handleGridScroll}
            onKeyDown={handleKeyDown}
            aria-label="Animation keys"
          >
            <div className="mesh-editor-anim-sheet__content" style={{ width: `${contentW}px`, height: `${contentH}px` }}>
              <canvas
                ref={canvasRef}
                className="mesh-editor-anim-sheet__canvas"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
