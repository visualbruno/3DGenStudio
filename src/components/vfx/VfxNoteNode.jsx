// A note on the board: the author's own comment on their own effect.
//
// "Comment groups" in the plan's language. Two things about it are decided
// rather than incidental:
//
// IT IS A REACT FLOW NODE, not an overlay. That means it pans and zooms with
// the board, which is the whole point - a note has to stay attached to the
// systems it is about. The cost is that it is inside `transform: scale(z)`, so
// its text scales too; that is correct here, unlike the hover cards, because a
// note is board content rather than chrome.
//
// IT NEVER RECOMPILES THE EFFECT. Notes live in `doc.layout`, which
// vfxSignature excludes (invariant 2 in vfx/doc.js), so typing in one cannot
// rebuild the runtime or restart the simulation. Without that, writing a
// sentence about an explosion would restart the explosion on every keystroke.
//
// THE TEXTAREA IS UNCONTROLLED WHILE FOCUSED. It commits on blur and on
// Ctrl+Enter, with a coalescing commit as you type so nothing is lost to a
// crash - the same shape as every other editing surface here, and what stops a
// paragraph becoming two hundred undo entries.

import { useCallback, useEffect, useRef, useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import { useVfxBoard } from './VfxBoardContext'
import './VfxNoteNode.css'

export default function VfxNoteNode({ id, data, selected }) {
  const { note } = data
  const { actions } = useVfxBoard()
  const [text, setText] = useState(note.text)
  const editing = useRef(false)

  // Kept in step with the document unless the author is typing - an undo or a
  // reload should update the note, a keystroke should not be overwritten by the
  // value that keystroke produced.
  useEffect(() => {
    if (!editing.current) setText(note.text)
  }, [note.text])

  const commit = useCallback(next => {
    actions.updateNote(id, { text: next })
  }, [actions, id])

  return (
    <div
      className={`vfx-note${selected ? ' is-selected' : ''}`}
      style={{
        width: note.width,
        height: note.height,
        '--vfx-note-accent': `var(--vfx-accent-${note.accent % 6})`,
      }}
    >
      {/* React Flow's own resizer, so a note can be dragged to fit the group it
          surrounds. The size commits on the end of the drag rather than per
          frame, for the same reason node positions do. */}
      <NodeResizer
        isVisible={selected}
        minWidth={140}
        minHeight={70}
        onResizeEnd={(_event, params) => {
          actions.updateNote(id, { width: Math.round(params.width), height: Math.round(params.height) })
        }}
      />

      <div className="vfx-note__bar vfx-node__drag-handle">
        <span className="material-symbols-outlined">sticky_note_2</span>
        <div className="vfx-note__accents nodrag">
          {[0, 1, 2, 3, 4, 5].map(index => (
            <button
              key={index}
              type="button"
              className={`vfx-note__accent${note.accent === index ? ' is-active' : ''}`}
              style={{ background: `var(--vfx-accent-${index})` }}
              onClick={() => actions.updateNote(id, { accent: index })}
              aria-label={`Colour ${index + 1}`}
              title="Match a note to the systems it is about"
            />
          ))}
        </div>
        <button
          type="button"
          className="vfx-note__remove nodrag"
          onClick={() => actions.removeNote(id)}
          aria-label="Delete note"
          title="Delete this note"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>

      <textarea
        className="vfx-note__text nodrag nowheel"
        value={text}
        placeholder="What is this part of the effect for?"
        onFocus={() => { editing.current = true }}
        onChange={event => {
          setText(event.target.value)
          commit(event.target.value)
        }}
        onBlur={() => {
          editing.current = false
          commit(text)
        }}
        onKeyDown={event => {
          // Enter inserts a newline - a note is prose. Ctrl+Enter is the
          // "I am done" gesture, matching every other multi-line field.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
      />
    </div>
  )
}
