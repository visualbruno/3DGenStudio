// ONE property editor, used in two places.
//
// The Parameters panel and the inline "hot" row on a block both render this
// component. That is deliberate and it is the fix for a pattern already in the
// codebase: GraphPage's per-mode forms are duplicated between
// GraphAssetNode.jsx:141 and GraphValueNode.jsx:65, so a fix to one silently
// leaves the other wrong. Here there is one implementation, and `compact`
// chooses how much of it is shown.
//
// IT IS GENERIC OVER THE CATALOG, not over a list of known property names.
// Type, range, step, unit, hint, presets, which modes are offered and whether
// the property is "basic" all come from the VfxPropDef. Adding a block to
// vfx/catalog.js therefore adds a fully-formed editor for every one of its
// properties with no React change - which is the promise the catalog header
// makes and this is where it is kept.
//
// CURVES AND GRADIENTS SHOW A PRESET MENU FIRST AND A FULL EDITOR ON REQUEST.
// The preset list is not a lesser version of the editor: for the intended
// reader - a developer who has never authored an effect - "Spike: bright
// instantly, then fades; this is a muzzle flash" is a better first control than
// a blank canvas, and it is what most rows will ever need. The Edit button
// opens VfxCurveEditor or VfxGradientEditor underneath the row for the cases
// where a preset is only the starting point.
//
// THE EDITORS OPEN HERE AND NOWHERE ELSE. They are canvas widgets with pointer
// capture, so putting one inside a node would mean every coordinate needed
// React Flow's zoom division and every drag competed with the pane. `compact`
// - the in-node variant - never renders them.
//
// COLOUR IS STORED LINEAR AND EDITED IN sRGB. The swatch converts both ways,
// because <input type="color"> speaks hex sRGB and the simulation needs linear
// (the house rule, and vfx/gradient.js documents why interpolation must happen
// in linear space). Intensity is a separate multiplier rather than being folded
// into the components, so a value above 1 survives a trip through the picker
// instead of being clamped to white - HDR is what makes an additive core blow
// out through the tonemapper.

import { useMemo } from 'react'
import { PROP_TYPE } from '../../../vfx/catalog.js'
import { VALUE_MODE, RANDOM_FREQ, describeValue, readValue } from '../../../vfx/value.js'
import { CURVE_PRESETS, evalCurve } from '../../../vfx/curve.js'
import {
  GRADIENT_PRESETS, evalGradient, hexToSrgb, linearToSrgb, srgbToHex, srgbToLinear,
} from '../../../vfx/gradient.js'
import VfxModeSwitch from './VfxModeSwitch'
import VfxDragNumber from './VfxDragNumber'
import VfxCurveEditor from './VfxCurveEditor'
import VfxGradientEditor from './VfxGradientEditor'
import './VfxPropertyField.css'

const VEC_LABELS = ['X', 'Y', 'Z']
const SPARK_SAMPLES = 28
const BAR_STOPS = 24

const FREQ_LABEL = {
  [RANDOM_FREQ.PER_PARTICLE]: 'per particle',
  [RANDOM_FREQ.PER_FRAME]: 'every frame',
  [RANDOM_FREQ.PER_SPAWN_EVENT]: 'per burst',
}

/** An SVG path through the curve, drawn in a 0..1 box and flipped for screen Y. */
function sparklinePath(curve) {
  if (!curve) return ''
  let lo = Infinity
  let hi = -Infinity
  const samples = new Array(SPARK_SAMPLES)
  for (let i = 0; i < SPARK_SAMPLES; i += 1) {
    const v = evalCurve(curve, i / (SPARK_SAMPLES - 1))
    samples[i] = v
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  // Normalised to the curve's OWN extent, not to 0..1: a curve from 4 to 6
  // would otherwise draw as a flat line at the top of the box and read as
  // "constant", which is the opposite of what it does.
  const span = hi - lo > 1e-6 ? hi - lo : 1
  return samples
    .map((v, i) => {
      const x = (i / (SPARK_SAMPLES - 1)) * 100
      const y = 100 - ((v - lo) / span) * 100
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/**
 * A CSS gradient sampled from evalGradient.
 *
 * Every stop is a real evaluation of the authored gradient, so CSS is only
 * interpolating across 1/23rd of the bar between two correct samples. That is
 * the compromise the plan's "never a CSS linear-gradient" rule is aimed at -
 * it forbids handing CSS the AUTHORED stops, which would interpolate in the
 * wrong space and over the wrong spans. The full editor's preview bar in phase
 * 7 is a per-pixel canvas.
 *
 * Values above 1 are clamped for display only; the "HDR" chip beside the bar is
 * what tells the author their gradient exceeds white.
 */
function gradientCss(gradient) {
  if (!gradient) return 'none'
  const rgba = new Float64Array(4)
  const stops = []
  for (let i = 0; i < BAR_STOPS; i += 1) {
    const t = i / (BAR_STOPS - 1)
    evalGradient(gradient, t, rgba)
    const r = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgba[0]))) * 255)
    const g = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgba[1]))) * 255)
    const b = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgba[2]))) * 255)
    const a = Math.min(1, Math.max(0, rgba[3])).toFixed(3)
    stops.push(`rgba(${r},${g},${b},${a}) ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}

function gradientIsHdr(gradient) {
  return (gradient?.colorKeys || []).some(key => (key.intensity ?? 1) > 1.001)
}

// Which preset a curve or gradient currently IS, matched by CONTENT rather than
// by an id stored on the value.
//
// Storing the id would be less work here and wrong later: phase 7 makes keys
// draggable, and a value that still claims to be "Spike" after the author moved
// a key would have the menu lying about the shape on screen. Content matching
// costs a handful of comparisons against nine curves, is always truthful, and
// degrades to "Custom" exactly when the shape stopped being a preset.
//
// Built once at module scope - a preset's build() allocates, and doing it per
// render for every property row on the page is pure waste.
const BUILT_CURVE_PRESETS = CURVE_PRESETS.map(preset => ({ ...preset, curve: preset.build() }))
const BUILT_GRADIENT_PRESETS = GRADIENT_PRESETS.map(preset => ({
  ...preset,
  gradient: preset.build(),
}))

const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-4

function curveMatches(a, b) {
  if (!a?.keys || !b?.keys || a.keys.length !== b.keys.length) return false
  return a.keys.every((key, i) => {
    const other = b.keys[i]
    return near(key.t, other.t)
      && near(key.v, other.v)
      && near(key.inTangent, other.inTangent)
      && near(key.outTangent, other.outTangent)
      && key.interp === other.interp
  })
}

function gradientMatches(a, b) {
  if (!a || !b) return false
  if (a.colorKeys.length !== b.colorKeys.length) return false
  if (a.alphaKeys.length !== b.alphaKeys.length) return false
  const colorsMatch = a.colorKeys.every((key, i) => {
    const other = b.colorKeys[i]
    return near(key.t, other.t)
      && String(key.hex).toLowerCase() === String(other.hex).toLowerCase()
      && near(key.intensity ?? 1, other.intensity ?? 1)
  })
  if (!colorsMatch) return false
  return a.alphaKeys.every((key, i) => near(key.t, b.alphaKeys[i].t) && near(key.a, b.alphaKeys[i].a))
}

function matchCurvePreset(curve) {
  return BUILT_CURVE_PRESETS.find(preset => curveMatches(curve, preset.curve)) || null
}

function matchGradientPreset(gradient) {
  return BUILT_GRADIENT_PRESETS.find(preset => gradientMatches(gradient, preset.gradient)) || null
}

/**
 * @param {Object} props
 * @param {string} props.name property key
 * @param {Object} props.def VfxPropDef from the catalog
 * @param {Object} props.value VfxValue
 * @param {(next: *, meta?: Object) => void} props.onValue live change; meta carries the coalesce key
 * @param {(next: *) => void} [props.onCommitValue] end of a drag
 * @param {(mode: string) => void} props.onMode
 * @param {(presetId: string) => void} [props.onCurvePreset]
 * @param {(presetId: string) => void} [props.onGradientPreset]
 * @param {() => void} [props.onPickAsset]
 * @param {() => void} [props.onClearAsset]
 * @param {() => void} [props.onUnwire]
 * @param {string} [props.assetLabel] resolved name of the referenced asset
 * @param {string} [props.sourceLabel] label of a wired source
 * @param {boolean} [props.compact] inline on a block row: no hint, no presets
 * @param {boolean} [props.modified] value differs from the catalog default
 * @param {boolean} [props.editorOpen] whether the full curve/gradient editor
 *   is expanded under this row
 * @param {() => void} [props.onToggleEditor]
 * @param {() => Object} [props.getPlayhead] read per frame by the curve
 *   editor's overlay: `{t, ages}` from the running simulation
 */
export default function VfxPropertyField({
  name,
  def,
  value,
  onValue,
  onCommitValue = null,
  onMode,
  onCurvePreset = null,
  onGradientPreset = null,
  onPickAsset = null,
  onClearAsset = null,
  onUnwire = null,
  assetLabel = '',
  sourceLabel = '',
  compact = false,
  modified = false,
  editorOpen = false,
  onToggleEditor = null,
  getPlayhead = null,
}) {
  const mode = value?.mode || VALUE_MODE.CONST
  const type = def?.type || PROP_TYPE.FLOAT
  const isInt = type === PROP_TYPE.INT

  const summary = useMemo(
    () => describeValue(value, { unit: def?.unit, sourceLabel }),
    [def?.unit, sourceLabel, value],
  )

  // A drag emits many changes and one commit. The coalesce key merges the
  // drag's changes into a single undo entry - see useVfxHistory's header.
  const live = (next, key) => onValue?.(next, { coalesceKey: key || `prop:${name}` })
  const commit = next => (onCommitValue || onValue)?.(next, {})

  /** Editor for one literal, used for `const` and for both ends of a range. */
  const literalEditor = (literal, apply, keySuffix = '') => {
    if (type === PROP_TYPE.BOOL) {
      return (
        <label className="vfx-prop__bool">
          <input
            type="checkbox"
            checked={Boolean(literal)}
            onChange={event => commit(event.target.checked)}
          />
          {literal ? 'On' : 'Off'}
        </label>
      )
    }

    if (type === PROP_TYPE.VEC3) {
      const vec = Array.isArray(literal) ? literal : [literal, literal, literal]
      return (
        <div className="vfx-prop__vec">
          {VEC_LABELS.map((axis, index) => (
            <div className="vfx-prop__axis" key={axis}>
              <span className="vfx-prop__axis-label">{axis}</span>
              <VfxDragNumber
                value={Number(vec[index]) || 0}
                min={def?.min}
                max={def?.max}
                step={def?.step}
                label={`${def?.label || name} ${axis}`}
                onChange={next => {
                  const out = [Number(vec[0]) || 0, Number(vec[1]) || 0, Number(vec[2]) || 0]
                  out[index] = next
                  live(apply(out), `prop:${name}:${index}${keySuffix}`)
                }}
                onCommit={next => {
                  const out = [Number(vec[0]) || 0, Number(vec[1]) || 0, Number(vec[2]) || 0]
                  out[index] = next
                  commit(apply(out))
                }}
              />
            </div>
          ))}
        </div>
      )
    }

    if (type === PROP_TYPE.COLOR) {
      const rgba = Array.isArray(literal) ? literal : [1, 1, 1, 1]
      // The picker gets the colour normalised to its brightest channel, with
      // the overflow held in `intensity`. Without that split, a [3, 2.4, 1]
      // fire colour would come back from the picker as white.
      const peak = Math.max(rgba[0] || 0, rgba[1] || 0, rgba[2] || 0, 1e-6)
      const intensity = peak > 1 ? peak : 1
      const hex = srgbToHex(
        linearToSrgb((rgba[0] || 0) / intensity),
        linearToSrgb((rgba[1] || 0) / intensity),
        linearToSrgb((rgba[2] || 0) / intensity),
      )
      const write = (nextHex, nextIntensity, nextAlpha) => {
        const srgb = hexToSrgb(nextHex)
        return apply([
          srgbToLinear(srgb[0]) * nextIntensity,
          srgbToLinear(srgb[1]) * nextIntensity,
          srgbToLinear(srgb[2]) * nextIntensity,
          nextAlpha,
        ])
      }
      return (
        <div className="vfx-prop__color">
          <input
            type="color"
            className="vfx-prop__swatch"
            value={hex}
            aria-label={`${def?.label || name} colour`}
            onChange={event => commit(write(event.target.value, intensity, rgba[3] ?? 1))}
          />
          <div className="vfx-prop__color-num" title="Opacity">
            <span className="vfx-prop__axis-label">A</span>
            <VfxDragNumber
              value={rgba[3] ?? 1}
              min={0}
              max={1}
              step={0.01}
              label={`${def?.label || name} opacity`}
              onChange={next => live(write(hex, intensity, next), `prop:${name}:a${keySuffix}`)}
              onCommit={next => commit(write(hex, intensity, next))}
            />
          </div>
          <div
            className="vfx-prop__color-num"
            title="Brightness. Above 1 is HDR: it blows out through the tonemapper, which is what makes a glowing core read as hot."
          >
            <span className="vfx-prop__axis-label">x</span>
            <VfxDragNumber
              value={intensity}
              min={0}
              max={16}
              step={0.1}
              label={`${def?.label || name} brightness`}
              onChange={next => live(write(hex, next, rgba[3] ?? 1), `prop:${name}:i${keySuffix}`)}
              onCommit={next => commit(write(hex, next, rgba[3] ?? 1))}
            />
          </div>
        </div>
      )
    }

    if (type === PROP_TYPE.TEXTURE || type === PROP_TYPE.MESH) {
      const slot = typeof literal === 'string' ? literal : ''
      return (
        <div className="vfx-prop__asset">
          <button
            type="button"
            className={`vfx-prop__asset-pick${slot ? ' is-set' : ''}`}
            onClick={onPickAsset}
            title={slot ? `Slot "${slot}"` : 'Choose an asset from the library'}
          >
            <span className="material-symbols-outlined">
              {type === PROP_TYPE.MESH ? 'deployed_code' : 'image'}
            </span>
            <span className="vfx-prop__asset-name">
              {assetLabel || slot || 'Choose…'}
            </span>
          </button>
          {slot && onClearAsset && (
            <button
              type="button"
              className="vfx-prop__asset-clear"
              onClick={onClearAsset}
              title="Clear, and draw plain quads"
              aria-label="Clear asset"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>
      )
    }

    return (
      <VfxDragNumber
        value={Number(Array.isArray(literal) ? literal[0] : literal) || 0}
        min={def?.min}
        max={def?.max}
        step={def?.step}
        integer={isInt}
        unit={def?.unit || ''}
        label={def?.label || name}
        onChange={next => live(apply(next), `prop:${name}${keySuffix}`)}
        onCommit={next => commit(apply(next))}
      />
    )
  }

  let editor = null

  if (mode === VALUE_MODE.LINK) {
    // Read-only: the value comes from the board. Showing the last literal is
    // still useful - it is what the property falls back to if the edge goes
    // away - so it is displayed, greyed.
    editor = (
      <div className="vfx-prop__wired-value">
        {summary}
      </div>
    )
  } else if (mode === VALUE_MODE.CONST) {
    editor = literalEditor(readValue(value), next => next)
  } else if (mode === VALUE_MODE.RANDOM) {
    editor = (
      <div className="vfx-prop__range">
        {literalEditor(value.a, next => ({ ...value, a: next }), ':a')}
        <span className="vfx-prop__range-to">to</span>
        {literalEditor(value.b, next => ({ ...value, b: next }), ':b')}
        {!compact && (
          <select
            className="vfx-prop__freq"
            value={value.freq || RANDOM_FREQ.PER_PARTICLE}
            onChange={event => commit({ ...value, freq: event.target.value })}
            title="How often a new number is drawn. Per particle is almost always what you want."
            aria-label="Random frequency"
          >
            {Object.values(RANDOM_FREQ).map(freq => (
              <option key={freq} value={freq}>{FREQ_LABEL[freq] || freq}</option>
            ))}
          </select>
        )}
      </div>
    )
  } else if (mode === VALUE_MODE.CURVE) {
    const preset = matchCurvePreset(value.curve)
    editor = (
      <div className="vfx-prop__curve">
        <svg className="vfx-prop__spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d={sparklinePath(value.curve)} />
        </svg>
        <select
          className="vfx-prop__preset"
          value={preset?.id || ''}
          onChange={event => onCurvePreset?.(event.target.value)}
          title={preset?.hint || 'Pick a shape. Each one says what it is for.'}
          aria-label={`${def?.label || name} shape`}
        >
          {/* Only offered when the shape is not one of the presets, so the
              menu never invites the author to "select" Custom - which would
              have to do nothing. */}
          {!preset && <option value="">Custom shape</option>}
          {CURVE_PRESETS.map(entry => (
            <option key={entry.id} value={entry.id} title={entry.hint}>{entry.label}</option>
          ))}
        </select>
        {!compact && onToggleEditor && (
          <button
            type="button"
            className={`vfx-prop__edit${editorOpen ? ' is-open' : ''}`}
            onClick={onToggleEditor}
            title={editorOpen ? 'Close the curve editor' : 'Open the curve editor'}
            aria-expanded={editorOpen}
          >
            <span className="material-symbols-outlined">
              {editorOpen ? 'expand_less' : 'tune'}
            </span>
          </button>
        )}
        <div className="vfx-prop__scale" title="The curve runs 0 to 1; this is what it is multiplied by.">
          <span className="vfx-prop__axis-label">x</span>
          <VfxDragNumber
            value={Number.isFinite(value.scale) ? value.scale : 1}
            min={def?.min}
            max={def?.max}
            step={def?.step}
            label={`${def?.label || name} amount`}
            onChange={next => live({ ...value, scale: next }, `prop:${name}:scale`)}
            onCommit={next => commit({ ...value, scale: next })}
          />
        </div>
      </div>
    )
  } else if (mode === VALUE_MODE.GRADIENT) {
    const hdr = gradientIsHdr(value.gradient)
    const preset = matchGradientPreset(value.gradient)
    editor = (
      <div className="vfx-prop__gradient">
        {/* Two layers, because the inline backgroundImage would otherwise
            replace the checkerboard and an alpha ramp would read as a fade to
            the panel colour rather than as transparency. */}
        <div className="vfx-prop__bar-wrap" role="img" aria-label={summary}>
          <div
            className="vfx-prop__bar"
            style={{ backgroundImage: gradientCss(value.gradient) }}
          />
        </div>
        <select
          className="vfx-prop__preset"
          value={preset?.id || ''}
          onChange={event => onGradientPreset?.(event.target.value)}
          title={preset?.hint || 'Pick a ramp. Each one says what it is for.'}
          aria-label={`${def?.label || name} gradient`}
        >
          {!preset && <option value="">Custom ramp</option>}
          {GRADIENT_PRESETS.map(entry => (
            <option key={entry.id} value={entry.id} title={entry.hint}>{entry.label}</option>
          ))}
        </select>
        {!compact && onToggleEditor && (
          <button
            type="button"
            className={`vfx-prop__edit${editorOpen ? ' is-open' : ''}`}
            onClick={onToggleEditor}
            title={editorOpen ? 'Close the gradient editor' : 'Open the gradient editor'}
            aria-expanded={editorOpen}
          >
            <span className="material-symbols-outlined">
              {editorOpen ? 'expand_less' : 'tune'}
            </span>
          </button>
        )}
        {hdr && (
          <span
            className="vfx-prop__hdr"
            title="Brighter than white. Correct for additive effects - the tonemapper is what turns it into a glow."
          >
            HDR
          </span>
        )}
      </div>
    )
  } else if (mode === VALUE_MODE.EXPOSED) {
    editor = (
      <div className="vfx-prop__wired-value">
        {value.exposedId
          ? `Set at runtime as "${value.exposedId}"`
          : 'Not assigned to a runtime property yet'}
      </div>
    )
  }

  if (compact) {
    // The node row: label, editor, nothing else. Hints, presets and the mode
    // switch live in the panel, because a node has to stay readable at 0.5
    // zoom and a five-block context has to read as a list.
    return (
      <div className="vfx-prop is-compact nodrag">
        <span className="vfx-prop__label" title={def?.hint || ''}>{def?.label || name}</span>
        <div className="vfx-prop__editor">{editor}</div>
      </div>
    )
  }

  return (
    <div className="vfx-prop">
      <div className="vfx-prop__head">
        <span className="vfx-prop__label">
          {def?.label || name}
          {/* A value moved off its default by a template or by AI is flagged
              even when it is hidden behind Advanced. Hiding a setting that is
              actively doing something is how a beginner ends up mystified. */}
          {modified && <span className="vfx-prop__dot" title="Changed from the default" />}
        </span>
        <VfxModeSwitch
          value={value}
          modes={def?.modes || []}
          onChange={onMode}
          onUnwire={onUnwire}
          sourceLabel={sourceLabel}
        />
      </div>

      <div className="vfx-prop__editor">{editor}</div>

      {/* Presets are the highest-leverage affordance for someone who does not
          know what number belongs here: they turn a blank field into a menu of
          answers that name their own use case. */}
      {!compact && mode === VALUE_MODE.CONST && def?.presets?.length > 0 && (
        <div className="vfx-prop__presets">
          {def.presets.map(preset => (
            <button
              key={preset.label}
              type="button"
              className="vfx-prop__preset-btn"
              onClick={() => commit(preset.value)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {/* The full editors. Uncontrolled during a drag and controlled at the
          edges, so a drag is one undo entry: the live path carries a coalesce
          key, the commit path does not. */}
      {editorOpen && mode === VALUE_MODE.CURVE && (
        <VfxCurveEditor
          value={value.curve}
          unit={def?.unit || ''}
          scale={Number.isFinite(value.scale) ? value.scale : 1}
          domain={value.domain}
          label={def?.label || name}
          getPlayhead={getPlayhead}
          onChange={curve => live({ ...value, curve }, `prop:${name}:curve`)}
          onCommit={curve => commit({ ...value, curve })}
          onClose={onToggleEditor}
        />
      )}
      {editorOpen && mode === VALUE_MODE.GRADIENT && (
        <VfxGradientEditor
          value={value.gradient}
          label={def?.label || name}
          onChange={gradient => live({ ...value, gradient }, `prop:${name}:gradient`)}
          onCommit={gradient => commit({ ...value, gradient })}
          onClose={onToggleEditor}
        />
      )}

      {def?.hint && <p className="vfx-prop__hint">{def.hint}</p>}
      {mode !== VALUE_MODE.CONST && <p className="vfx-prop__summary">{summary}</p>}
    </div>
  )
}
