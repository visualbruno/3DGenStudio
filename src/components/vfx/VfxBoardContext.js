// The actions and shared state the board's node components need.
//
// A context, NOT node `data`. React Flow rebuilds `data` whenever the document
// changes, and putting twenty callbacks in there would make every node's data
// object a fresh identity on every keystroke - defeating the memoisation that
// keeps a board with forty nodes responsive. It would also drag those callbacks
// through src/utils/vfx/flow.js, which is a pure adapter and worth keeping
// that way.
//
// So `data` carries only what a node RENDERS, and everything a node DOES comes
// from here.

import { createContext, useContext } from 'react'

/** @type {React.Context<Object>} */
export const VfxBoardContext = createContext(null)

/**
 * The board's action bundle. Throws nothing when absent - a node rendered
 * outside a board (a test, a storybook) gets no-ops rather than a crash.
 */
export function useVfxBoard() {
  return useContext(VfxBoardContext) || EMPTY
}

const noop = () => {}

// Every name the node components call, so a node rendered outside a board -
// a test, a future preview thumbnail - degrades to doing nothing rather than
// throwing on an undefined function. Kept in sync with the bundle built in
// VfxEditorPage; a missing name here is a crash, not a silent no-op.
const EMPTY = Object.freeze({
  actions: Object.freeze({
    select: noop,
    selectContext: noop,
    selectSystem: noop,
    selectOperator: noop,
    toggleExpanded: noop,
    toggleEnabled: noop,
    duplicate: noop,
    remove: noop,
    setProp: noop,
    setMode: noop,
    setCurvePreset: noop,
    setGradientPreset: noop,
    setBlockMode: noop,
    pickAsset: noop,
    addBlock: noop,
    moveBlock: noop,
    setContextParam: noop,
    setSpriteSheet: noop,
    addContext: noop,
    removeContext: noop,
    addSystem: noop,
    removeSystem: noop,
    duplicateSystem: noop,
    updateSystem: noop,
    addClip: noop,
    updateClip: noop,
    removeClip: noop,
    setEffectSettings: noop,
    addOperator: noop,
    removeOperator: noop,
    setOperatorProp: noop,
    setOperatorMode: noop,
    wire: noop,
    removeEdge: noop,
    unwire: noop,
    moveNode: noop,
    tidy: noop,
    addNote: noop,
    updateNote: noop,
    removeNote: noop,
    canFix: () => false,
    applyFix: noop,
  }),
  expanded: Object.freeze({}),
  fieldProps: Object.freeze({}),
  engineTarget: null,
  level: 'standard',
})
