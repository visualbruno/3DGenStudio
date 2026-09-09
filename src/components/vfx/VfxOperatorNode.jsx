// An operator node: a value computed once and wired into block properties.
//
// ONE COMPONENT FOR EVERY OPERATOR TYPE. The catalog entry supplies the label,
// the blurb, the properties, the discrete modes and the output port, so four
// operator types are not four components and the fortieth will not be either.
// That is the same promise VfxPropertyField keeps for properties, one level up.
//
// OPERATORS ARE DELIBERATELY RARE, and the node says why. Curves, gradients and
// random ranges are property MODES, not nodes - the overwhelming majority of
// authoring involves no wiring at all, which is the single biggest ease-of-use
// decision in the feature. An operator earns its place only when a value has to
// be SHARED between properties or computed from something a mode cannot reach,
// so its blurb is phrased around that ("wire one Value into both and there is
// only one number to change") rather than around arithmetic.

import { Handle, Position } from '@xyflow/react'
import { useVfxBoard } from './VfxBoardContext'
import VfxPropertyField from './VfxPropertyField'
import './VfxOperatorNode.css'

// The catalog's `freq` is a string naming the operator's own rate; the IR's
// FREQ_LABEL is keyed by the compiler's numeric ladder and is not the same
// vocabulary, so it is deliberately not reused here.
const FREQ_TEXT = {
  const: 'fixed',
  inherit: 'follows its inputs',
  perFrame: 'per frame',
  perSpawn: 'per burst',
  perParticle: 'per particle',
}

export default function VfxOperatorNode({ id, data, selected }) {
  const { operator, def, diagnostics } = data
  const { actions } = useVfxBoard()

  if (!def) {
    // A document from a newer format, or a hand-edited one. Shown rather than
    // dropped: the compiler already reports it, and a node the author can see
    // and delete beats a value that vanished.
    return (
      <div className="vfx-op is-unknown">
        <div className="vfx-op__header vfx-node__drag-handle">
          <span className="vfx-op__label">Unknown: {operator.type}</span>
        </div>
      </div>
    )
  }

  const worst = diagnostics.some(d => d.severity === 'error')
    ? 'error'
    : diagnostics.some(d => d.severity === 'warn') ? 'warn' : null

  return (
    <div
      className={[
        'vfx-op',
        selected ? 'is-selected' : '',
        worst ? `has-${worst}` : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="vfx-op__header vfx-node__drag-handle">
        <span className="material-symbols-outlined vfx-op__icon">function</span>
        <span className="vfx-op__label" title={`${def.blurb}\n\n${def.teach}`}>
          {def.label}
        </span>
        {/* The frequency is the thing that decides whether this operator can
            legally feed a given property - a per-particle value cannot drive a
            spawn rate - so it is on the node rather than only in a diagnostic
            after the fact. */}
        <span className="vfx-op__freq" title="How often this value changes. It can only feed properties that change at least this often.">
          {FREQ_TEXT[def.freq] || def.freq}
        </span>
        <button
          type="button"
          className="vfx-op__tool is-danger nodrag"
          onClick={() => actions.removeOperator(id)}
          title="Delete, and unwire everything it feeds"
          aria-label="Delete operator"
        >
          <span className="material-symbols-outlined">delete</span>
        </button>
      </div>

      <div className="vfx-op__body nodrag">
        {Object.entries(def.modes || {}).map(([mode, modeDef]) => (
          <label className="vfx-op__mode" key={mode} title={modeDef.hint || ''}>
            <span>{modeDef.label}</span>
            <select
              value={operator.modes?.[mode] ?? modeDef.default}
              onChange={event => actions.setOperatorMode(id, mode, event.target.value)}
            >
              {modeDef.options.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ))}

        {Object.entries(def.props || {}).map(([name, propDef]) => (
          <VfxPropertyField
            key={name}
            compact
            name={name}
            def={propDef}
            value={operator.props?.[name]}
            onValue={(next, meta) => actions.setOperatorProp(id, name, next, meta)}
            onMode={() => {}}
          />
        ))}

        {Object.keys(def.props || {}).length === 0 && Object.keys(def.modes || {}).length === 0 && (
          <p className="vfx-op__blurb">{def.blurb}</p>
        )}
      </div>

      {/* The only source handle on the board. Dropping it on a block opens a
          chooser of that block's compatible properties, so a wire cannot land
          somewhere meaningless. */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="vfx-op__socket"
      />
    </div>
  )
}
