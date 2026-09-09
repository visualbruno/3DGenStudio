// The VFX Editor page.
//
// A SHELL, on purpose - the same rule TreeGenPage states in its own header.
// The viewport is VfxViewport, the numbers are VfxPreviewHud, the runtime is
// useVfxRuntime, the effects are src/utils/vfx/templates.js and the compiler is
// vfx/compile.js. The thing being avoided is MeshEditorPage.jsx, which is
// twelve thousand lines because everything went inline.
//
// WHAT THIS IS AT PHASE 4: first pixels. It opens a starter effect, compiles it,
// plays it, and shows the cost and the diagnostics. There is no node board and
// no parameters panel yet - those are phase 6 - and no saving, which is phase 5.
// The three-pane layout the feature is built around is deliberately not
// scaffolded here: laying out panes before there is anything to put in them
// would mean guessing, and the grid strategy is already designed in the plan.

import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import VfxViewport from '../components/vfx/VfxViewport'
import VfxPreviewHud from '../components/vfx/VfxPreviewHud'
import useVfxRuntime from '../hooks/useVfxRuntime'
import { compileVfxGraph } from '../../vfx/compile.js'
import { summarizeDiagnostics } from '../../vfx/diagnostics.js'
import { VFX_TEMPLATES, templateById } from '../utils/vfx/templates.js'
import { reset, seekTo } from '../utils/vfx/system.js'
import './VfxEditorPage.css'

const SEVERITY_ICON = {
  error: 'error',
  warn: 'warning',
  info: 'info',
}

export default function VfxEditorPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [showSettings, setShowSettings] = useState(false)
  const [templateId, setTemplateId] = useState(() => searchParams.get('template') || 'sparks')
  const [playing, setPlaying] = useState(true)
  const [profile, setProfile] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showScale, setShowScale] = useState(false)
  const [orthographic, setOrthographic] = useState(false)
  const [engineTarget, setEngineTarget] = useState('')
  const statsRef = useRef({})

  const doc = useMemo(() => {
    const template = templateById(templateId) || VFX_TEMPLATES[0]
    return template.build()
  }, [templateId])

  // Recompiles when the document or the export target changes. The compiler is
  // pure and fast enough that memoising on the document is all the caching this
  // needs; the runtime keys on ir.graphHash, so an identical recompile does not
  // rebuild anything.
  const compiled = useMemo(
    () => compileVfxGraph(doc, { engineTarget: engineTarget || null }),
    [doc, engineTarget],
  )

  const { runtime, batches } = useVfxRuntime({
    ir: compiled.ir,
    profile,
  })

  const summary = useMemo(
    () => summarizeDiagnostics(compiled.diagnostics, {
      peakParticles: compiled.stats.peakParticles,
      drawCalls: compiled.stats.drawCalls,
      engines: compiled.stats.engines,
    }),
    [compiled],
  )

  const bounds = useMemo(() => ({
    min: compiled.ir.effect.boundsMin,
    max: compiled.ir.effect.boundsMax,
  }), [compiled])

  const chooseTemplate = id => {
    setTemplateId(id)
    setSearchParams({ template: id }, { replace: true })
  }

  const restart = () => {
    if (runtime) reset(runtime)
  }

  const stepOnce = () => {
    if (!runtime) return
    setPlaying(false)
    seekTo(runtime, runtime.time + runtime.ir.effect.fixedDt)
  }

  return (
    <div className="vfx-page">
      <Header
        title="VFX Editor"
        centerTitle
        onSettingsClick={() => setShowSettings(true)}
      />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="vfx-page__bar">
        <div className="vfx-page__templates">
          {VFX_TEMPLATES.map(template => (
            <button
              key={template.id}
              type="button"
              className={`vfx-page__template ${template.id === templateId ? 'is-active' : ''}`}
              onClick={() => chooseTemplate(template.id)}
              title={template.blurb}
            >
              {template.name}
            </button>
          ))}
        </div>

        <div className="vfx-page__transport">
          <button type="button" onClick={restart} title="Restart">
            <span className="material-symbols-outlined">replay</span>
          </button>
          <button type="button" onClick={() => setPlaying(p => !p)} title={playing ? 'Pause' : 'Play'}>
            <span className="material-symbols-outlined">{playing ? 'pause' : 'play_arrow'}</span>
          </button>
          <button type="button" onClick={stepOnce} title="Step one frame">
            <span className="material-symbols-outlined">skip_next</span>
          </button>
        </div>

        <div className="vfx-page__toggles">
          <label>
            <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />
            Grid
          </label>
          <label>
            <input type="checkbox" checked={showScale} onChange={e => setShowScale(e.target.checked)} />
            Scale
          </label>
          <label>
            <input type="checkbox" checked={orthographic} onChange={e => setOrthographic(e.target.checked)} />
            Ortho
          </label>
          <label title="Per-kernel timing. Adds a little overhead of its own.">
            <input type="checkbox" checked={profile} onChange={e => setProfile(e.target.checked)} />
            Profile
          </label>
          <select
            value={engineTarget}
            onChange={e => setEngineTarget(e.target.value)}
            title="Raises export-fidelity warnings for the chosen engine"
          >
            <option value="">Target: none</option>
            <option value="unity">Target: Unity</option>
            <option value="unreal">Target: Unreal</option>
          </select>
        </div>
      </div>

      <div className="vfx-page__body">
        <div className="vfx-page__viewport">
          <VfxViewport
            runtime={runtime}
            batches={batches}
            playing={playing}
            statsRef={statsRef}
            orthographic={orthographic}
            showGrid={showGrid}
            showScale={showScale}
            bounds={bounds}
            frameKey={compiled.ir.graphHash}
          />
          <VfxPreviewHud statsRef={statsRef} showKernels={profile} />
        </div>
      </div>

      {/* The diagnostics strip. Pinned inside the body rather than floating
          over the canvas, so it never covers anything and is never a
          translucent layer over a live WebGL surface. */}
      <div className={`vfx-page__diagnostics is-${summary.tone}`}>
        <div className="vfx-page__diagnostics-summary">
          <span className="material-symbols-outlined">
            {summary.tone === 'ok' ? 'check_circle' : SEVERITY_ICON[summary.tone]}
          </span>
          {summary.text}
        </div>
        {compiled.diagnostics.length > 0 && (
          <ul className="vfx-page__diagnostics-list">
            {compiled.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`} className={`is-${diagnostic.severity}`}>
                <span className="material-symbols-outlined">{SEVERITY_ICON[diagnostic.severity]}</span>
                <span className="vfx-page__diagnostics-text">
                  <strong>{diagnostic.title}</strong>
                  {' '}
                  {diagnostic.message}
                  {diagnostic.hint && <em> {diagnostic.hint}</em>}
                </span>
                {/* Fixes are descriptors, not functions - the applier registry
                    lands with the editing surface in phase 6, so the label is
                    shown disabled rather than pretending to work. */}
                {diagnostic.fix && (
                  <button type="button" disabled title="Fixes become clickable with the node board">
                    {diagnostic.fix.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Footer variant="kanban" />
    </div>
  )
}
