// Writing the assembly out: a new version of each edited piece, and/or one
// merged GLB of the assembled character.
//
// Nothing in this workspace touches an asset until this dialog runs — the fit
// and the brush both edit a preview that lives in the session. This is the
// only place edits become durable.
import { useState } from 'react'

export default function AssemblySaveDialog({
  editedPieces,        // [{ piece, hasEdit }]
  mergedMaterialCount, // distinct materials the merged mesh would carry
  baseRig,             // { boneCount, boneNames } when the base is rigged
  baseClipCount,       // animation clips the base carries
  baseName,
  assemblyName,
  projects,
  busy,
  progress,
  error,
  result,
  onSave,
  onClose,
}) {
  const [saveVersions, setSaveVersions] = useState(true)
  const [saveMerged, setSaveMerged] = useState(true)
  const [mergedName, setMergedName] = useState(`${assemblyName || 'Assembly'} (assembled)`)
  const [includeBase, setIncludeBase] = useState(true)
  const [projectId, setProjectId] = useState('')
  const [transferWeights, setTransferWeights] = useState(!!baseRig)
  const [names, setNames] = useState(() =>
    Object.fromEntries(editedPieces.map(({ piece }) => [piece.id, piece.name])))

  const editable = editedPieces.filter(entry => entry.hasEdit)
  const nothingToDo = (!saveVersions || !editable.length) && !saveMerged

  return (
    <div className="assembly-save__overlay" role="presentation" onClick={event => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <div className="assembly-save" role="dialog" aria-modal="true">
        <div className="assembly-save__header">
          <h2>Save assembly</h2>
          <button type="button" onClick={onClose} disabled={busy}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="assembly-save__body">
          {/* ---- 1. edited pieces as new versions ---- */}
          <label className="assembly-save__check">
            <input
              type="checkbox"
              checked={saveVersions && !!editable.length}
              disabled={!editable.length || busy}
              onChange={event => setSaveVersions(event.target.checked)}
            />
            Save edited pieces as new versions
            {!editable.length && <span className="assembly-save__muted"> — nothing edited yet</span>}
          </label>

          {saveVersions && editable.length > 0 && (
            <>
              <ul className="assembly-save__pieces">
                {editable.map(({ piece }) => (
                  <li key={piece.id}>
                    <input
                      value={names[piece.id] ?? piece.name}
                      disabled={busy}
                      onChange={event => setNames(prev => ({ ...prev, [piece.id]: event.target.value }))}
                    />
                  </li>
                ))}
              </ul>
              {/* Worth stating: a version is a child of the original asset, so
                  it inherits that asset's projects and nothing is overwritten. */}
              <p className="assembly-save__note">
                Each becomes a new version of its own asset — the original is untouched,
                and the version appears under it on the Assets page. Saved in the
                piece&apos;s own space, so it drops back into an assembly the way the
                original did.
              </p>
            </>
          )}

          {/* ---- 2. the merged character ---- */}
          <label className="assembly-save__check">
            <input
              type="checkbox"
              checked={saveMerged}
              disabled={busy}
              onChange={event => setSaveMerged(event.target.checked)}
            />
            Save the assembled character as one mesh
          </label>

          {saveMerged && (
            <div className="assembly-save__merged">
              <label>
                Name
                <input value={mergedName} disabled={busy}
                       onChange={event => setMergedName(event.target.value)} />
              </label>
              <label className="assembly-save__check">
                <input type="checkbox" checked={includeBase} disabled={busy}
                       onChange={event => setIncludeBase(event.target.checked)} />
                Include the base body
              </label>

              {/* The step that makes the merged character animate as one thing.
                  Disabled rather than hidden when the base is unrigged, so the
                  reason is visible instead of the option simply missing. */}
              <label className="assembly-save__check"
                     title={baseRig ? '' : 'The base mesh is not rigged'}>
                <input
                  type="checkbox"
                  checked={transferWeights && !!baseRig}
                  disabled={busy || !baseRig}
                  onChange={event => setTransferWeights(event.target.checked)}
                />
                Transfer skin weights from the base
                {baseRig
                  ? <span className="assembly-save__muted"> ({baseRig.boneCount} bones)</span>
                  : <span className="assembly-save__muted"> — the base is not rigged</span>}
              </label>

              {transferWeights && baseRig && (
                <p className="assembly-save__note">
                  Every piece is bound to one copy of {baseName || 'the base'}&apos;s skeleton,
                  so the whole character animates together
                  {baseClipCount > 0 && <>, and its {baseClipCount} animation
                    {baseClipCount === 1 ? '' : 's'} come along</>}. This also avoids
                  sending the merged mesh back through the Mesh Editor to rig it, which
                  is what flattens its materials.
                </p>
              )}
              <label>
                Add to project
                <select value={projectId} disabled={busy}
                        onChange={event => setProjectId(event.target.value)}>
                  {/* Default none: an assembly is global because its pieces come
                      from different projects, so its output has no natural owner.
                      It stays in the library until the user picks one. */}
                  <option value="">None — keep in the library</option>
                  {(projects || []).map(project => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
              <p className="assembly-save__note">
                One mesh with each piece as its own node, in world space. Each piece
                uses its fitted result if it has one, even while the viewport is
                toggled to Original; use Revert on a piece to drop a fit you
                don&apos;t want.
              </p>
              {mergedMaterialCount > 1 && (
                /* Worth interrupting for: the mesh saves correctly and the loss
                   happens later, in a different workspace, so there is nothing
                   at that point to connect it back to. */
                <p className="assembly-save__warn">
                  This mesh keeps {mergedMaterialCount} separate materials. Opening it
                  in the Mesh Editor — including for Auto Rig — merges every piece into
                  one, and only the first material survives, so it comes back with one
                  texture. Export it or use it as-is; don&apos;t round-trip it through
                  the editor.
                </p>
              )}
            </div>
          )}

          {error && <div className="assembly-save__error">{error}</div>}
          {busy && <div className="assembly-save__progress">{progress || 'Saving…'}</div>}
          {result && (
            <div className="assembly-save__result">
              {result.versions.length > 0 && (
                <p>{result.versions.length} piece version{result.versions.length === 1 ? '' : 's'} saved.</p>
              )}
              {result.merged && <p>Saved “{result.merged.name}”.</p>}
              {result.failed.length > 0 && (
                <p className="assembly-save__error-text">
                  Failed: {result.failed.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="assembly-save__actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {result ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="assembly-save__primary"
            disabled={busy || nothingToDo}
            onClick={() => onSave({
              saveVersions: saveVersions && !!editable.length,
              saveMerged,
              mergedName,
              includeBase,
              projectId: projectId || null,
              transferWeights: transferWeights && !!baseRig,
              names,
            })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
