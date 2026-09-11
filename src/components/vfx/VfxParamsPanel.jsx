// The Parameters pane: everything about whatever is selected.
//
// THE PANE HAS NO SCHEMA OF ITS OWN. It renders whatever the catalog entry
// declares, in the order the entry declares it, split into Basic and Advanced
// by the entry's own `basic` flag. Built in the spirit of
// src/components/treeGen/treeParams.js + TreeParamPanel.jsx, which already
// proved the pattern in this codebase - with one addition, described below.
//
// THE ADDITION: A HIDDEN PROPERTY THAT IS DOING SOMETHING STILL SHOWS. When
// Advanced is off, a non-basic property whose value differs from the catalog
// default is displayed anyway, with a "changed" dot. Templates and AI
// generation both move advanced values, and hiding a setting that is actively
// shaping the effect is how a beginner ends up mystified - they compare their
// graph to the documentation, everything matches, and it still looks wrong.
//
// FOUR SELECTION STATES, ONE PANE. A block, a context, a system, or nothing -
// and "nothing" is not an empty pane, it is the effect's own settings, which is
// where seed, duration, looping and capacity live. An author who clicks empty
// space should land somewhere useful rather than nowhere.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CATALOG, CONTEXT_DEFS, defaultProps, ENGINE_SUPPORT } from '../../../vfx/catalog.js'
import { CONTEXT_KIND } from '../../../vfx/doc.js'
import { readSpriteSheet } from '../../utils/vfx/edits.js'
import { normalizeValue } from '../../../vfx/value.js'
import VfxPropertyField from './VfxPropertyField'
import VfxPathField from './VfxPathField'
import './VfxParamsPanel.css'

const SUPPORT_TEXT = {
  [ENGINE_SUPPORT.NATIVE]: 'imports natively',
  [ENGINE_SUPPORT.APPROX]: 'imports as an approximation',
  [ENGINE_SUPPORT.NONE]: 'has no equivalent and will be dropped',
}

/** Whether a property has been moved off the catalog's default. */
function isModified(def, name, value) {
  const fallback = defaultProps(def)[name]
  try {
    return JSON.stringify(normalizeValue(value)) !== JSON.stringify(normalizeValue(fallback))
  } catch {
    return false
  }
}

// Resolve a selection to the thing it names, plus its ancestors - the panel
// needs the system and context to draw the breadcrumb.
//
// Deliberately NOT a useMemo. It is a walk over a few dozen blocks, so the
// memo's own bookkeeping costs more than the scan, and the React Compiler
// cannot preserve a memo whose body is a loop with several early returns
// (react-hooks/preserve-manual-memoization) - which means the memo would have
// opted the whole component out of compilation to save nothing.
function findSelection(doc, selection) {
  if (!selection) return null
  for (const system of doc.systems) {
    if (selection.kind === 'system' && system.id === selection.id) {
      return { kind: 'system', system }
    }
    for (const context of system.contexts) {
      if (selection.kind === 'context' && context.id === selection.id) {
        return { kind: 'context', system, context }
      }
      for (const block of context.blocks) {
        if (selection.kind === 'block' && block.id === selection.id) {
          return { kind: 'block', system, context, block }
        }
      }
    }
  }
  for (const operator of doc.operators) {
    if (selection.kind === 'operator' && operator.id === selection.id) {
      return { kind: 'operator', operator }
    }
  }
  return null
}

function EngineNote({ def }) {
  if (!def?.engines) return null
  const rows = [['unity', 'Unity'], ['unreal', 'Unreal']]
    .map(([key, label]) => ({ key, label, support: def.engines[key] }))
    .filter(row => row.support)
  if (rows.length === 0) return null
  const worst = rows.some(r => r.support === ENGINE_SUPPORT.NONE)
    ? 'bad'
    : rows.some(r => r.support === ENGINE_SUPPORT.APPROX) ? 'warn' : 'ok'
  return (
    <div className={`vfx-params__engines is-${worst}`}>
      {rows.map(row => (
        <div key={row.key}>
          <strong>{row.label}</strong> {SUPPORT_TEXT[row.support]}
        </div>
      ))}
      {def.engines.note && <p>{def.engines.note}</p>}
    </div>
  )
}

/**
 * @param {Object} props
 * @param {Object} props.doc
 * @param {Object|null} props.selection { kind: 'block'|'context'|'system'|'effect', id }
 * @param {Object} props.actions the page's edit action bundle
 * @param {Object} props.fieldProps blockId -> propName -> extra props (asset labels)
 * @param {Array<Object>} props.diagnostics diagnostics for the selection
 * @param {string} props.level disclosure level
 * @param {() => Object} [props.getCurvePlayhead] read per frame by an open
 *   curve editor, so the running simulation draws itself on the graph
 * @param {() => void} props.onClose
 */
export default function VfxParamsPanel({
  doc,
  selection,
  actions,
  fieldProps = {},
  diagnostics = [],
  level = 'standard',
  getCurvePlayhead = null,
  onClose,
}) {
  // `full` opens Advanced - an author who chose the most detailed level should
  // not then have to open every section by hand.
  //
  // KEYED ON `level`, NOT SEEDED BY IT. As a plain useState initialiser this
  // only ever applied on the panel's FIRST mount, so switching Detail to full
  // with a node already selected did nothing visible - which is most of why the
  // dropdown looked inert. Resetting it on every change of `level` also means
  // switching back to standard re-hides Advanced, which is what "less detail"
  // has to mean if the control is to be worth having.
  // DERIVED FROM `level`, WITH AN OVERRIDE THAT REMEMBERS WHICH LEVEL IT WAS
  // MADE AT. Two things had to be true at once and a plain boolean gives only
  // one of them:
  //
  //   - Changing Detail has to change what is shown. As a bare
  //     `useState(level === 'full')` this applied on the panel's FIRST mount
  //     and never again, so switching to full with a node already selected did
  //     nothing - most of why the dropdown looked inert.
  //   - Clicking Advanced has to stick, and not be undone by the next render.
  //
  // Storing the level alongside the choice satisfies both without an effect and
  // without writing a ref during render: a new level simply does not match the
  // stored one, so the override lapses and the level's own default takes over.
  const [advancedOverride, setAdvancedOverride] = useState(null)
  const advanced = advancedOverride?.level === level
    ? advancedOverride.value
    : level === 'full'
  const setAdvanced = value => setAdvancedOverride({ level, value })
  // ONE editor open at a time, keyed by property name. Two curve canvases in a
  // panel this narrow would each be too short to edit, and both would run their
  // own playhead loop.
  const [openEditor, setOpenEditor] = useState(null)

  const found = findSelection(doc, selection)
  const kind = found?.kind || 'effect'

  return (
    <aside className="vfx-params" aria-label="Parameters">
      <header className="vfx-params__head">
        <div className="vfx-params__titles">
          <span className="vfx-params__title">{titleFor(found, doc)}</span>
          <span className="vfx-params__crumb">{crumbFor(found, doc)}</span>
        </div>
        {kind !== 'effect' && (
          <button
            type="button"
            className="vfx-params__close"
            onClick={onClose}
            title="Close, and go back to the effect settings"
            aria-label="Close parameters"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        )}
      </header>

      {diagnostics.length > 0 && (
        <ul className="vfx-params__diagnostics">
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}-${index}`} className={`is-${diagnostic.severity}`}>
              <strong>{diagnostic.title}</strong> {diagnostic.message}
              {diagnostic.fix && actions.canFix(diagnostic.fix) && (
                <button type="button" onClick={() => actions.applyFix(diagnostic)}>
                  {diagnostic.fix.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="vfx-params__body">
        {kind === 'block' && (
          <BlockParams
            found={found}
            advanced={advanced}
            setAdvanced={setAdvanced}
            actions={actions}
            fieldProps={fieldProps[found.block.id] || {}}
            level={level}
            openEditor={openEditor}
            setOpenEditor={setOpenEditor}
            getCurvePlayhead={getCurvePlayhead}
          />
        )}
        {kind === 'context' && <ContextParams found={found} actions={actions} doc={doc} />}
        {kind === 'system' && <SystemParams found={found} actions={actions} />}
        {kind === 'operator' && <OperatorParams found={found} actions={actions} />}
        {kind === 'effect' && <EffectParams doc={doc} actions={actions} />}
      </div>
    </aside>
  )
}

function titleFor(found, doc) {
  if (!found) return doc.name || 'Effect'
  if (found.kind === 'block') return CATALOG.block(found.block.type)?.label || found.block.type
  if (found.kind === 'context') return CONTEXT_DEFS[found.context.kind]?.label || found.context.kind
  if (found.kind === 'system') return found.system.name
  return CATALOG.operator(found.operator.type)?.label || found.operator.type
}

function crumbFor(found, doc) {
  if (!found) return `${doc.systems.length} system${doc.systems.length === 1 ? '' : 's'}`
  if (found.kind === 'block') {
    return `${found.system.name} · ${CONTEXT_DEFS[found.context.kind]?.label || found.context.kind}`
  }
  if (found.kind === 'context') return found.system.name
  if (found.kind === 'system') return 'System'
  return 'Operator'
}

// ---------------------------------------------------------------------------

function BlockParams({
  found, advanced, setAdvanced, actions, fieldProps, level,
  openEditor, setOpenEditor, getCurvePlayhead,
}) {
  const { block } = found
  const def = CATALOG.block(block.type)

  if (!def) {
    return (
      <p className="vfx-params__unknown">
        This document uses a block type this build does not know
        (<code>{block.type}</code>). Its settings are preserved, so opening the
        effect in a newer build will show them again.
      </p>
    )
  }

  const entries = Object.entries(def.props || {})
  const shown = entries.filter(([name, propDef]) => (
    advanced || propDef.basic || isModified(def, name, block.props?.[name])
  ))
  const hiddenCount = entries.length - shown.length

  return (
    <>
      {/* The teach line is the sentence that prevents this block's classic
          mistake. It is above the controls, not in a tooltip, because the
          mistake is made while setting them. */}
      <p className="vfx-params__teach">{def.teach}</p>

      {Object.keys(def.modes || {}).length > 0 && (
        <div className="vfx-params__modes">
          {Object.entries(def.modes).map(([mode, modeDef]) => (
            <label className="vfx-params__mode" key={mode}>
              <span className="vfx-params__mode-label">{modeDef.label}</span>
              <select
                value={block.modes?.[mode] ?? modeDef.default}
                onChange={event => actions.setBlockMode(block.id, mode, event.target.value)}
              >
                {modeDef.options.map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              {modeDef.hint && <p className="vfx-params__mode-hint">{modeDef.hint}</p>}
            </label>
          ))}
        </div>
      )}

      {/* THE PATH FIRST, because for a curve emitter it IS the shape and
          everything else - thickness, spacing, tangent speed - modifies it. */}
      {def.points && (
        <VfxPathField
          def={def.points}
          points={block.points}
          onChange={next => actions.setBlockPoints(block.id, next)}
        />
      )}

      <div className="vfx-params__props">
        {shown.map(([name, propDef]) => (
          <VfxPropertyField
            key={name}
            name={name}
            def={propDef}
            value={block.props?.[name]}
            modified={isModified(def, name, block.props?.[name])}
            onValue={(next, meta) => actions.setProp(block.id, name, next, meta)}
            onMode={mode => actions.setMode(block.id, name, mode)}
            onCurvePreset={id => actions.setCurvePreset(block.id, name, id)}
            onGradientPreset={id => actions.setGradientPreset(block.id, name, id)}
            onPickAsset={() => actions.pickAsset(block.id, name, propDef.type)}
            onClearAsset={() => actions.setProp(block.id, name, '', {})}
            onUnwire={() => actions.unwire(block.id, name)}
            editorOpen={openEditor === name}
            onToggleEditor={() => setOpenEditor(openEditor === name ? null : name)}
            getPlayhead={getCurvePlayhead}
            {...(fieldProps[name] || {})}
          />
        ))}
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          className="vfx-params__advanced"
          onClick={() => setAdvanced(true)}
        >
          Show {hiddenCount} more setting{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
      {advanced && entries.some(([, propDef]) => !propDef.basic) && (
        <button
          type="button"
          className="vfx-params__advanced"
          onClick={() => setAdvanced(false)}
        >
          Show fewer settings
        </button>
      )}

      <EngineNote def={def} />

      <div className="vfx-params__links">
        {/* The wiki route already exists, so a deep link costs nothing and
            gives every block somewhere to point at. */}
        {/* ONE page, by NAME, not a per-block id. `/wiki/vfx-<blockId>` was a
            dead link for every block: wiki pages are addressed by database id
            and Number('vfx-update.gravity') is NaN, so the pane rendered its
            empty welcome state. WikiPage now resolves a non-numeric id by
            title, so this lands on the page if someone has written it and says
            so plainly if not - and nobody was ever going to write thirty-five
            of them. The per-block teaching lives in the hover card and in the
            panel above this link. */}
        <Link to="/wiki/VFX%20Editor" className="vfx-params__learn">
          Learn more about {def.label}
          <span className="material-symbols-outlined">arrow_forward</span>
        </Link>
      </div>

      {/* At the most detailed level, the raw node. This doubles as the
          bug-report format: "here is the JSON" is a complete report. */}
      {level === 'full' && (
        <details className="vfx-params__raw">
          <summary>Raw JSON</summary>
          <pre>{JSON.stringify(block, null, 2)}</pre>
        </details>
      )}

      <div className="vfx-params__actions">
        <button type="button" onClick={() => actions.duplicate(block.id)}>
          <span className="material-symbols-outlined">content_copy</span>
          Duplicate
        </button>
        <button type="button" className="is-danger" onClick={() => actions.remove(block.id)}>
          <span className="material-symbols-outlined">delete</span>
          Delete
        </button>
      </div>
    </>
  )
}

/**
 * The sprite sheet, as one control instead of three blocks in two stages.
 *
 * WHY IT IS NOT JUST THE TWO BLOCKS' OWN FIELDS. A sheet needs
 * `output.setFlipbook` to say how the atlas is cut AND `update.flipbook` to step
 * through it, and those live in DIFFERENT stages - so the natural way to set one
 * up is to add the Output block, see nothing happen, and conclude the texture is
 * cropped. It is the hardest flipbook mistake to diagnose from the viewport,
 * which is why the compiler has a warning for it.
 *
 * The frame count is DERIVED from the grid rather than typed, so the player and
 * the sheet cannot disagree - the other half-configured state the compiler has
 * to warn about.
 *
 * Rendered on the OUTPUT stage because that is where the texture is chosen, and
 * a sheet is a property of the texture rather than of the simulation.
 */
function SpriteSheetParams({ system, doc, actions }) {
  const sheet = readSpriteSheet(doc, system.id)
  const tiles = sheet.columns * sheet.rows
  const set = (patch) => actions.setSpriteSheet(system.id, { ...sheet, ...patch })

  return (
    <div className="vfx-params__sheet">
      <span className="vfx-params__mode-label">Sprite sheet</span>
      <div className="vfx-params__sheet-grid">
        <label>
          <span>Columns</span>
          <input
            type="number" min="1" max="32" step="1" value={sheet.columns}
            onChange={event => set({ columns: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Rows</span>
          <input
            type="number" min="1" max="32" step="1" value={sheet.rows}
            onChange={event => set({ rows: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Frames/s</span>
          <input
            type="number" min="1" max="120" step="1" value={sheet.fps}
            disabled={tiles <= 1}
            onChange={event => set({ fps: Number(event.target.value) })}
          />
        </label>
      </div>
      <p className="vfx-params__mode-hint">
        {tiles <= 1
          ? 'One tile: the texture is a single sprite. Set columns and rows to cut it into an animation - the player block is added for you.'
          : `${tiles} frames, ${(tiles / sheet.fps).toFixed(2)}s per loop. Rows count downward from the top left, the way sheets are laid out.`}
      </p>
      {tiles > 1 && (
        <p className="vfx-params__mode-hint">
          Give particles a lifetime of at least {(tiles / sheet.fps).toFixed(2)}s, or they die before the animation finishes.
        </p>
      )}
    </div>
  )
}

function ContextParams({ found, actions, doc }) {
  const { context, system } = found
  const def = CONTEXT_DEFS[context.kind] || {}
  // As in VfxContextNode: a param whose choices are the effect's own systems.
  const systemOptions = doc.systems
    .filter(entry => entry.id !== system.id)
    .map(entry => ({ value: entry.id, label: entry.name }))
  return (
    <>
      <p className="vfx-params__teach">{def.blurb} {def.flowNote}</p>
      {Object.entries(def.params || {}).map(([param, paramDef]) => {
        const options = paramDef.optionsFrom === 'systems'
          ? systemOptions
          : paramDef.options.map(value => ({ value, label: value }))
        return (
          <label className="vfx-params__mode" key={param}>
            <span className="vfx-params__mode-label">{paramDef.label}</span>
            <select
              value={context.params?.[param] ?? paramDef.default}
              onChange={event => actions.setContextParam(context.id, param, event.target.value)}
            >
              {paramDef.optionsFrom === 'systems' && <option value="">Choose a system…</option>}
              {options.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {paramDef.hint && <p className="vfx-params__mode-hint">{paramDef.hint}</p>}
          </label>
        )
      })}

      {context.kind === CONTEXT_KIND.OUTPUT && (
        <SpriteSheetParams system={system} doc={doc} actions={actions} />
      )}

      <p className="vfx-params__note">
        {context.blocks.length} block{context.blocks.length === 1 ? '' : 's'}, in
        {' '}
        {system.name}. Blocks run top to bottom.
      </p>
      <div className="vfx-params__actions">
        <button
          type="button"
          className="is-danger"
          onClick={() => actions.removeContext(context.id)}
        >
          <span className="material-symbols-outlined">delete</span>
          Remove this stage
        </button>
      </div>
    </>
  )
}

function SystemParams({ found, actions }) {
  const { system } = found
  // Which stages this system does not have yet.
  //
  // THIS IS THE ONLY WAY TO REACH AN EVENT STAGE, and therefore the only way to
  // make a sub-emitter. Without it the whole event system would be reachable
  // from the compiler and the runtime but not from the editor - which is worse
  // than not having built it, because the format would carry documents the UI
  // could not produce.
  //
  // Output is always offerable; the others only when absent, matching what
  // addContext will actually accept.
  const missing = Object.entries(CONTEXT_DEFS).filter(([kind]) => (
    kind === CONTEXT_KIND.OUTPUT || !system.contexts.some(c => c.kind === kind)
  ))
  return (
    <>
      <label className="vfx-params__text">
        <span className="vfx-params__mode-label">Name</span>
        <input
          value={system.name}
          onChange={event => actions.updateSystem(system.id, { name: event.target.value })}
        />
      </label>
      <label className="vfx-params__text">
        <span className="vfx-params__mode-label">Capacity</span>
        <input
          type="number"
          min={1}
          value={system.capacity}
          onChange={event => actions.updateSystem(system.id, {
            capacity: Math.max(1, Number(event.target.value) || 1),
          })}
        />
        <p className="vfx-params__mode-hint">
          The most particles that can be alive at once. Spawning past it drops
          the extras and the preview counts them - rate times the longest
          lifetime is what has to fit.
        </p>
      </label>
      {missing.length > 0 && (
        <div className="vfx-params__stages">
          <span className="vfx-params__mode-label">Add a stage</span>
          {missing.map(([kind, def]) => (
            <button
              key={kind}
              type="button"
              className="vfx-params__stage"
              onClick={() => actions.addContext(system.id, kind)}
              title={`${def.blurb}\n\n${def.flowNote}`}
            >
              <span className="material-symbols-outlined">{def.icon}</span>
              <span>
                <strong>{def.label}</strong>
                {def.blurb}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="vfx-params__actions">
        <button type="button" onClick={() => actions.duplicateSystem(system.id)}>
          <span className="material-symbols-outlined">content_copy</span>
          Duplicate
        </button>
        <button type="button" className="is-danger" onClick={() => actions.removeSystem(system.id)}>
          <span className="material-symbols-outlined">delete</span>
          Delete
        </button>
      </div>
    </>
  )
}

function OperatorParams({ found, actions }) {
  const { operator } = found
  const def = CATALOG.operator(operator.type)
  if (!def) return <p className="vfx-params__unknown">Unknown operator {operator.type}.</p>
  return (
    <>
      <p className="vfx-params__teach">{def.teach}</p>
      <div className="vfx-params__props">
        {Object.entries(def.props || {}).map(([name, propDef]) => (
          <VfxPropertyField
            key={name}
            name={name}
            def={propDef}
            value={operator.props?.[name]}
            onValue={(next, meta) => actions.setOperatorProp(operator.id, name, next, meta)}
            onMode={() => {}}
          />
        ))}
      </div>
      <EngineNote def={def} />
      <div className="vfx-params__actions">
        <button
          type="button"
          className="is-danger"
          onClick={() => actions.removeOperator(operator.id)}
        >
          <span className="material-symbols-outlined">delete</span>
          Delete
        </button>
      </div>
    </>
  )
}

function EffectParams({ doc, actions }) {
  const { effect } = doc
  return (
    <>
      <p className="vfx-params__teach">
        Settings for the whole effect. Click a block on the board to edit it.
      </p>
      <label className="vfx-params__text">
        <span className="vfx-params__mode-label">Duration (s)</span>
        <input
          type="number"
          min={0.05}
          step={0.05}
          value={effect.duration}
          onChange={event => actions.setEffectSettings({
            duration: Math.max(0.05, Number(event.target.value) || 0.05),
          })}
        />
      </label>
      <label className="vfx-params__check">
        <input
          type="checkbox"
          checked={Boolean(effect.loop)}
          onChange={event => actions.setEffectSettings({ loop: event.target.checked })}
        />
        Loop
      </label>
      <label className="vfx-params__text">
        <span className="vfx-params__mode-label">Seed</span>
        <input
          type="number"
          value={effect.seed}
          onChange={event => actions.setEffectSettings({ seed: Number(event.target.value) || 0 })}
        />
        <p className="vfx-params__mode-hint">
          The same seed always produces the same effect. Change it to get a
          different roll of the same dice, and it travels into Unity and Unreal
          so their output is reproducible too - though not identical to this
          preview.
        </p>
      </label>
    </>
  )
}
