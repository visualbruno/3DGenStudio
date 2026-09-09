import './VfxShortcuts.css'

// The keyboard sheet.
//
// IT LISTS ONLY WHAT IS REAL. A shortcuts sheet that documents a key the app
// does not handle is worse than no sheet - the reader tries it, nothing
// happens, and they stop trusting the rest of the list. Everything here is
// wired in VfxEditorPage's keydown handler, in the board (React Flow's own
// bindings) or in the block-row drag.
//
// SPACE GETS ITS OWN NOTE because it is the one genuine collision on this page:
// it is play/pause AND React Flow's pan modifier. The page resolves it rather
// than leaving it to chance, and an author who has just had a space bar do
// something unexpected is exactly who opens this sheet.
const GROUPS = [
  {
    title: 'Transport',
    rows: [
      ['Space', 'Play / pause'],
      ['Click the ruler', 'Scrub to a time'],
      ['Drag a clip', 'Retime it. The edges trim it.'],
      ['Shift while dragging', 'Ignore the simulation-step grid'],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['Ctrl / Cmd + Z', 'Undo — and it centres the node it changed'],
      ['Ctrl / Cmd + Y', 'Redo'],
      ['Escape', 'Close the Parameters panel'],
      ['Alt + ↑ / ↓', 'Move the selected block up or down its stack'],
    ],
  },
  {
    title: 'The board',
    rows: [
      ['Drag a node header', 'Move it. Only the header drags — the rows are controls.'],
      ['Shift + drag on empty space', 'Box select'],
      ['Scroll', 'Zoom. Scroll inside a block stack scrolls the stack instead.'],
      ['Drag from an operator', 'Wire it into a block property'],
    ],
  },
  {
    title: 'Widgets',
    rows: [
      ['Double-click a curve key', 'Cycle smooth / linear / stepped'],
      ['Shift while dragging a key', 'Lock to one axis'],
      ['Ctrl while dragging a key', 'Snap'],
      ['Click empty gradient rail', 'Add a stop, sampled so the look does not change'],
    ],
  },
]

/** @param {{onClose: () => void}} props */
export default function VfxShortcuts({ onClose }) {
  return (
    <div className="vfx-shortcuts-overlay" role="presentation" onClick={onClose}>
      <div
        className="vfx-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vfx-shortcuts-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="vfx-shortcuts__header">
          <h3 id="vfx-shortcuts-title" className="font-headline">Keyboard</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="vfx-shortcuts__body">
          {GROUPS.map(group => (
            <section key={group.title}>
              <h4>{group.title}</h4>
              <dl>
                {group.rows.map(([keys, what]) => (
                  <div key={keys}>
                    <dt><kbd>{keys}</kbd></dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <p className="vfx-shortcuts__note">
            Space is both play/pause and the board’s pan modifier. Inside the board,
            hold it and drag to pan; press and release it without moving and it
            plays or pauses. In a text field it types a space, as it should.
          </p>
        </div>
      </div>
    </div>
  )
}
