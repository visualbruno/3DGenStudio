// Bake the open effect into a flipbook sprite sheet.
//
// THE NUMBERS ARE SHOWN, NOT JUST ASKED FOR. Four inputs decide six things -
// how many cells, which frames, how big the file is, whether it will even fit
// in a texture - and every one of those is derivable. So the dialog derives
// them and puts them on screen, because "16 cells, every 7th frame, 0.12s
// apart, 2048x2048" answers questions that "columns: 4, rows: 4" does not.
//
// The camera is NOT a control here. The sheet is baked from wherever the
// preview camera is standing, which is the same rule Snapshot follows: where
// to stand is a judgement, and the viewport is where it is made. What that
// does mean is that the framing has to hold for the WHOLE range, so the hint
// says to frame the effect at its widest moment.
import { useMemo, useState } from 'react'
import {
  MAX_SHEET_PIXELS,
  captureSpriteSheet,
  planSpriteSheet,
} from '../../utils/vfx/spriteSheet.js'
import './VfxSheetDialog.css'

const CELL_SIZES = [64, 128, 256, 512]

/**
 * @param {Object} props
 * @param {Object} props.ir the compiled effect
 * @param {Object} props.doc the open document, for duration and loop
 * @param {string} props.name
 * @param {{current: import('three').Camera|null}} props.cameraRef the live
 *   preview camera, as a REF rather than a value: it is read when the bake
 *   starts, so orbiting after opening this dialog still changes the result -
 *   which is what anyone framing a shot expects
 * @param {Map<number, Object>} props.textures
 * @param {Map<number, Object>} props.meshes
 * @param {() => void} props.onClose
 * @param {(message: string, type?: string) => void} props.notify
 */
export default function VfxSheetDialog({
  ir, doc, name, cameraRef, textures, meshes, onClose, notify,
}) {
  const fixedDt = doc.effect.fixedDt || 1 / 60
  const durationFrames = Math.max(1, Math.round((doc.effect.duration || 1) / fixedDt))

  const [startFrame, setStartFrame] = useState(0)
  const [endFrame, setEndFrame] = useState(durationFrames)
  const [columns, setColumns] = useState(4)
  const [rows, setRows] = useState(4)
  const [cell, setCell] = useState(256)
  const [transparent, setTransparent] = useState(true)
  const [toneMapped, setToneMapped] = useState(true)
  const [progress, setProgress] = useState('')
  const [busy, setBusy] = useState(false)

  const plan = useMemo(() => planSpriteSheet({
    startFrame, endFrame, columns, rows, cell, loop: doc.effect.loop !== false,
  }), [startFrame, endFrame, columns, rows, cell, doc.effect.loop])

  const seconds = (frames) => `${(frames * fixedDt).toFixed(2)}s`

  const bake = async () => {
    const camera = cameraRef?.current
    if (!camera) return notify('The preview has not started yet.', 'error')
    setBusy(true)
    setProgress('Starting…')
    try {
      const blob = await captureSpriteSheet({
        ir,
        camera,
        plan,
        textures,
        meshes,
        transparent,
        toneMapped,
        onProgress: (done, total) => setProgress(`Rendering cell ${done} of ${total}…`),
      })
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'effect'
      // The grid is in the filename because a flipbook is useless without it:
      // whoever imports this has to tell the engine 4 by 4, and the sheet
      // itself does not say so anywhere else.
      const file = `${slug}-sheet-${plan.columns}x${plan.rows}.png`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file
      link.click()
      URL.revokeObjectURL(url)
      notify(`Saved ${file}`, 'success')
      onClose()
    } catch (err) {
      notify(err?.message || 'The sprite sheet could not be rendered.', 'error')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  const number = (value, set, min, max) => (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={busy}
      onChange={(event) => set(Number(event.target.value))}
    />
  )

  return (
    <div className="vfx-sheet-overlay" role="presentation" onClick={onClose}>
      <div
        className="vfx-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Generate a sprite sheet"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vfx-sheet__header">
          <h3 className="font-headline">Generate a sprite sheet</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="vfx-sheet__body">
          <p className="vfx-sheet__teach">
            Each cell is one frame of the simulation, rendered from where the preview
            camera is standing now. <strong>Frame the effect at its widest moment first</strong> —
            the camera does not move between cells, so anything that grows past the edge
            is cropped.
          </p>

          <div className="vfx-sheet__row">
            <label>
              <span>Start frame</span>
              {number(startFrame, setStartFrame, 0, 100000)}
              <em>{seconds(startFrame)}</em>
            </label>
            <label>
              <span>End frame</span>
              {number(endFrame, setEndFrame, 1, 100000)}
              <em>{seconds(endFrame)}</em>
            </label>
          </div>

          <div className="vfx-sheet__row">
            <label>
              <span>Columns</span>
              {number(columns, setColumns, 1, 32)}
            </label>
            <label>
              <span>Rows</span>
              {number(rows, setRows, 1, 32)}
            </label>
            <label>
              <span>Cell size</span>
              <select
                value={cell}
                disabled={busy}
                onChange={(event) => setCell(Number(event.target.value))}
              >
                {CELL_SIZES.map((size) => (
                  <option key={size} value={size}>{size} px</option>
                ))}
              </select>
            </label>
          </div>

          <div className="vfx-sheet__row">
            <label className="is-check">
              <input
                type="checkbox"
                checked={transparent}
                disabled={busy}
                onChange={(event) => setTransparent(event.target.checked)}
              />
              <span>Transparent background</span>
            </label>
            <label className="is-check">
              <input
                type="checkbox"
                checked={toneMapped}
                disabled={busy}
                onChange={(event) => setToneMapped(event.target.checked)}
              />
              <span>Tone mapping</span>
            </label>
          </div>

          <p className="vfx-sheet__hint">
            Turn <strong>Transparent</strong> off to bake a black background instead — additive
            flipbooks want that, because black adds nothing and needs no alpha channel.
            Turn <strong>Tone mapping</strong> off for the authored colour rather than what the
            preview shows: an engine that tone maps its own frame would otherwise do it
            twice and wash the effect out.
          </p>

          {/* Everything derivable, derived. See the header. */}
          <dl className="vfx-sheet__summary">
            <div>
              <dt>Cells</dt>
              <dd>{plan.count}</dd>
            </div>
            <div>
              <dt>Every</dt>
              <dd>
                {plan.stepFrames < 1
                  ? 'frame'
                  : `${plan.stepFrames.toFixed(1)} frames`}
                {' '}
                <em>({(plan.stepFrames * fixedDt).toFixed(3)}s)</em>
              </dd>
            </div>
            <div>
              <dt>Sheet</dt>
              <dd className={plan.tooLarge ? 'is-bad' : ''}>
                {plan.width} × {plan.height}
              </dd>
            </div>
            <div>
              <dt>Plays in</dt>
              <dd>{seconds(plan.endFrame - plan.startFrame)}</dd>
            </div>
          </dl>

          {plan.tooLarge && (
            <div className="vfx-sheet__message is-error">
              That is larger than {MAX_SHEET_PIXELS} px on a side. Use a smaller cell size,
              or fewer cells.
            </div>
          )}

          {plan.duplicates > 0 && (
            <div className="vfx-sheet__message is-warn">
              {plan.duplicates} cell{plan.duplicates === 1 ? '' : 's'} would repeat a frame —
              the range is only {plan.endFrame - plan.startFrame} frames long but the grid has
              {' '}{plan.count} cells. Widen the range or use a smaller grid.
            </div>
          )}

          {doc.effect.loop !== false && (
            <p className="vfx-sheet__hint">
              This effect loops, so the last cell stops one step short of the end frame —
              cell {plan.count} flows back into cell 1 without a stutter.
            </p>
          )}

          {progress && <div className="vfx-sheet__message">{progress}</div>}
        </div>

        <div className="vfx-sheet__actions">
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
          <button
            type="button"
            className="is-primary"
            onClick={bake}
            disabled={busy || plan.tooLarge}
          >
            {busy ? 'Rendering…' : `Generate ${plan.columns}×${plan.rows} PNG`}
          </button>
        </div>
      </div>
    </div>
  )
}
