// Result + rollback banner shown after an Auto UV / Auto Retopo run.
// Reuses the existing patch-preview styling. `rows` is [{ label, value }].
export default function MeshToolResult({ title, rows = [], previewUrl, previewAlt = 'Preview', onKeep, onRevert, disabled }) {
  return (
    <div className="mesh-editor-patch-preview">
      <strong className="mesh-editor-patch-preview__title">
        <span className="material-symbols-outlined">check_circle</span>
        {title}
      </strong>

      {previewUrl && (
        <img
          src={previewUrl}
          alt={previewAlt}
          className="mesh-editor-tool-preview"
          style={{ width: '100%', borderRadius: 'var(--radius-md)', display: 'block' }}
        />
      )}

      <div className="mesh-editor-texture-workflow-meta">
        {rows.map(row => (
          <span key={row.label}><strong>{row.label}:</strong> {row.value}</span>
        ))}
      </div>

      <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double mesh-editor-patch-preview__actions">
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onKeep}
          disabled={disabled}
          title="Keep this result"
        >
          <span className="material-symbols-outlined">check</span>
          <span>Keep</span>
        </button>
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--ghost"
          onClick={onRevert}
          disabled={disabled}
          title="Revert to the mesh before this operation"
        >
          <span className="material-symbols-outlined">undo</span>
          <span>Revert</span>
        </button>
      </div>
    </div>
  )
}
