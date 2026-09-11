// The point-list editor for a curve emitter's path.
//
// A PATH IS NOT A PROPERTY, so it does not go through VfxPropertyField: a
// property is a fixed-width binding with modes, a curve editor and an operator
// socket, and none of that applies to a list whose length the author changes.
// See the `points` note in vfx/catalog.js.
//
// The whole list is committed on every change rather than an add/remove/move
// API, which is what keeps this component simple and the document always in a
// shape normalizeVfxDoc would produce anyway. Edits coalesce into one undo
// entry per drag on a number, the same as any other field.
import './VfxPathField.css'

const AXES = ['X', 'Y', 'Z']

/**
 * @param {Object} props
 * @param {Object} props.def the catalog's `points` descriptor: label, min, max, hint
 * @param {number[][]} props.points
 * @param {(points: number[][]) => void} props.onChange
 */
export default function VfxPathField({ def, points, onChange }) {
  const min = def.min ?? 2
  const max = def.max ?? 24
  const path = Array.isArray(points) && points.length >= min
    ? points
    : [[0, 0, 0], [1, 0, 0]]

  const setAxis = (index, axis, raw) => {
    const value = Number(raw)
    const next = path.map((point, i) => (
      i === index
        ? point.map((component, a) => (a === axis ? (Number.isFinite(value) ? value : 0) : component))
        : [...point]
    ))
    onChange(next)
  }

  const addAfter = (index) => {
    if (path.length >= max) return
    const here = path[index]
    const there = path[index + 1]
    // A NEW POINT LANDS BETWEEN ITS NEIGHBOURS, not at the origin: adding a
    // point to refine a curve should not change the curve's shape, and a point
    // dropped at (0,0,0) yanks the path across the scene.
    const inserted = there
      ? here.map((component, a) => (component + there[a]) / 2)
      : here.map((component, a) => component + (a === 0 ? 0.5 : 0))
    const next = [...path.slice(0, index + 1), inserted, ...path.slice(index + 1)]
    onChange(next)
  }

  const remove = (index) => {
    if (path.length <= min) return
    onChange(path.filter((_, i) => i !== index))
  }

  const move = (index, delta) => {
    const target = index + delta
    if (target < 0 || target >= path.length) return
    const next = [...path]
    const [held] = next.splice(index, 1)
    next.splice(target, 0, held)
    onChange(next)
  }

  return (
    <div className="vfx-path">
      <div className="vfx-path__head">
        <span className="vfx-path__label">{def.label || 'Path'}</span>
        <span className="vfx-path__count">
          {path.length} point{path.length === 1 ? '' : 's'}
          {path.length >= max && ' (max)'}
        </span>
      </div>

      {def.hint && <p className="vfx-path__hint">{def.hint}</p>}

      <ol className="vfx-path__list">
        {path.map((point, index) => (
          // The index IS the identity here: points carry no id, and every
          // reorder rewrites the whole array anyway.
          <li className="vfx-path__row" key={index}>
            <span className="vfx-path__index">{index + 1}</span>
            {point.map((component, axis) => (
              <label className="vfx-path__axis" key={AXES[axis]}>
                <span>{AXES[axis]}</span>
                <input
                  type="number"
                  step="0.05"
                  value={component}
                  onChange={(event) => setAxis(index, axis, event.target.value)}
                />
              </label>
            ))}
            <span className="vfx-path__actions">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                title="Move earlier along the path"
                aria-label={`Move point ${index + 1} earlier`}
              >
                <span className="material-symbols-outlined">arrow_upward</span>
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === path.length - 1}
                title="Move later along the path"
                aria-label={`Move point ${index + 1} later`}
              >
                <span className="material-symbols-outlined">arrow_downward</span>
              </button>
              <button
                type="button"
                onClick={() => addAfter(index)}
                disabled={path.length >= max}
                title="Add a point after this one, halfway to the next"
                aria-label={`Add a point after ${index + 1}`}
              >
                <span className="material-symbols-outlined">add</span>
              </button>
              <button
                type="button"
                onClick={() => remove(index)}
                disabled={path.length <= min}
                title={path.length <= min ? `A path needs at least ${min} points` : 'Remove this point'}
                aria-label={`Remove point ${index + 1}`}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
