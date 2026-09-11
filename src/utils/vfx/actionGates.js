// What a toolbar action will do, and what it is called while it does it.
//
// TWO WRONG ANSWERS CAME BEFORE THIS ONE, and both are worth remembering.
//
// First, Export was HIDDEN whenever the effect had not been saved - which is
// the state you are in every time you open a preset. The reported bug was
// "Export is missing", and the first guess was that the toolbar had run out of
// room. It had not: the button was never rendered. A feature that vanishes and
// a feature that does not exist look identical.
//
// Then it was shown but DISABLED, with a tooltip explaining that the effect had
// to be saved first. Honest, and still wrong: the reason a save is needed is a
// fact about how the exporter works - the bundle is built on the server from
// the saved FILE - and that is the app's problem, not something to hand to the
// author as a chore. Opening a preset and pressing Export should export.
//
// So the action SAYS what it will do and then does all of it. The save is not
// hidden - the button is labelled "Save & Export..." - because it has a real
// consequence: the effect appears in the library. Announcing that is different
// from making someone perform it.
//
// Pure, and separate from the page, so the rule is checkable without a DOM.

/** What the button says when the effect is already saved and unchanged. */
export const EXPORT_READY_HINT =
  'Write an engine bundle: the graph, the compiled IR, the compatibility table '
  + 'and every texture and mesh this effect uses.';

/**
 * @param {Object} state
 * @param {number|null|undefined} state.assetId  null until first saved
 * @param {boolean} state.dirty                  unsaved edits on screen
 * @param {string} state.status                  'idle' | 'saving' | ...
 * @returns {{disabled: boolean, needsSave: boolean, label: string, hint: string}}
 */
export function exportAction({ assetId, dirty, status }) {
  // The one case that is genuinely unavailable rather than merely unsaved: a
  // save is already in flight, and starting a second one would race it.
  if (status === 'saving') {
    return {
      disabled: true,
      needsSave: false,
      label: 'Export...',
      hint: 'Saving...',
    };
  }

  const needsSave = assetId == null || dirty;
  if (!needsSave) {
    return { disabled: false, needsSave: false, label: 'Export...', hint: EXPORT_READY_HINT };
  }

  // THE TWO REASONS READ DIFFERENTLY ON PURPOSE. An unsaved effect is also
  // dirty, so the order here matters: telling someone to "save your changes
  // first" when they have never saved at all sounds like the save they just did
  // not having counted.
  const hint = assetId == null
    ? 'Adds this effect to your library, then writes the engine bundle. The '
      + 'bundle is built from the saved file, so there has to be one.'
    : 'Saves your changes, then writes the engine bundle. The bundle is built '
      + 'from the saved file, not from what is on screen.';

  return { disabled: false, needsSave: true, label: 'Save & Export...', hint };
}
