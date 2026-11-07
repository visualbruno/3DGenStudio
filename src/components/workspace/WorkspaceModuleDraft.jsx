// Panel of a Workspace module that is not built yet: what it is going to do.
import { MODULE_DRAFTS, WORKSPACE_MODULES } from './workspaceModules'

export default function WorkspaceModuleDraft({ moduleId }) {
  const module = WORKSPACE_MODULES.find(entry => entry.id === moduleId)
  const draft = MODULE_DRAFTS[moduleId]
  if (!module || !draft) return null

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">{module.icon}</span>
        {draft.title}
        <span className="workspace-soon-pill">Coming soon</span>
      </div>
      <div className="workspace-panel__scroll">
        <p className="workspace-draft__summary">{draft.summary}</p>
        <ul className="workspace-draft__list">
          {draft.points.map(point => <li key={point}>{point}</li>)}
        </ul>
      </div>
    </div>
  )
}
