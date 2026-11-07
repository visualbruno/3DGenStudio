// The Workspace's left icon rail: one entry per module.
import { WORKSPACE_MODULES } from './workspaceModules'

export default function WorkspaceToolRail({ activeModule, onSelect }) {
  return (
    <nav className="workspace-rail" aria-label="Workspace tools">
      {WORKSPACE_MODULES.map(module => (
        <button
          key={module.id}
          type="button"
          className={`workspace-rail__item ${activeModule === module.id ? 'workspace-rail__item--active' : ''}`}
          onClick={() => onSelect(module.id)}
          aria-pressed={activeModule === module.id}
          title={module.ready ? module.label : `${module.label} (coming soon)`}
        >
          <span className="material-symbols-outlined workspace-rail__icon">{module.icon}</span>
          <span className="workspace-rail__label">{module.label}</span>
          {!module.ready && <span className="workspace-rail__soon">Soon</span>}
        </button>
      ))}
    </nav>
  )
}
