// The VFX Editor page.
//
// A SHELL, on purpose - the same rule TreeGenPage states in its own header.
// The viewport is VfxViewport, the numbers are VfxPreviewHud, the runtime is
// useVfxRuntime, load/save/draft is useVfxDocument, the effects are
// src/utils/vfx/templates.js and the compiler is vfx/compile.js. The thing
// being avoided is MeshEditorPage.jsx, which is twelve thousand lines because
// everything went inline.
//
// WHAT THIS IS AT PHASE 5: an effect can be opened from the Assets page,
// edited, and saved back. There is still no node board and no parameters panel
// - those are phase 6 - so "edited" currently means picking a template and
// renaming. The three-pane layout is deliberately not scaffolded: laying out
// panes with nothing to put in them would mean guessing at sizes the real
// content will decide.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import VfxViewport from '../components/vfx/VfxViewport'
import VfxPreviewHud from '../components/vfx/VfxPreviewHud'
import useVfxRuntime from '../hooks/useVfxRuntime'
import useVfxDocument from '../hooks/useVfxDocument'
import { useProjects } from '../context/ProjectContext'
import { useNotifications } from '../context/NotificationContext'
import { compileVfxGraph } from '../../vfx/compile.js'
import { summarizeDiagnostics } from '../../vfx/diagnostics.js'
import { VFX_TEMPLATES } from '../utils/vfx/templates.js'
import { makeTextureResolver } from '../utils/vfxApi.js'
import { createVfxThumbnailFile } from '../utils/vfxThumbnail.js'
import { reset, seekTo } from '../utils/vfx/system.js'
import './VfxEditorPage.css'

const SEVERITY_ICON = { error: 'error', warn: 'warning', info: 'info' }

export default function VfxEditorPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { getLibraryAssets } = useProjects()
  const { addNotification } = useNotifications()

  const [showSettings, setShowSettings] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [profile, setProfile] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showScale, setShowScale] = useState(false)
  const [orthographic, setOrthographic] = useState(false)
  const [engineTarget, setEngineTarget] = useState('')
  const [libraryImages, setLibraryImages] = useState([])
  const statsRef = useRef({})

  const notify = useCallback((message, type = 'error') => {
    addNotification?.({ type, message })
  }, [addNotification])

  const urlAssetId = searchParams.get('vfxAssetId')
  const returnTo = searchParams.get('returnTo') || '/assets'

  const {
    doc, name, setName, assetId, status, dirty,
    draft, restoreDraft, discardDraft, loadTemplate, save,
  } = useVfxDocument({ assetId: urlAssetId, onError: notify })

  // The image library, only so IR asset ids can be turned into URLs. The
  // runtime deliberately has no opinion about where assets live (see the header
  // of src/utils/vfx/assets.js), so the mapping is supplied from here.
  useEffect(() => {
    let cancelled = false
    getLibraryAssets?.()
      .then(library => {
        if (!cancelled) setLibraryImages(library?.images || [])
      })
      .catch(() => {
        // An effect with no textures still plays, on the built-in sprite. Not
        // worth a notification.
      })
    return () => {
      cancelled = true
    }
  }, [getLibraryAssets])

  const resolveUrl = useMemo(() => makeTextureResolver(libraryImages), [libraryImages])

  const compiled = useMemo(
    () => compileVfxGraph(doc, { engineTarget: engineTarget || null }),
    [doc, engineTarget],
  )

  const { runtime, batches } = useVfxRuntime({ ir: compiled.ir, resolveUrl, profile })

  const summary = useMemo(() => summarizeDiagnostics(compiled.diagnostics, {
    peakParticles: compiled.stats.peakParticles,
    drawCalls: compiled.stats.drawCalls,
    engines: compiled.stats.engines,
  }), [compiled])

  const bounds = useMemo(() => ({
    min: compiled.ir.effect.boundsMin,
    max: compiled.ir.effect.boundsMax,
  }), [compiled])

  // Once the effect has loaded, drop the id from the URL so a reload does not
  // re-open it over unsaved work. Deliberately only after a SUCCESSFUL load -
  // leaving it in place on failure keeps the link intact to retry, which is the
  // same reasoning as TreeGenPage.jsx:407.
  useEffect(() => {
    if (!urlAssetId || status === 'loading' || status === 'error') return
    if (assetId == null) return
    const next = new URLSearchParams(searchParams)
    next.delete('vfxAssetId')
    setSearchParams(next, { replace: true })
    // searchParams/setSearchParams are fresh each render; keying on them would
    // loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlAssetId, status, assetId])

  const handleSave = async ({ saveAs = false } = {}) => {
    let thumbnail = null
    try {
      thumbnail = await createVfxThumbnailFile(compiled.ir, { name })
    } catch {
      // Always best-effort. The effect is what matters and it is about to be
      // stored; losing the save over a cosmetic render would be the wrong
      // trade. The house rule is at TreeGenPage.jsx:622.
    }
    try {
      const saved = await save({ saveAs, thumbnail })
      notify(saveAs ? `Saved "${name}" as a new effect` : `Saved "${name}"`, 'success')
      return saved
    } catch {
      return null
    }
  }

  const restart = () => {
    if (runtime) reset(runtime)
  }

  const stepOnce = () => {
    if (!runtime) return
    setPlaying(false)
    seekTo(runtime, runtime.time + runtime.ir.effect.fixedDt)
  }

  const saveLabel = status === 'saving' ? 'Saving...' : assetId == null ? 'Save to library' : 'Save'

  return (
    <div className="vfx-page">
      <Header title="VFX Editor" centerTitle onSettingsClick={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {draft && (
        <div className="vfx-page__draft">
          <span className="material-symbols-outlined">history</span>
          <span>
            There are unsaved changes from {new Date(draft.savedAt).toLocaleString()}
            {draft.name ? ` to "${draft.name}"` : ''}.
          </span>
          <button type="button" onClick={restoreDraft}>Restore them</button>
          <button type="button" className="is-quiet" onClick={discardDraft}>Discard</button>
        </div>
      )}

      <div className="vfx-page__bar">
        <input
          className="vfx-page__name"
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder="Effect name"
          aria-label="Effect name"
        />

        <div className="vfx-page__save">
          <button type="button" onClick={() => handleSave()} disabled={status === 'saving'}>
            {saveLabel}
          </button>
          {assetId != null && (
            <button
              type="button"
              className="is-quiet"
              onClick={() => handleSave({ saveAs: true })}
              disabled={status === 'saving'}
            >
              Save as new
            </button>
          )}
          <span className={`vfx-page__status is-${dirty ? 'dirty' : status}`}>
            {status === 'loading' ? 'Opening...'
              : status === 'saving' ? 'Saving...'
                : dirty ? 'Unsaved changes'
                  : status === 'saved' ? 'Saved' : ''}
          </span>
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
          <a className="vfx-page__back" href={returnTo}>Assets</a>
        </div>
      </div>

      {/* Templates are the on-ramp, not demo content: nobody learns a particle
          system from an empty board. Phase 8 turns this row into the full
          gallery with animated previews and a "what this teaches you" list. */}
      <div className="vfx-page__templates">
        <span className="vfx-page__templates-label">Start from</span>
        {VFX_TEMPLATES.map(template => (
          <button
            key={template.id}
            type="button"
            className="vfx-page__template"
            onClick={() => loadTemplate(template)}
            title={`${template.blurb}\n\nTeaches: ${template.teaches.join(', ')}`}
          >
            {template.name}
          </button>
        ))}
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

      {/* Pinned inside the body rather than floating over the canvas, so it
          never covers anything and is never a translucent layer over a live
          WebGL surface. */}
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
