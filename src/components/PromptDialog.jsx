// A one-field modal standing in for window.prompt().
//
// Electron does not implement window.prompt() — it returns undefined without
// showing anything and logs a console warning nobody sees. So a prompt-driven
// action works in a browser and silently does nothing in the desktop app, which
// is exactly the kind of bug that survives testing: the developer is in a dev
// browser, the user is not.
//
// Deliberately generic and unstyled beyond the app's own dialog look, so it can
// take over any remaining prompt() call rather than being a tree-generator part.
import { useCallback, useEffect, useRef, useState } from 'react'
import './PromptDialog.css'

export default function PromptDialog({
  title,
  message = null,
  defaultValue = '',
  type = 'text',
  min = null,
  max = null,
  confirmLabel = 'OK',
  onSubmit,
  onCancel,
}) {
  const [value, setValue] = useState(String(defaultValue ?? ''))
  const inputRef = useRef(null)

  // Focused and selected on open, so it behaves like the prompt it replaces:
  // type to overwrite the suggestion, Enter to accept it.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }, [value, onSubmit])

  useEffect(() => {
    const handler = event => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      className="promptdialog__overlay"
      role="presentation"
      onClick={event => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div className="promptdialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="promptdialog__title">{title}</h2>
        {message && <p className="promptdialog__message">{message}</p>}
        <form
          onSubmit={event => { event.preventDefault(); submit() }}
        >
          <input
            ref={inputRef}
            className="promptdialog__input"
            type={type}
            value={value}
            min={min ?? undefined}
            max={max ?? undefined}
            onChange={event => setValue(event.target.value)}
          />
          <div className="promptdialog__actions">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button type="submit" className="promptdialog__primary" disabled={!value.trim()}>
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
