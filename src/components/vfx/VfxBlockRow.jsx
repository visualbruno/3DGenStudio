// One block in a context node's stack.
//
// COLLAPSED IS THE DEFAULT AND IT IS THE IMPORTANT STATE. A five-block context
// has to read as a list at a glance, so the row shows the block's name and a
// VALUE DIGEST - "9.8 m/s² down", "0.2 to 0.6 s, per particle" - rather than
// its controls. describeValue in vfx/value.js writes those digests in plain
// language for exactly this spot: the author can read what an effect does
// without opening anything.
//
// A DISABLED BLOCK SAYS THE WORD "Off". Not just dimmed: opacity is unreadable
// at 0.5 zoom, invisible to a colour-blind reader, and indistinguishable from
// the node being unfocused. The word costs 24 pixels and removes the ambiguity.
//
// THE SOCKET MODEL IS THREE-TIERED and this component owns the middle and inner
// tiers. One `block` handle per row is the drop target for a wire; a `prop`
// handle exists ONLY while an edge targets that property. That is what keeps a
// realistic effect at ~36 handles instead of ~110, and React Flow measures
// every handle on every node change, so the difference is real.
//
// The invariant that makes the lazy tier safe: A PROPERTY HANDLE STAYS MOUNTED
// FOR ITS EDGE'S WHOLE LIFETIME. React Flow keeps an edge in state when its
// targetHandle is missing but cannot draw it, and logs. So collapsing a block
// must REPOSITION its wired handles, never unmount them - hence `wiredProps`
// is rendered in both states, in the row header when collapsed.

import { Handle, Position } from '@xyflow/react'
import { ENGINE_SUPPORT } from '../../../vfx/catalog.js'
import { describeValue } from '../../../vfx/value.js'
import VfxPropertyField from './VfxPropertyField'

const SUPPORT_META = {
  [ENGINE_SUPPORT.APPROX]: { tone: 'warn', text: 'imports as an approximation' },
  [ENGINE_SUPPORT.NONE]: { tone: 'bad', text: 'has no equivalent and will be dropped' },
}

/** The engine chips. Native support is silent - only a compromise is worth ink. */
function EngineBadges({ def, engineTarget }) {
  const engines = engineTarget ? [engineTarget] : ['unity', 'unreal']
  const chips = engines
    .map(engine => ({ engine, meta: SUPPORT_META[def?.engines?.[engine]] }))
    .filter(entry => entry.meta)
  if (chips.length === 0) return null
  return (
    <span className="vfx-block__engines">
      {chips.map(({ engine, meta }) => (
        <span
          key={engine}
          className={`vfx-block__engine is-${meta.tone}`}
          title={`${engine === 'unity' ? 'Unity' : 'Unreal'} ${meta.text}.${def?.engines?.note ? `\n\n${def.engines.note}` : ''}`}
        >
          {engine === 'unity' ? 'U' : 'UE'}
        </span>
      ))}
    </span>
  )
}

/**
 * @param {Object} props
 * @param {Object} props.block document block
 * @param {Object} props.def catalog definition (null for an unknown type)
 * @param {number} props.index
 * @param {Array<Object>} props.diagnostics diagnostics targeting this block
 * @param {Array<{blockId: string, prop: string}>} props.wiredProps
 * @param {boolean} props.selected
 * @param {boolean} props.expanded
 * @param {boolean} props.showBadges zoom is high enough for chips
 * @param {string|null} props.engineTarget
 * @param {Object} props.actions see VfxContextNode
 * @param {(event: PointerEvent) => void} props.onGripDown
 * @param {Object} props.fieldProps forwarded to VfxPropertyField (asset labels etc.)
 */
export default function VfxBlockRow({
  block,
  def,
  index,
  diagnostics = [],
  wiredProps = [],
  selected = false,
  expanded = false,
  showBadges = true,
  engineTarget = null,
  actions,
  onGripDown,
  fieldProps = {},
}) {
  const disabled = block.enabled === false
  const worst = diagnostics.some(d => d.severity === 'error')
    ? 'error'
    : diagnostics.some(d => d.severity === 'warn') ? 'warn' : null

  // The digest: the first "hot" property, which the catalog marks as the one
  // that says what the block is doing. Blocks with no properties (an event
  // trigger, say) fall back to their blurb.
  const hotEntries = Object.entries(def?.props || {}).filter(([, prop]) => prop.hot)
  const digestEntry = hotEntries[0]
  const digest = digestEntry
    ? describeValue(block.props?.[digestEntry[0]], { unit: digestEntry[1].unit })
    : def?.blurb || ''

  const wiredHere = wiredProps.filter(entry => entry.blockId === block.id)

  return (
    <li
      className={[
        'vfx-block',
        selected ? 'is-selected' : '',
        disabled ? 'is-off' : '',
        worst ? `has-${worst}` : '',
        def ? '' : 'is-unknown',
      ].filter(Boolean).join(' ')}
      data-block-id={block.id}
    >
      {/* One handle per block: the drop target. Dropping a wire here opens a
          chooser of the block's compatible properties rather than guessing,
          which is what makes wiring impossible to get wrong. */}
      <Handle
        type="target"
        position={Position.Left}
        id={`block:${block.id}`}
        className="vfx-block__socket"
        isConnectableStart={false}
      />

      <div className="vfx-block__head">
        <span
          className="vfx-block__grip nodrag"
          onPointerDown={event => onGripDown?.(event, block.id, index)}
          title="Drag to reorder. Order matters: blocks run top to bottom."
          aria-hidden="true"
        >
          <span className="material-symbols-outlined">drag_indicator</span>
        </span>

        {/* ALT + UP/DOWN REORDERS FROM THE KEYBOARD.
            Block order is semantic - blocks WRITE attributes in sequence, so
            moving one changes what the effect does - and until this it could
            only be changed by a pointer drag. That is not a convenience gap, it
            is the feature being unreachable without a mouse.

            On the title button because that is the row's focusable element, and
            Alt because the bare arrows belong to the browser's own navigation. */}
        <button
          type="button"
          className="vfx-block__title nodrag"
          onClick={() => actions.select(block.id)}
          onKeyDown={event => {
            if (!event.altKey) return
            const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
            if (!delta) return
            event.preventDefault()
            // Selected as well as moved, so the Parameters panel follows the
            // block rather than the author losing track of what they just moved.
            actions.select(block.id)
            actions.moveBlock(block.id, index + delta)
          }}
          title={def ? `${def.blurb}\n\n${def.teach}` : `Unknown block type "${block.type}"`}
        >
          <span className="vfx-block__name">{def?.label || block.type}</span>
          <span className="vfx-block__digest">{digest}</span>
        </button>

        {disabled && <span className="vfx-block__off">Off</span>}

        {worst && (
          <span
            className={`vfx-block__flag is-${worst}`}
            title={diagnostics.map(d => `${d.title}: ${d.message}`).join('\n')}
          >
            <span className="material-symbols-outlined">
              {worst === 'error' ? 'error' : 'warning'}
            </span>
          </span>
        )}

        {showBadges && <EngineBadges def={def} engineTarget={engineTarget} />}

        <span className="vfx-block__tools">
          {hotEntries.length > 0 && (
            <button
              type="button"
              className="vfx-block__tool nodrag"
              onClick={() => actions.toggleExpanded(block.id)}
              title={expanded ? 'Collapse' : 'Show the main settings here'}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse block' : 'Expand block'}
            >
              <span className="material-symbols-outlined">
                {expanded ? 'expand_less' : 'expand_more'}
              </span>
            </button>
          )}
          <button
            type="button"
            className="vfx-block__tool nodrag"
            onClick={() => actions.toggleEnabled(block.id)}
            title={disabled ? 'Turn back on' : 'Turn off, keeping the settings'}
            aria-label={disabled ? 'Enable block' : 'Disable block'}
          >
            <span className="material-symbols-outlined">
              {disabled ? 'toggle_off' : 'toggle_on'}
            </span>
          </button>
          <button
            type="button"
            className="vfx-block__tool nodrag"
            onClick={() => actions.duplicate(block.id)}
            title="Duplicate"
            aria-label="Duplicate block"
          >
            <span className="material-symbols-outlined">content_copy</span>
          </button>
          <button
            type="button"
            className="vfx-block__tool is-danger nodrag"
            onClick={() => actions.remove(block.id)}
            title="Delete"
            aria-label="Delete block"
          >
            <span className="material-symbols-outlined">delete</span>
          </button>
        </span>
      </div>

      {/* Wired property handles. Rendered in BOTH states - see the header: a
          handle that unmounts while its edge lives leaves React Flow unable to
          draw that edge. Collapsed, they gather behind a chip on the header
          row; expanded, they sit on their own property. */}
      {wiredHere.length > 0 && !expanded && (
        <span className="vfx-block__wired-chip" title="Properties driven by nodes on the board">
          <span className="material-symbols-outlined">cable</span>
          {wiredHere.length}
          {wiredHere.map(entry => (
            <Handle
              key={entry.prop}
              type="target"
              position={Position.Left}
              id={`prop:${entry.blockId}:${entry.prop}`}
              className="vfx-block__socket is-prop is-stacked"
              isConnectableStart={false}
            />
          ))}
        </span>
      )}

      {expanded && (
        <div className="vfx-block__body nowheel">
          {/* Handles for wired properties that are NOT shown inline. Without
              these, expanding a block whose wired property is not one of its
              hot ones would unmount that handle while its edge was still alive
              - the exact failure the invariant in this file's header forbids.
              They are stacked at the top of the body rather than hidden, so the
              wire still visibly lands on the block. */}
          {wiredHere
            .filter(entry => !hotEntries.some(([name]) => name === entry.prop))
            .map(entry => (
              <Handle
                key={entry.prop}
                type="target"
                position={Position.Left}
                id={`prop:${entry.blockId}:${entry.prop}`}
                className="vfx-block__socket is-prop is-stacked"
                isConnectableStart={false}
              />
            ))}
          {hotEntries.map(([name, propDef]) => {
            const wired = wiredHere.some(entry => entry.prop === name)
            return (
              <div className="vfx-block__prop" key={name}>
                {wired && (
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={`prop:${block.id}:${name}`}
                    className="vfx-block__socket is-prop"
                    isConnectableStart={false}
                  />
                )}
                <VfxPropertyField
                  compact
                  name={name}
                  def={propDef}
                  value={block.props?.[name]}
                  onValue={(next, meta) => actions.setProp(block.id, name, next, meta)}
                  onMode={mode => actions.setMode(block.id, name, mode)}
                  onCurvePreset={id => actions.setCurvePreset(block.id, name, id)}
                  onGradientPreset={id => actions.setGradientPreset(block.id, name, id)}
                  onPickAsset={() => actions.pickAsset(block.id, name, propDef.type)}
                  onClearAsset={() => actions.setProp(block.id, name, '', {})}
                  {...(fieldProps[name] || {})}
                />
              </div>
            )
          })}
        </div>
      )}
    </li>
  )
}
