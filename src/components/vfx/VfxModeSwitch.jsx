// The segmented control that picks a property's value mode.
//
// Only the modes the catalog declares for that property are offered, which is
// the point: a spawn rate may be a curve over effect time but must never be a
// curve over particle life, and a texture slot has no numeric modes at all.
// Filtering here rather than disabling means the author never sees a control
// they cannot use.
//
// SWITCHING IS ADVERTISED AS NON-DESTRUCTIVE, because it is. setValueMode
// stashes the outgoing payload, so curve -> const -> curve returns the original
// curve. That is worth saying out loud on the control: the biggest reason
// people avoid a mode switcher is the fear that flipping it throws away work,
// and a one-line reassurance is cheaper than any amount of undo.
//
// 'link' IS NOT SELECTABLE HERE. A property becomes wired by dropping an edge
// on it on the board - never by picking "wired" from a menu, which would leave
// a property claiming a source it does not have. So when the mode IS link the
// control collapses to a read-only chip naming the source, with an Unwire
// button, and the numeric modes come back the moment the edge is gone.

import { VALUE_MODE } from '../../../vfx/value.js'
import './VfxModeSwitch.css'

// Plain-language labels. Not "Constant"/"Curve over life" - the audience has
// not learned this vocabulary, and "Fixed" versus "Over life" says what the
// number will actually do.
const MODE_META = {
  [VALUE_MODE.CONST]: {
    label: 'Fixed',
    icon: 'tag',
    hint: 'One number, the same for every particle.',
  },
  [VALUE_MODE.RANDOM]: {
    label: 'Random',
    icon: 'shuffle',
    hint: 'A different number for each particle, between two bounds. Variety is what stops an effect looking mechanical.',
  },
  [VALUE_MODE.CURVE]: {
    label: 'Over life',
    icon: 'show_chart',
    hint: 'Changes as the particle ages, from birth (left) to death (right).',
  },
  [VALUE_MODE.GRADIENT]: {
    label: 'Over life',
    icon: 'gradient',
    hint: 'Colour changes as the particle ages, from birth (left) to death (right).',
  },
  [VALUE_MODE.EXPOSED]: {
    label: 'Runtime',
    icon: 'code',
    hint: 'Left for game code to set. Becomes a Unity exposed property or a Niagara User Parameter.',
  },
}

/**
 * @param {Object} props
 * @param {Object} props.value the VfxValue
 * @param {string[]} props.modes modes the property declares
 * @param {(mode: string) => void} props.onChange
 * @param {() => void} [props.onUnwire]
 * @param {string} [props.sourceLabel] name of the wired source
 * @param {boolean} [props.disabled]
 */
export default function VfxModeSwitch({
  value,
  modes = [],
  onChange,
  onUnwire = null,
  sourceLabel = '',
  disabled = false,
}) {
  const mode = value?.mode || VALUE_MODE.CONST

  if (mode === VALUE_MODE.LINK) {
    return (
      <div className="vfx-modes is-wired">
        <span className="vfx-modes__wired" title="This property is driven by a node on the board.">
          <span className="material-symbols-outlined">cable</span>
          {sourceLabel || value?.nodeId || 'a node'}
        </span>
        {onUnwire && (
          <button
            type="button"
            className="vfx-modes__unwire"
            onClick={onUnwire}
            title="Disconnect, keeping the last value it produced"
          >
            Unwire
          </button>
        )}
      </div>
    )
  }

  // A property with one mode has nothing to switch, so showing a one-button
  // segmented control would be pure noise.
  const offered = modes.filter(entry => MODE_META[entry])
  if (offered.length < 2) return null

  return (
    <div className="vfx-modes" role="group" aria-label="Value mode">
      {offered.map(entry => {
        const meta = MODE_META[entry]
        const active = entry === mode
        return (
          <button
            key={entry}
            type="button"
            className={`vfx-modes__btn${active ? ' is-active' : ''}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => { if (!active) onChange?.(entry) }}
            // The "kept" half of the tooltip is the reassurance described in
            // the header. modeSwitchLosesWork is true exactly when there is
            // work at stake in the switch, which is when saying so helps.
            title={active
              ? meta.hint
              : `${meta.hint}\n\nSwitching keeps your current setting - switch back to restore it.`}
          >
            <span className="material-symbols-outlined">{meta.icon}</span>
            {meta.label}
          </button>
        )
      })}
    </div>
  )
}
