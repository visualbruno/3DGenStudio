// Floating display toolbar over the 3D stage (Tripo-style): wireframe overlay,
// then the shading mode (Solid / Textured / Normals), then — for Textured —
// how the texture is lit (PBR / Unlit albedo).
const SHADING_MODES = [
  { id: 'solid', label: 'Solid', title: 'Solid view — untextured, to judge the shape' },
  { id: 'textured', label: 'Textured', title: 'Textured view' },
  { id: 'normal', label: 'Normals', title: 'Normal view — surface directions as colours' }
]

const TEXTURE_MODES = [
  { id: 'pbr', label: 'PBR', title: 'PBR — the materials under the scene lights' },
  { id: 'unlit', label: 'Unlit', title: 'Unlit — the base colour (albedo) only, no lighting' }
]

export default function WorkspaceViewToolbar({ settings, onChange, rigged = false }) {
  const set = (patch) => onChange({ ...settings, ...patch })
  const textured = settings.shading === 'textured'

  return (
    <div className="workspace-viewbar" role="toolbar" aria-label="Display">
      <button
        type="button"
        className={`workspace-viewbar__btn ${settings.wireframe ? 'workspace-viewbar__btn--active' : ''}`}
        onClick={() => set({ wireframe: !settings.wireframe })}
        aria-pressed={settings.wireframe}
        title={settings.wireframe ? 'Hide wireframe' : 'Show wireframe (works with every view)'}
      >
        <span className="material-symbols-outlined">language</span>
      </button>

      <span className="workspace-viewbar__divider" aria-hidden="true" />

      {SHADING_MODES.map(mode => (
        <button
          key={mode.id}
          type="button"
          className={`workspace-viewbar__btn ${settings.shading === mode.id ? 'workspace-viewbar__btn--active' : ''}`}
          onClick={() => set({ shading: mode.id })}
          aria-pressed={settings.shading === mode.id}
          title={mode.title}
        >
          <span className={`workspace-viewbar__sphere workspace-viewbar__sphere--${mode.id}`} aria-hidden="true" />
          <span className="workspace-viewbar__sr">{mode.label}</span>
        </button>
      ))}

      <span className="workspace-viewbar__divider" aria-hidden="true" />

      {TEXTURE_MODES.map(mode => (
        <button
          key={mode.id}
          type="button"
          className={[
            'workspace-viewbar__btn',
            textured && settings.texture === mode.id ? 'workspace-viewbar__btn--active' : '',
            textured ? '' : 'workspace-viewbar__btn--dim'
          ].filter(Boolean).join(' ')}
          onClick={() => set({ shading: 'textured', texture: mode.id })}
          aria-pressed={textured && settings.texture === mode.id}
          title={textured ? mode.title : `${mode.title} — switches to the Textured view`}
        >
          <span className={`workspace-viewbar__sphere workspace-viewbar__sphere--${mode.id}`} aria-hidden="true" />
          <span className="workspace-viewbar__sr">{mode.label}</span>
        </button>
      ))}

      {rigged && (
        <>
          <span className="workspace-viewbar__divider" aria-hidden="true" />
          <button
            type="button"
            className={`workspace-viewbar__btn ${settings.skeleton ? 'workspace-viewbar__btn--active' : ''}`}
            onClick={() => set({ skeleton: !settings.skeleton })}
            aria-pressed={Boolean(settings.skeleton)}
            title={settings.skeleton ? 'Hide the skeleton' : 'Show the skeleton'}
          >
            <span className="material-symbols-outlined">skeleton</span>
          </button>
        </>
      )}
    </div>
  )
}
