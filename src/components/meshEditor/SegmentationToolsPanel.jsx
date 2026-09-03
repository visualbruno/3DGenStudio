// Smart Segmentation mode left panel.
//
// Two-stage tool, and the split matters to how this reads: "Analyze" is the only
// thing that costs a round trip to the Python service. Everything below it —
// above all the Parts slider — replays the hierarchy that call returned and is
// instant, so those controls stay live while nothing is running.
// Presentational: all state and handlers come from MeshEditorPage.
import MeshToolProgress from './MeshToolProgress'
import { NumberField, RangeField, ToggleField } from './MeshToolField'

const TOOLS = [
  { id: 'brush', label: 'Brush', icon: 'brush', hint: 'Sweep faces into another part' },
  { id: 'merge', label: 'Merge', icon: 'join_inner', hint: 'Click parts to fuse them' },
  { id: 'focus', label: 'Split One', icon: 'call_split', hint: 'Cut inside a single part' },
]

export default function SegmentationToolsPanel({
  options,
  setOption,
  running,
  progress,
  analysis,
  parts,
  onPartsChange,
  partCount,
  partSizes,
  minPartFaces,
  onMinPartFacesChange,
  onRun,
  onAuto,
  onExport,
  exporting,
  exportTextured,
  onExportTexturedChange,
  canExportTextured,
  onClear,
  tool,
  onToolChange,
  targetFace,
  targetLabel,
  palette,
  brushSize,
  brushSizeRange,
  onBrushSizeChange,
  paintedFaces,
  canUndo,
  onUndo,
  onClearPaint,
  mergePicks,
  onApplyMerge,
  onResetMerges,
  mergeCount,
  focused,
  pendingSplits,
  appliedSplits,
  pinnedLevel,
  explode,
  onExplodeChange,
  onApplyFocus,
  onClearFocus,
  onResetSplits,
  disabled,
}) {
  const o = options
  const busy = disabled || running
  const analyzed = !!analysis
  // The hierarchy cannot produce more parts than it has proxy regions, and below
  // `minParts` the shells simply are not connected to each other.
  const maxParts = analyzed ? Math.max(2, Math.min(200, analysis.proxyFaceCount)) : 200
  const keptParts = analyzed
    ? Array.from(partSizes || []).filter(size => size >= minPartFaces).length
    : 0
  const dropped = partCount - keptParts
  // Once a split has been applied the level is pinned, so Parts only does
  // anything while a region is focused. Leaving it live would be a dead control.
  const partsLocked = pinnedLevel > 0 && !focused
  const targetSwatch = palette && targetLabel >= 0
    ? `rgb(${palette.slice(targetLabel * 3, targetLabel * 3 + 3)
      .map(channel => Math.round(channel * 255)).join(',')})`
    : null

  return (
    <>{/* SMART SEGMENTATION */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Smart Segmentation</span>
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={busy}
          title="Measure the mesh and build the part hierarchy. Run once — the Parts slider is free afterwards"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'shape_line'}</span>
          <span>{running ? 'Analyzing…' : analyzed ? 'Re-analyze' : 'Analyze Mesh'}</span>
        </button>
        <MeshToolProgress progress={progress} />

        {analyzed && !running && (
          <>
            <div className="mesh-editor-panel__hint">
              {analysis.proxyFaceCount.toLocaleString()} proxy faces
              {analysis.shells > 1 ? ` · ${analysis.shells} shells` : ''}
              {' · '}{analysis.faceCount.toLocaleString()} faces mapped
            </div>
            {analysis.escapeRatio > 0.35 && (
              <div className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
                {Math.round(analysis.escapeRatio * 100)}% of the thickness rays escaped — the mesh is
                open, so the parts are guessed from creases alone. Repair it for a better split.
              </div>
            )}
            {analysis.note && (
              <div className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>{analysis.note}</div>
            )}
          </>
        )}
      </div>

      {analyzed && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">Parts</span>
          <RangeField
            label="Parts"
            hint={focused
              ? 'Each step up is one more cut inside the focused part.'
              : 'Where to cut the hierarchy. Free to change — nothing is recomputed.'}
            value={parts}
            min={focused ? Math.max(2, pinnedLevel) : 2}
            max={maxParts}
            step={1}
            onChange={onPartsChange}
            disabled={running || partsLocked}
          />
          {partsLocked && (
            <span className="mesh-editor-panel__hint">
              Pinned at {pinnedLevel} while per-part splits are applied — every other
              part has to stay exactly as it is. Use Split One on another part, or
              Reset Splits to go back to the whole model.
            </span>
          )}
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--secondary"
            onClick={onAuto}
            disabled={running || !analysis.suggestedParts}
            title={analysis.suggestedParts
              ? `Jump to ${analysis.suggestedParts} — the largest jump in merge cost`
              : 'Not enough hierarchy to suggest a part count'}
          >
            <span className="material-symbols-outlined">auto_awesome</span>
            <span>{analysis.suggestedParts ? `Auto (${analysis.suggestedParts})` : 'Auto'}</span>
          </button>
          <div className="mesh-editor-panel__hint">
            {partCount} part{partCount === 1 ? '' : 's'} on screen
            {analysis.minParts > parts ? ` · only ${analysis.minParts} regions available` : ''}
          </div>
          <RangeField
            label="Explode"
            hint="Push the parts apart to see inside the split. Preview only — the mesh and the export are untouched."
            value={explode}
            min={0}
            max={2}
            step={0.02}
            decimals={2}
            onChange={onExplodeChange}
            disabled={running}
          />
          {explode > 0 && (
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--ghost"
              onClick={() => onExplodeChange(0)}
              disabled={running}
            >
              <span className="material-symbols-outlined">compress</span>
              <span>Reassemble</span>
            </button>
          )}
        </div>
      )}

      {analyzed && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">Fix By Hand</span>
          <span className="mesh-editor-panel__hint">
            Corrections are stored against the faces themselves, so they survive
            moving the Parts slider afterwards.
          </span>
          {explode > 0 && (
            <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
              Reassemble first — while the parts are exploded the cursor no longer
              lands where the mesh is drawn.
            </span>
          )}
          <div className="mesh-editor-mode-menu">
            {TOOLS.map(entry => (
              <button
                key={entry.id}
                type="button"
                className={`mesh-editor-mode-btn ${tool === entry.id ? 'mesh-editor-mode-btn--active' : ''}`}
                onClick={() => onToolChange(entry.id)}
                disabled={running || explode > 0}
                title={explode > 0 ? 'Set Explode back to 0 to correct parts' : entry.hint}
              >
                <span className="material-symbols-outlined">{entry.icon}</span>
                <span>{entry.label}</span>
              </button>
            ))}
          </div>

          {tool === 'brush' && (
            <>
              {targetFace >= 0 ? (
                <div className="mesh-editor-workflow-field">
                  <span>Sweeping into</span>
                  <span
                    style={{
                      width: 22, height: 22, borderRadius: 4, background: targetSwatch || '#888',
                      border: '1px solid rgba(255,255,255,0.25)'
                    }}
                  />
                </div>
              ) : (
                <span className="mesh-editor-panel__hint">
                  Click the part you want faces moved INTO, then drag over the faces.
                </span>
              )}
              <RangeField
                label="Brush size" min={brushSizeRange.min} max={brushSizeRange.max}
                step={Math.max(0.0001, brushSizeRange.max / 200)} decimals={3}
                hint="Radius in model units."
                value={brushSize} onChange={onBrushSizeChange} disabled={running}
              />
              <span className="mesh-editor-panel__hint">
                Drag: sweep · Ctrl+drag: release back to the analysis · Shift+click:
                choose a different target. Back faces are never touched.
              </span>
              <div className="mesh-editor-panel__row">
                <button
                  type="button"
                  className="mesh-editor-btn mesh-editor-btn--ghost"
                  onClick={onUndo}
                  disabled={!canUndo || running}
                  title="Undo the last stroke"
                >
                  <span className="material-symbols-outlined">undo</span>
                  <span>Undo Stroke</span>
                </button>
              </div>
              {paintedFaces > 0 && (
                <>
                  <span className="mesh-editor-panel__hint">
                    {paintedFaces.toLocaleString()} face{paintedFaces === 1 ? '' : 's'} reassigned by hand.
                  </span>
                  <button
                    type="button"
                    className="mesh-editor-btn mesh-editor-btn--ghost"
                    onClick={onClearPaint}
                    disabled={running}
                  >
                    <span className="material-symbols-outlined">layers_clear</span>
                    <span>Clear All Strokes</span>
                  </button>
                </>
              )}
            </>
          )}

          {tool === 'merge' && (
            <>
              <span className="mesh-editor-panel__hint">
                Click parts to gather them — click again to drop one. The rest of the
                mesh dims so the selection is unambiguous.
              </span>
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--primary"
                onClick={onApplyMerge}
                disabled={mergePicks < 2 || running}
              >
                <span className="material-symbols-outlined">join_inner</span>
                <span>{mergePicks < 2 ? 'Pick 2 or more parts' : `Fuse ${mergePicks} Parts`}</span>
              </button>
            </>
          )}

          {tool === 'focus' && !focused && (
            <span className="mesh-editor-panel__hint">
              Click the part you want cut up. Everything else is then frozen, so
              raising Parts subdivides that one part and nothing else.
            </span>
          )}

          {focused && (
            <>
              <span className="mesh-editor-panel__hint">
                Splitting one part only — raise Parts above to cut inside it.
                {pendingSplits > 0 ? ` ${pendingSplits} cut${pendingSplits === 1 ? '' : 's'} proposed.` : ''}
              </span>
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--primary"
                onClick={onApplyFocus}
                disabled={pendingSplits < 1 || running}
              >
                <span className="material-symbols-outlined">check</span>
                <span>Apply &amp; Pick Next</span>
              </button>
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--ghost"
                onClick={onClearFocus}
                disabled={running}
              >
                <span className="material-symbols-outlined">close</span>
                <span>Cancel Focus</span>
              </button>
            </>
          )}

          {(mergeCount > 0 || appliedSplits > 0) && (
            <div className="mesh-editor-panel__hint">
              {mergeCount > 0 && `${mergeCount} manual merge${mergeCount === 1 ? '' : 's'}. `}
              {appliedSplits > 0 && `${appliedSplits} applied cut${appliedSplits === 1 ? '' : 's'}.`}
            </div>
          )}
          {mergeCount > 0 && (
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--ghost"
              onClick={onResetMerges}
              disabled={running}
            >
              <span className="material-symbols-outlined">loop</span>
              <span>Reset Merges</span>
            </button>
          )}
          {appliedSplits > 0 && (
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--ghost"
              onClick={onResetSplits}
              disabled={running}
            >
              <span className="material-symbols-outlined">loop</span>
              <span>Reset Splits</span>
            </button>
          )}
        </div>
      )}

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Analysis</span>
        <span className="mesh-editor-panel__hint">
          Changing these needs another Analyze — they shape the hierarchy itself,
          not which level of it you are looking at.
        </span>
        <NumberField
          label="Proxy faces" min={200} max={50000} step={500}
          hint="Detail the analysis runs at. Higher = finer boundaries, much slower."
          value={o.proxy_faces} onChange={value => setOption('proxy_faces', value)} disabled={busy}
        />
        <RangeField
          label="Crease bias" min={0} max={1} step={0.02} decimals={2}
          hint="How much cheaper it is to cut in a valley than over a ridge. Low keeps boundaries in the creases; 1.0 ignores the difference."
          value={o.convex_eta} onChange={value => setOption('convex_eta', value)} disabled={busy}
        />
        <RangeField
          label="Thickness weight" min={0} max={4} step={0.1} decimals={1}
          hint="Separate parts by how thick they are — a limb from a torso."
          value={o.w_thickness} onChange={value => setOption('w_thickness', value)} disabled={busy}
        />
        <RangeField
          label="Crease weight" min={0} max={4} step={0.1} decimals={1}
          hint="Separate parts by the fold along their shared boundary — a panel line."
          value={o.w_concavity} onChange={value => setOption('w_concavity', value)} disabled={busy}
        />
        <NumberField
          label="Thickness rays" min={4} max={128} step={2}
          hint="Rays per proxy face. More is steadier on noisy surfaces and slower."
          value={o.sdf_rays} onChange={value => setOption('sdf_rays', value)} disabled={busy}
        />
        <ToggleField
          label="Precise thickness"
          hint="Measure against the full-resolution mesh instead of the proxy. The only way thin details read as thin."
          value={o.precise} onChange={value => setOption('precise', value)} disabled={busy}
        />
      </div>

      {analyzed && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">Output</span>
          <NumberField
            label="Min part faces" min={1} max={500} step={1}
            hint="Parts smaller than this are dropped — they are decimation noise, not parts."
            value={minPartFaces} onChange={onMinPartFacesChange} disabled={running}
          />
          {canExportTextured && (
            <ToggleField
              label="Keep the mesh texture"
              hint="The parts kept their UVs, so they can share the mesh's own texture — nothing is re-baked. Off exports each part in the colour it is drawn on screen instead."
              value={exportTextured}
              onChange={onExportTexturedChange}
              disabled={running || exporting}
            />
          )}
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--primary"
            onClick={onExport}
            disabled={running || exporting || keptParts < 1}
            title="Download a GLB containing one named object per part"
          >
            <span className="material-symbols-outlined">{exporting ? 'progress_activity' : 'download'}</span>
            <span>{exporting ? 'Exporting…' : `Export ${keptParts} Part${keptParts === 1 ? '' : 's'}`}</span>
          </button>
          {dropped > 0 && (
            <span className="mesh-editor-panel__hint">
              {dropped} part{dropped === 1 ? '' : 's'} below the minimum will not be exported.
            </span>
          )}
          <span className="mesh-editor-panel__hint">
            The mesh in the editor is not modified — the parts are exported as a
            separate GLB with one object each.
            {canExportTextured
              ? exportTextured
                ? ' All of them share the one texture, so the image is stored once.'
                : ' Each part is a flat colour — the texture is left out.'
              : ' The parts are flat colours: this mesh has no texture to share.'}
          </span>
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--ghost"
            onClick={onClear}
            disabled={running}
            title="Drop the analysis and go back to the normal shaded view"
          >
            <span className="material-symbols-outlined">layers_clear</span>
            <span>Clear Segmentation</span>
          </button>
        </div>
      )}
    </>
  )
}
