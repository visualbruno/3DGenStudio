// The VFX Editor page.
//
// A SHELL, on purpose - the same rule TreeGenPage states in its own header. The
// board is VfxBoard, the parameters are VfxParamsPanel, the timeline is
// VfxTimeline, the viewport is VfxViewport, the numbers are VfxPreviewHud, the
// runtime is useVfxRuntime, load/save/draft is useVfxDocument, every document
// change is a pure function in src/utils/vfx/edits.js and the compiler is
// vfx/compile.js. What lives here is the wiring: selection, the action bundle,
// the layout, and the keyboard.
//
// THE LAYOUT IS THREE GRID TRACKS THAT ALWAYS EXIST. The parameters track is
// 0-wide when nothing is selected, so opening it is ONE custom-property write
// on ONE element:
//
//     grid-template-columns: var(--vfx-params-w) minmax(0,1fr) var(--vfx-preview-w)
//
// No React re-render of the board or the preview, and - the part that decides
// it - THE WEBGL CANVAS NEVER RESIZES, because only the board narrows. A
// variant-class swap (MeshEditorPage's approach) would re-layout all three
// panes and force a canvas resize on every open and close.
//
// MUTE AND SOLO ARE PREVIEW STATE, NOT DOCUMENT STATE. The compiler drops
// disabled systems from the IR, so writing `enabled: false` would change the
// graph hash and restart the whole effect - and the entire point of muting one
// system is to watch the others keep running. system.js says the same thing at
// setSystemState: "deliberately NOT part of the graph signature". So these two
// toggles live in page state and are pushed at the runtime directly.
//
// SPACE IS THE ONE REAL SHORTCUT COLLISION, and it is decided rather than
// discovered: it is play/pause everywhere on this page, and React Flow's
// pan-on-space is turned off in VfxBoard (`panActivationKeyCode={null}`). It is
// the most-pressed key here, so it gets the simple behaviour and panning keeps
// the middle mouse button and the scroll wheel it already had.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import AssetSelectorModal from '../components/AssetSelectorModal'
import VfxExportDialog from '../components/vfx/VfxExportDialog'
import VfxSpritePanel from '../components/vfx/VfxSpritePanel'
import VfxShortcuts from '../components/vfx/VfxShortcuts'
import VfxPresetsDialog from '../components/vfx/VfxPresetsDialog'
import VfxViewport from '../components/vfx/VfxViewport'
import VfxPreviewHud from '../components/vfx/VfxPreviewHud'
import VfxBoard from '../components/vfx/VfxBoard'
import VfxParamsPanel from '../components/vfx/VfxParamsPanel'
import VfxTimeline from '../components/vfx/VfxTimeline'
import VfxSplitter from '../components/vfx/VfxSplitter'
import VfxEmptyOverlay from '../components/vfx/VfxEmptyOverlay'
import useVfxRuntime from '../hooks/useVfxRuntime'
import useVfxDocument from '../hooks/useVfxDocument'
import { useProjects } from '../context/ProjectContext'
import { useNotifications } from '../context/NotificationContext'
import { compileVfxGraph } from '../../vfx/compile.js'
import { summarizeDiagnostics } from '../../vfx/diagnostics.js'
import { PROP_TYPE } from '../../vfx/catalog.js'
import { REF_KIND, formatAssetRef } from '../../vfx/doc.js'
import { indexLibraryAssets, makeAssetResolver, vfxAssetId } from '../utils/vfxApi.js'
import { aliveCount, createVfxThumbnailFile } from '../utils/vfxThumbnail.js'
import { reset, seekTo, setSystemState } from '../utils/vfx/system.js'
import {
  autoLayout,
  clearLayout,
  systemIdForSelection,
  indexDiagnostics,
  setNodePosition,
} from '../utils/vfx/flow.js'
import { emitterGizmos, gizmoMeshAssetId } from '../utils/vfx/gizmos.js'
import { BLAME_ACTION } from '../utils/vfx/blame.js'
import { readPaneSize } from '../utils/vfx/panes.js'
import * as edits from '../utils/vfx/edits.js'
import './VfxEditorPage.css'

const SEVERITY_ICON = { error: 'error', warning: 'warning', warn: 'warning', info: 'info' }

const PARAMS_KEY = 'vfx:pane:params'
const PREVIEW_KEY = 'vfx:pane:preview'
const LEVEL_KEY = 'vfx:level'
// One shared empty, so turning the gizmos off does not hand the viewport a new
// array on every render.
const EMPTY_GIZMOS = Object.freeze([])

// The name an author gave an asset, for a message about an id they never see.
function assetLabelFor(doc, assetId) {
  for (const entry of Object.values(doc.references || {})) {
    if (entry?.ref === `asset:${assetId}`) return entry.name || `asset ${assetId}`
  }
  return `asset ${assetId}`
}
const PARAMS_DEFAULT = 300
const PREVIEW_DEFAULT = 520

// How many particles the curve editor's playhead overlay samples. The editor
// draws one tick each, and past a couple of hundred they stop being
// distinguishable from a filled bar - so sampling more would cost work to
// produce less information.
const PLAYHEAD_SAMPLES = 192

const readLevel = () => {
  try {
    const stored = window.localStorage.getItem(LEVEL_KEY)
    return ['guided', 'standard', 'full'].includes(stored) ? stored : 'standard'
  } catch {
    return 'standard'
  }
}

export default function VfxEditorPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { getLibraryAssets } = useProjects()
  const { addNotification } = useNotifications()

  const [showSettings, setShowSettings] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [timescale, setTimescale] = useState(1)
  const [profile, setProfile] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showScale, setShowScale] = useState(false)
  const [showEmitters, setShowEmitters] = useState(false)
  const [showStats, setShowStats] = useState(true)
  const [orthographic, setOrthographic] = useState(false)
  const [engineTarget, setEngineTarget] = useState('')
  const [level, setLevel] = useState(readLevel)
  const [libraryImages, setLibraryImages] = useState([])
  const [libraryMeshes, setLibraryMeshes] = useState([])
  // Whether the library fetch has FINISHED, which is not the same question as
  // whether it found anything - see resolveUrl below.
  const [libraryReady, setLibraryReady] = useState(false)

  // Selection: `{ kind, id }`, or null for the effect itself. Not part of the
  // document, so not undoable - but an undo entry carries a focusNodeId so the
  // caller can reveal whatever it changed.
  const [selection, setSelection] = useState(null)
  const [expanded, setExpanded] = useState({})
  const [preview, setPreview] = useState({})
  const [picker, setPicker] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [spriteOpen, setSpriteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  // The system the board is showing. See activeSystemId below for why this is
  // a LAST CHOICE rather than the answer.
  const [pinnedSystemId, setPinnedSystemId] = useState(null)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
  // Bumped to force CameraRig to re-frame. Combined with the graph hash rather
  // than replacing it, so an edit still re-frames on a new effect and "Frame
  // the effect" works without one.
  const [frameNonce, setFrameNonce] = useState(0)

  // Read in the state initialiser, so the very first paint is already the right
  // width - no flash of the default, and no layout effect.
  const [paramsWidth, setParamsWidth] = useState(() => readPaneSize(PARAMS_KEY, PARAMS_DEFAULT))
  const [previewWidth, setPreviewWidth] = useState(() => readPaneSize(PREVIEW_KEY, PREVIEW_DEFAULT))

  const bodyRef = useRef(null)
  const statsRef = useRef({})
  const runtimeRef = useRef(null)
  const flowRef = useRef(null)
  // The preview's camera, handed out from inside the Canvas by VfxSystemView.
  // It is how the thumbnail is taken from the author's own viewpoint.
  const cameraRef = useRef(null)

  const notify = useCallback((message, type = 'error') => {
    addNotification?.({ type, message })
  }, [addNotification])

  const urlAssetId = searchParams.get('vfxAssetId')
  // NO `returnTo` LINK IN THE TOOLBAR. The deep link from the Assets page still
  // carries the parameter, but the app Header already has an Assets nav item -
  // and a second one sitting between the Detail and Target dropdowns read as
  // another panel toggle rather than as a way back.

  const {
    doc, commit, undo, redo, canUndo, canRedo, undoLabel, redoLabel,
    name, setName, assetId, status, dirty,
    draft, restoreDraft, discardDraft, loadTemplate, save,
  } = useVfxDocument({ assetId: urlAssetId, onError: notify })

  // The library, only so IR asset ids can be turned into URLs and the picker
  // has something to show. The runtime deliberately has no opinion about where
  // assets live - see the header of src/utils/vfx/assets.js.
  //
  // A CALLBACK RATHER THAN AN EFFECT BODY, because it has to run again: a
  // sprite generated during this session is not in a listing fetched when the
  // page opened, and the effect that references it would resolve to nothing.
  const reloadLibrary = useCallback(() => (
    getLibraryAssets?.()
      .then(library => {
        setLibraryImages(library?.images || [])
        setLibraryMeshes(library?.meshes || [])
      })
      .catch(() => {
        // An effect with no textures still plays, on the built-in sprite.
      })
      .finally(() => setLibraryReady(true))
  ), [getLibraryAssets])

  useEffect(() => {
    let cancelled = false
    getLibraryAssets?.()
      .then(library => {
        if (cancelled) return
        setLibraryImages(library?.images || [])
        setLibraryMeshes(library?.meshes || [])
      })
      .catch(() => {
        // An effect with no textures still plays, on the built-in sprite.
      })
      .finally(() => {
        // SET ON FAILURE TOO. This gates the resolver below, and a library
        // fetch that 500s must fall through to the built-in sprite rather than
        // leaving the runtime waiting for a list that will never arrive.
        if (!cancelled) setLibraryReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [getLibraryAssets])

  // ASSET IDS THE DOCUMENT USES THAT THE LISTING HAS NEVER HEARD OF.
  //
  // THE BUG THIS FIXES: generating a sprite uploaded it, wired it in, and
  // changed nothing on screen. The listing above is fetched when the page
  // opens, so an asset created DURING the session is not in it - `resolveUrl`
  // answered null, loadVfxTextures found nothing, and the batch fell back to
  // the built-in blob. Silently, because falling back to the built-in sprite is
  // the correct behaviour for a texture that genuinely is not there.
  //
  // Reacting to the DOCUMENT rather than to the generate button covers every
  // way a new reference can appear - the sprite panel, the asset picker, an
  // effect saved by an agent in another window, a template - with one
  // mechanism instead of a call at each site, one of which would be forgotten.
  const missingAssetKey = useMemo(() => {
    const known = indexLibraryAssets([...libraryImages, ...libraryMeshes])
    const missing = []
    for (const entry of Object.values(doc.references || {})) {
      const match = /^asset:(\d+)$/.exec(String(entry?.ref || ''))
      if (match && !known.has(Number(match[1]))) missing.push(match[1])
    }
    return missing.sort().join(',')
  }, [doc.references, libraryImages, libraryMeshes])

  useEffect(() => {
    if (!libraryReady || !missingAssetKey) return
    // KEYED ON THE MISSING SET, so a genuinely deleted asset costs exactly ONE
    // reload rather than one per render: after the reload the key is unchanged,
    // and an unchanged dependency does not run the effect again.
    reloadLibrary()
  }, [libraryReady, missingAssetKey, reloadLibrary])

  // IMAGES AND MESHES BOTH, because useVfxRuntime hands this one resolver to
  // loadVfxTextures and loadVfxMeshes alike. Built from the images alone, every
  // mesh asset resolved to null and the mesh renderer silently had nothing to
  // draw.
  //
  // NULL UNTIL THE LIBRARY HAS ARRIVED, which is the other half of that fix.
  // The runtime skips loading while this is null, so it waits instead of
  // burning a pass on a resolver that answers null for everything - and the
  // difference between "no library yet" and "a library with nothing in it" is
  // exactly what a bare empty array cannot express.
  const resolveUrl = useMemo(
    () => (libraryReady ? makeAssetResolver([...libraryImages, ...libraryMeshes]) : null),
    [libraryReady, libraryImages, libraryMeshes],
  )

  const compiled = useMemo(
    () => compileVfxGraph(doc, { engineTarget: engineTarget || null }),
    [doc, engineTarget],
  )

  const { runtime, batches, textures, meshes, failedAssets } = useVfxRuntime({
    ir: compiled.ir, resolveUrl, profile,
  })

  // Mirrored into a ref in an effect rather than assigned during render.
  // The transport callbacks and the timeline's per-frame playhead read the
  // runtime outside of rendering, and a ref written during render is what the
  // hooks linter (correctly) rejects - the same fix as the savedSignature one
  // in useVfxDocument.
  useEffect(() => {
    runtimeRef.current = runtime
  }, [runtime])

  // WHICH SYSTEM THE BOARD SHOWS, in priority order: what is selected, then
  // what was last chosen, then the first one.
  //
  // The SELECTION wins because clicking a timeline track and clicking a stage
  // on the board have to agree about what is being edited - a separate "current
  // system" the author sets by hand would let the two disagree. The pin exists
  // for the case the selection cannot answer: an operator, a note, or nothing
  // at all belongs to no system, and the board must not blank.
  //
  // Clamped to a system that still EXISTS, or deleting the one being viewed
  // would leave an empty board with no way back.
  const activeSystemId = useMemo(() => {
    const ids = doc.systems.map(system => system.id)
    const fromSelection = systemIdForSelection(doc, selection)
    if (fromSelection) return fromSelection
    if (pinnedSystemId && ids.includes(pinnedSystemId)) return pinnedSystemId
    return ids[0] || null
  }, [doc, selection, pinnedSystemId])

  // The emitter wireframes. Derived from the DOCUMENT rather than from the IR,
  // because the author is asking about the shape they typed - and the compiler
  // has already folded a constant radius into an index by the time the IR sees
  // it. The mesh slot is resolved here because this is the only layer that
  // knows how references work.
  const gizmos = useMemo(() => (showEmitters
    ? emitterGizmos(doc).map(gizmo => (gizmo.kind === 'mesh'
      ? { ...gizmo, assetId: gizmoMeshAssetId(doc, gizmo.slot) }
      : gizmo))
    : EMPTY_GIZMOS
  ), [doc, showEmitters])

  const diagnosticIndex = useMemo(
    () => indexDiagnostics(compiled.diagnostics),
    [compiled.diagnostics],
  )

  const summary = useMemo(() => summarizeDiagnostics(compiled.diagnostics, {
    peakParticles: compiled.stats.peakParticles,
    drawCalls: compiled.stats.drawCalls,
    engines: compiled.stats.engines,
  }), [compiled])

  const bounds = useMemo(() => ({
    min: compiled.ir.effect.boundsMin,
    max: compiled.ir.effect.boundsMax,
  }), [compiled])

  // Mute and solo pushed at the live runtime rather than into the document.
  // Keyed on the runtime as well as the flags so a recompile - which builds a
  // fresh runtime - reapplies them instead of silently losing them.
  useEffect(() => {
    if (!runtime) return
    for (const system of doc.systems) {
      const state = preview[system.id] || {}
      setSystemState(runtime, system.id, {
        muted: Boolean(state.muted),
        solo: Boolean(state.solo),
      })
    }
  }, [doc.systems, preview, runtime])

  useEffect(() => {
    try {
      window.localStorage.setItem(LEVEL_KEY, level)
    } catch {
      // Storage blocked. The level still applies for this session.
    }
  }, [level])

  // Once the effect has loaded, drop the id from the URL so a reload does not
  // re-open it over unsaved work. Only after a SUCCESSFUL load - leaving it in
  // place on failure keeps the link intact to retry, which is the same
  // reasoning as TreeGenPage.jsx:407.
  useEffect(() => {
    if (!urlAssetId || status === 'loading' || status === 'error') return
    if (assetId == null) return
    const next = new URLSearchParams(searchParams)
    next.delete('vfxAssetId')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlAssetId, status, assetId])

  // --- the action bundle ---------------------------------------------------
  //
  // One object, memoised, holding every edit the board, the panel and the
  // timeline can perform. Each entry is `commit(edits.something(...), meta)` -
  // so every change in the editor is one pure function plus one history entry,
  // and a diagnostic's one-click fix is indistinguishable from doing it by hand.

  const actions = useMemo(() => {
    const edit = (fn, label, meta = {}) => commit(current => fn(current), { label, ...meta })

    return {
      // selection
      select: blockId => setSelection(blockId ? { kind: 'block', id: blockId } : null),
      // `{kind: 'effect'}` matches nothing in the document on purpose:
      // VfxParamsPanel falls back to EffectParams for a selection it cannot
      // resolve, which is where duration, loop, capacity, seed and bounds live.
      selectEffect: () => setSelection({ kind: 'effect', id: 'effect' }),
      selectContext: contextId => setSelection({ kind: 'context', id: contextId }),
      selectSystem: systemId => setSelection({ kind: 'system', id: systemId }),
      selectOperator: nodeId => setSelection({ kind: 'operator', id: nodeId }),
      toggleExpanded: blockId => setExpanded(current => ({
        ...current,
        [blockId]: !current[blockId],
      })),

      // blocks
      // `blockType`, not `type`: that is the key addBlock reads, and it is also
      // the key the diagnostics' addBlock fixes use, so the two paths stay
      // identical. Passing the wrong name made the button a silent no-op,
      // because addBlock returns the document unchanged when it cannot resolve
      // the type.
      addBlock: (contextId, blockType) => edit(
        d => edits.addBlock(d, { contextId, blockType }),
        'Add block',
      ),
      remove: blockId => {
        edit(d => edits.removeBlock(d, blockId), 'Delete block')
        setSelection(current => (current?.id === blockId ? null : current))
      },
      duplicate: blockId => edit(d => edits.duplicateBlock(d, blockId), 'Duplicate block'),
      toggleEnabled: blockId => edit(d => edits.toggleBlock(d, blockId), 'Toggle block'),
      moveBlock: (blockId, toIndex) => edit(
        d => edits.moveBlock(d, blockId, { toIndex }),
        'Reorder blocks',
      ),

      // properties. `meta.coalesceKey` arrives from VfxDragNumber's live path
      // and is what collapses a whole drag into one undo entry.
      setProp: (blockId, prop, value, meta = {}) => commit(
        d => edits.setBlockProp(d, blockId, prop, value),
        {
          label: 'Change setting',
          coalesceKey: meta.coalesceKey ? `${blockId}:${meta.coalesceKey}` : null,
        },
      ),
      setMode: (blockId, prop, mode) => edit(
        d => edits.setBlockPropMode(d, blockId, prop, mode),
        'Change value mode',
      ),
      setCurvePreset: (blockId, prop, presetId) => edit(
        d => edits.setCurvePreset(d, blockId, prop, presetId),
        'Change curve',
      ),
      setGradientPreset: (blockId, prop, presetId) => edit(
        d => edits.setGradientPreset(d, blockId, prop, presetId),
        'Change gradient',
      ),
      setBlockMode: (blockId, mode, value) => edit(
        d => edits.setBlockMode(d, blockId, mode, value),
        'Change mode',
      ),

      // contexts and systems
      setContextParam: (contextId, param, value) => edit(
        d => edits.setContextParam(d, contextId, param, value),
        'Change stage setting',
      ),
      addContext: (systemId, kind) => edit(
        d => edits.addContext(d, systemId, kind),
        'Add stage',
      ),
      removeContext: contextId => {
        edit(d => edits.removeContext(d, contextId), 'Remove stage')
        setSelection(current => (current?.id === contextId ? null : current))
      },
      addSystem: () => edit(d => edits.addSystem(d), 'Add system'),
      removeSystem: systemId => {
        edit(d => edits.removeSystem(d, systemId), 'Delete system')
        setSelection(current => (current?.id === systemId ? null : current))
      },
      duplicateSystem: systemId => edit(d => edits.duplicateSystem(d, systemId), 'Duplicate system'),
      updateSystem: (systemId, patch) => {
        // Mute and solo never reach the document - see the page header.
        if ('enabled' in patch || 'solo' in patch) {
          setPreview(current => {
            const existing = current[systemId] || {}
            return {
              ...current,
              [systemId]: {
                ...existing,
                ...('enabled' in patch ? { muted: !patch.enabled } : {}),
                ...('solo' in patch ? { solo: patch.solo } : {}),
              },
            }
          })
          const rest = { ...patch }
          delete rest.enabled
          delete rest.solo
          if (Object.keys(rest).length === 0) return
          edit(d => edits.updateSystem(d, systemId, rest), 'Change system')
          return
        }
        edit(d => edits.updateSystem(d, systemId, patch), 'Change system')
      },

      // clips
      addClip: (systemId, spec) => edit(d => edits.addClip(d, systemId, spec), 'Add clip'),
      // No coalesce key: a clip drag is DOM-direct and commits exactly once on
      // release, so a key here would merge two DELIBERATE consecutive retimes
      // rather than the frames of one drag.
      updateClip: (systemId, clipId, patch) => edit(
        d => edits.updateClip(d, systemId, clipId, patch),
        patch.loop === undefined ? 'Retime clip' : 'Loop clip',
      ),
      removeClip: (systemId, clipId) => edit(
        d => edits.removeClip(d, systemId, clipId),
        'Delete clip',
      ),
      setEffectSettings: patch => edit(d => edits.setEffectSettings(d, patch), 'Change effect'),

      // operators and wiring
      addOperator: (type, position) => edit(
        d => edits.addOperator(d, type, position),
        'Add value node',
      ),
      removeOperator: nodeId => {
        edit(d => edits.removeOperator(d, nodeId), 'Delete value node')
        setSelection(current => (current?.id === nodeId ? null : current))
      },
      setOperatorProp: (nodeId, prop, value, meta = {}) => commit(
        d => edits.setOperatorProp(d, nodeId, prop, value),
        {
          label: 'Change value',
          coalesceKey: meta.coalesceKey ? `${nodeId}:${meta.coalesceKey}` : null,
        },
      ),
      setOperatorMode: (nodeId, mode, value) => edit(
        d => edits.setOperatorMode(d, nodeId, mode, value),
        'Change value node',
      ),
      wire: (fromNodeId, blockId, prop) => edit(
        d => edits.addEdge(d, { fromNodeId, blockId, prop }),
        'Connect',
      ),
      removeEdge: edgeId => edit(d => edits.removeEdge(d, edgeId), 'Disconnect'),
      unwire: (blockId, prop) => edit(d => edits.unwireProp(d, blockId, prop), 'Disconnect'),

      // layout. No undo label and a coalesce key: moving a node is cosmetic,
      // and `layout` is the one part of the document the compiler never reads.
      moveNode: (nodeId, position) => commit(
        d => setNodePosition(d, nodeId, position),
        { coalesceKey: `layout:${nodeId}` },
      ),
      // The measurer comes from the board, which is the only place that knows
      // how tall a node actually rendered. Without one it falls back to
      // forgetting the stored positions, which returns the board to the tidy
      // DERIVED layout - correct, just not packed.
      tidy: measure => edit(
        d => (measure ? autoLayout(d, measure) : clearLayout(d)),
        'Tidy layout',
      ),
      // setEffectSettings with a COALESCE KEY, which is the whole difference:
      // the panel's own duration field goes through edit() and earns an undo
      // entry per keystroke, which is right for a field you visit once. The
      // timeline total is typed and retyped while judging the length, so it
      // folds into one entry.
      setEffectDuration: seconds => commit(
        d => edits.setEffectSettings(d, { duration: Math.min(600, Math.max(0.05, seconds)) }),
        { label: 'Change duration', coalesceKey: 'effect:duration' },
      ),
      // ONE ENTRY FOR THE WHOLE SHEET. It touches up to three blocks across two
      // stages, and an author setting a 4x4 grid performed one action, not five.
      setSystemTexture: (systemId, asset) => edit(
        d => edits.setSystemTexture(d, systemId, asset),
        'Set sprite texture',
      ),
      setSpriteSheet: (systemId, spec) => edit(
        d => edits.setSpriteSheet(d, systemId, spec),
        'Set sprite sheet',
      ),
      addNote: position => edit(
        d => edits.addNote(d, { x: position?.x ?? 0, y: position?.y ?? 0 }),
        'Add note',
      ),
      // Coalesced on the note's id: typing a sentence is one undo entry, and so
      // is one resize drag.
      updateNote: (noteId, patch) => commit(
        d => edits.updateNote(d, noteId, patch),
        { label: 'Edit note', coalesceKey: `note:${noteId}` },
      ),
      removeNote: noteId => edit(d => edits.removeNote(d, noteId), 'Delete note'),

      // assets
      pickAsset: (blockId, prop, type) => setPicker({ blockId, prop, type }),

      // diagnostics
      //
      // canOfferFix, not canApplyFix: a fix that opens the asset picker cannot
      // be a pure doc -> doc applier, and asking the wrong question is what
      // left "Choose a sprite..." greyed out on every effect using the built-in
      // blob. The two kinds are dispatched apart below.
      canFix: fix => edits.canOfferFix(fix),
      applyFix: diagnostic => {
        const fix = diagnostic?.fix
        if (edits.fixNeedsInput(fix)) {
          const args = fix.args || {}
          setPicker({
            blockId: args.blockId || null,
            prop: args.prop || null,
            // A missing-asset fix names the SLOT instead of a block property -
            // the reference is what is broken, and the slot key has to survive
            // so the block still points at it.
            slot: args.slot || null,
            type: args.assetType === 'mesh' ? PROP_TYPE.MESH : PROP_TYPE.TEXTURE,
          })
          return
        }
        edit(d => edits.applyFix(d, fix), fix?.label || 'Apply fix')
      },
    }
  }, [commit])

  // --- asset picker --------------------------------------------------------

  const handlePickAsset = useCallback(asset => {
    if (!picker || !asset) return
    // THE SAME FUNCTION THE RESOLVER USES, deliberately. A root's listing id is
    // `library:<n>` and an EDIT's is a bare number, so hand-parsing here while
    // the resolver indexed by vfxAssetId is how a picked asset could be written
    // under an id nothing could look up again.
    const numericId = vfxAssetId(asset)
    if (numericId == null) return

    // The slot key is derived from the block and property rather than from the
    // asset, so re-picking replaces the reference instead of accumulating
    // slots - and the graph keeps pointing at a stable key. Blocks name slots,
    // never asset ids; one table resolves them, which is what makes project
    // import able to remap a whole effect in one place.
    // An EXISTING slot key is reused verbatim when the picker was opened to
    // repair a dangling reference: the block already points at that key, so
    // minting a new one would leave the block pointing at the broken slot and
    // silently add a second, unused entry.
    const slot = picker.slot
      || `${picker.type === PROP_TYPE.MESH ? 'mesh' : 'tex'}_${picker.blockId}_${picker.prop}`
    const entry = {
      kind: picker.type === PROP_TYPE.MESH ? REF_KIND.MESH : REF_KIND.IMAGE,
      ref: formatAssetRef(numericId),
      name: asset.name || '',
      colorSpace: 'srgb',
    }
    commit(
      d => {
        const withRef = edits.setAssetReference(d, slot, entry)
        return picker.slot
          ? withRef
          : edits.setBlockAssetSlot(withRef, picker.blockId, picker.prop, slot)
      },
      { label: 'Choose asset' },
    )
    setPicker(null)
  }, [commit, picker])

  // Resolved asset names, so a texture row reads "spark.png" rather than
  // "tex_blk3_texture". Built per document rather than per row.
  const fieldProps = useMemo(() => {
    // Shared with the resolver, so a texture row cannot show a raw slot key for
    // an asset the runtime found perfectly well - which is what happened for
    // every image EDIT, since this map was built from roots only.
    const byId = indexLibraryAssets([...libraryImages, ...libraryMeshes])
    const out = {}
    for (const system of doc.systems) {
      for (const context of system.contexts) {
        for (const block of context.blocks) {
          for (const [prop, value] of Object.entries(block.props || {})) {
            const slot = typeof value?.v === 'string' ? value.v : null
            if (!slot) continue
            const ref = doc.references?.[slot]
            if (!ref) continue
            const match = /^asset:(\d+)$/.exec(ref.ref || '')
            const asset = match ? byId.get(Number(match[1])) : null
            out[block.id] = out[block.id] || {}
            out[block.id][prop] = { assetLabel: asset?.name || ref.name || slot }
          }
        }
      }
    }
    return out
  }, [doc, libraryImages, libraryMeshes])

  // --- transport -----------------------------------------------------------

  const restart = useCallback(() => {
    if (runtimeRef.current) reset(runtimeRef.current)
  }, [])

  const stepOnce = useCallback(() => {
    const current = runtimeRef.current
    if (!current) return
    setPlaying(false)
    seekTo(current, current.time + current.ir.effect.fixedDt)
  }, [])

  const seek = useCallback(seconds => {
    const current = runtimeRef.current
    if (!current) return
    setPlaying(false)
    seekTo(current, Math.max(0, seconds))
  }, [])

  // Read per frame by the timeline's playhead loop. A function rather than a
  // number, so the playhead can be smooth without the page re-rendering.
  const getTime = useCallback(() => runtimeRef.current?.time || 0, [])

  // Stable, so publishing the camera does not re-run VfxSystemView's effect on
  // every render of this page.
  const handleCamera = useCallback(camera => {
    cameraRef.current = camera
  }, [])

  // Where the running simulation currently is, for an open curve editor to draw
  // on its graph.
  //
  // TWO DIFFERENT ANSWERS, because "over life" and "over effect time" are
  // different axes. Effect time has exactly one position, so it is one line.
  // Particle life does NOT - every living particle is at a different point on
  // the curve - so this hands back a sample of their normalised ages and the
  // editor draws a tick each. Watching that population sweep left to right is
  // the single best teaching device in the editor: it makes the curve and the
  // effect visibly the same object.
  //
  // Called from the editor's own rAF loop, so it must allocate as little as
  // possible and never touch React. The sample array is reused.
  const agesRef = useRef(new Float32Array(PLAYHEAD_SAMPLES))
  const getCurvePlayhead = useCallback(() => {
    const current = runtimeRef.current
    if (!current) return null
    const duration = current.ir.effect.duration || 1
    const ages = agesRef.current
    let written = 0
    for (const emitter of current.emitters) {
      const { planes, count } = emitter.pool
      if (!planes.age || !planes.lifetime) continue
      // Strided rather than truncated: taking the first N particles would
      // sample only the oldest, because the pool is compacted by swap-remove
      // and the newest are at the end. A stride shows the whole population.
      const stride = Math.max(1, Math.ceil(count / PLAYHEAD_SAMPLES))
      for (let i = 0; i < count && written < ages.length; i += stride) {
        const lifetime = planes.lifetime[i]
        ages[written] = lifetime > 0 ? planes.age[i] / lifetime : 0
        written += 1
      }
    }
    return {
      t: (current.time % duration) / duration,
      ages: written > 0 ? ages.subarray(0, written) : null,
    }
  }, [])

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = event => {
      const target = event.target
      const typing = target instanceof HTMLElement && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      )

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        const entry = event.shiftKey ? redo() : undo()
        // Reveal what the undo changed. Undoing something you cannot see is the
        // classic graph-editor failure, so the entry carries a node id and the
        // board pans to it.
        if (entry?.focusNodeId && flowRef.current) {
          try {
            flowRef.current.fitView({ nodes: [{ id: entry.focusNodeId }], duration: 300, maxZoom: 1 })
          } catch {
            // The node is gone (an undo of an add). Nothing to reveal.
          }
        }
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (typing) return
      if (event.code === 'Space') {
        event.preventDefault()
        setPlaying(current => !current)
        return
      }
      // `?` opens the sheet, Escape closes whatever is open. Checked before the
      // selection clear so Escape does not do both at once.
      if (event.key === '?') {
        event.preventDefault()
        setShortcutsOpen(current => !current)
        return
      }
      if (event.key === 'Escape') {
        setShortcutsOpen(false)
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [redo, undo])

  // The verbs the empty-preview overlay can offer that are not document edits.
  // Kept here rather than in the overlay because every one of them is page
  // state the overlay has no business owning.
  const handleBlameAction = useCallback(action => {
    if (action === BLAME_ACTION.PLAY) setPlaying(true)
    else if (action === BLAME_ACTION.RESTART) {
      restart()
      setPlaying(true)
    } else if (action === BLAME_ACTION.FRAME) setFrameNonce(current => current + 1)
    else if (action === BLAME_ACTION.UNMUTE) setPreview({})
  }, [restart])

  // --- snapshot -------------------------------------------------------------

  // Download the frame on screen as a PNG.
  //
  // WHY THIS EXISTS: the preset library's bulk thumbnail pass renders from a
  // SIMULATED frame at a fixed time, and for a good number of effects that time
  // is simply wrong - a one-shot burst has already died, a slow plume has not
  // arrived yet - so the card comes out black. No fixed time works for
  // fifty-three effects with lifetimes from 0.07s to seven seconds.
  //
  // Choosing the frame is a judgement, so this hands it to the author: scrub to
  // where the effect looks best, orbit to the angle you want, press Snapshot.
  // It is the same renderer the card uses (square, 512px, no grid or gizmos),
  // so what lands in the file is what the card will look like.
  const handleSnapshot = async () => {
    // A REPORT, NOT A FALLBACK. createVfxThumbnailFile falls back to a
    // simulated frame when nothing is alive, which is right for a save but
    // wrong here: the author asked for THIS frame, and silently handing them
    // another black PNG is exactly the black-card problem again.
    // useVfxRuntime returns null until the effect has compiled and its assets
    // have loaded, and aliveCount reads runtime.emitters straight off it.
    if (!runtime || aliveCount(runtime) === 0) {
      notify('Nothing is alive at this frame - play the effect and pause where it looks best.', 'error')
      return
    }
    let file
    try {
      file = await createVfxThumbnailFile(compiled.ir, {
        name,
        runtime,
        camera: cameraRef.current,
        textures,
        meshes,
      })
    } catch (err) {
      notify(err?.message || 'Could not render the snapshot.', 'error')
      return
    }
    // Named the way resources/vfx/thumbnails/ expects, so a snapshot of a
    // preset-derived effect can be dropped straight in without renaming.
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'effect'
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = `${slug}.png`
    link.click()
    URL.revokeObjectURL(url)
    notify(`Saved ${slug}.png`, 'success')
  }

  // --- save ----------------------------------------------------------------

  const handleSave = async ({ saveAs = false } = {}) => {
    let thumbnail = null
    try {
      // THE CARD IS THE FRAME ON SCREEN. Passing the live runtime and camera
      // means the author picks the thumbnail by pausing the timeline where the
      // effect looks best and orbiting to the angle they want - which is a
      // judgement only they can make. It falls back to a simulated frame when
      // nothing is alive (t=0, or after a burst has died), because silently
      // saving an empty card would read as the feature being broken.
      thumbnail = await createVfxThumbnailFile(compiled.ir, {
        name,
        runtime,
        camera: cameraRef.current,
        textures,
        meshes,
      })
    } catch {
      // Always best-effort. Losing the save over a cosmetic render would be
      // the wrong trade; the house rule is at TreeGenPage.jsx:622.
    }
    try {
      const saved = await save({ saveAs, thumbnail })
      notify(saveAs ? `Saved "${name}" as a new effect` : `Saved "${name}"`, 'success')
      return saved
    } catch {
      return null
    }
  }

  // How many systems are currently silenced, which is the overlay's way of
  // telling "the graph is broken" apart from "you left a solo on". Solo wins:
  // when anything is soloed, everything else is silenced.
  const anySolo = doc.systems.some(system => preview[system.id]?.solo)
  const mutedCount = doc.systems.filter(system => (
    anySolo ? !preview[system.id]?.solo : Boolean(preview[system.id]?.muted)
  )).length

  const saveLabel = status === 'saving' ? 'Saving...' : assetId == null ? 'Save to library' : 'Save'
  // `{kind: 'effect'}` resolves to nothing in the document, and VfxParamsPanel
  // falls back to EffectParams for exactly that case - which is how duration,
  // looping, capacity, the seed and the bounds are edited.
  //
  // IT USED TO BE UNREACHABLE. The panel renders only when something is
  // selected and nothing could select the effect, so every one of those fields
  // was dead UI - which is why the timeline appeared to be stuck at 3 seconds.
  const paramsOpen = selection != null
  const selectionDiagnostics = selection
    ? (diagnosticIndex.get(selection.id) || [])
    : []

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

        <div className="vfx-page__history">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            title={canUndo ? `Undo ${undoLabel}` : 'Nothing to undo'}
            aria-label="Undo"
          >
            <span className="material-symbols-outlined">undo</span>
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            title={canRedo ? `Redo ${redoLabel}` : 'Nothing to redo'}
            aria-label="Redo"
          >
            <span className="material-symbols-outlined">redo</span>
          </button>
        </div>

        <div className="vfx-page__save">
          <button
            type="button"
            onClick={() => handleSave()}
            disabled={status === 'saving'}
            title="Saves the effect. The library card is a picture of the frame on screen right now - pause the timeline where it looks best first."
          >
            {saveLabel}
          </button>
          {assetId != null && (
            <button
              type="button"
              className="is-quiet"
              onClick={() => handleSave({ saveAs: true })}
              disabled={status === 'saving'}
              title="Saves a separate copy, leaving the original untouched. The card is the frame on screen."
            >
              Save as new
            </button>
          )}
          {/* SAVED EFFECTS ONLY. The bundle is built from the FILE on the
              server, so there is nothing to export until the document has been
              written - offering it on an unsaved effect would export the last
              saved state and look like the button ignoring recent edits. */}
          {assetId != null && (
            <button
              type="button"
              className="is-quiet"
              onClick={() => setExporting(true)}
              disabled={status === 'saving' || dirty}
              title={dirty
                ? 'Save first - the bundle is built from the saved file, not from what is on screen.'
                : 'Write an engine bundle: the graph, the compiled IR, the compatibility table and every texture and mesh this effect uses.'}
            >
              Export...
            </button>
          )}
          {/* The starter library. This replaced a row of twelve buttons
              wired to in-code templates: fifty-odd effects do not fit in a
              toolbar, and the ones worth having are the ones nobody has
              written yet - so the library is FILES, browsable and searchable,
              and adding to it is not a code change. */}
          <button
            type="button"
            className="is-quiet"
            onClick={() => setPresetsOpen(true)}
            title="Browse ready-made effects and open one"
          >
            VFX Presets...
          </button>
          {/* Generating a sprite needs a system to give it to, and the board
              already tracks which one is being edited - so this follows the
              board rather than asking again. */}
          <button
            type="button"
            className="is-quiet"
            onClick={() => setSpriteOpen(true)}
            disabled={!activeSystemId}
            title="Generate a particle sprite with ComfyUI and wire it into this system"
          >
            Sprite...
          </button>
          <button
            type="button"
            className="is-quiet"
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <span className="material-symbols-outlined">keyboard</span>
          </button>
          <button
            type="button"
            className="is-quiet"
            onClick={handleSnapshot}
            title="Download the current frame as a PNG, framed the way a preset card is"
            aria-label="Snapshot the current frame"
          >
            <span className="material-symbols-outlined">photo_camera</span>
          </button>
          <span className={`vfx-page__status is-${dirty ? 'dirty' : status}`}>
            {status === 'loading' ? 'Opening...'
              : status === 'saving' ? 'Saving...'
                : dirty ? 'Unsaved changes'
                  : status === 'saved' ? 'Saved' : ''}
          </span>
        </div>

        <div className="vfx-page__toggles">
          <label>
            <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />
            Grid
          </label>
          <label title="A 1.8 m capsule and a 1 m cube, to judge scale against. They are references, not emitters, and never export.">
            <input type="checkbox" checked={showScale} onChange={e => setShowScale(e.target.checked)} />
            Scale
          </label>
          <label title="Draw every system's emitter shape in wireframe - where particles are born, before anything moves them.">
            <input type="checkbox" checked={showEmitters} onChange={e => setShowEmitters(e.target.checked)} />
            Emitters
          </label>
          <label title="The alive / spawned / dropped and timing panel over the preview.">
            <input type="checkbox" checked={showStats} onChange={e => setShowStats(e.target.checked)} />
            Stats
          </label>
          <label>
            <input type="checkbox" checked={orthographic} onChange={e => setOrthographic(e.target.checked)} />
            Ortho
          </label>
          <label title="Per-kernel timing. Adds a little overhead of its own.">
            <input type="checkbox" checked={profile} onChange={e => setProfile(e.target.checked)} />
            Profile
          </label>
          {/* Labelled "Detail" rather than beginner/advanced: a developer will
              pick the wrong one out of pride. */}
          <select
            value={level}
            onChange={e => setLevel(e.target.value)}
            title="How much the editor shows. Guided offers only the blocks you need to start."
          >
            <option value="guided">Detail: guided</option>
            <option value="standard">Detail: standard</option>
            <option value="full">Detail: full</option>
          </select>
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

      <div
        className={`vfx-page__body${paramsOpen ? ' has-params' : ''}`}
        ref={bodyRef}
        style={{
          '--vfx-params-w': paramsOpen ? `${paramsWidth}px` : '0px',
          '--vfx-preview-w': `${previewWidth}px`,
        }}
      >
        <div className="vfx-page__params">
          {/* Mounted only when open, but the TRACK always exists - that is what
              makes the transition one custom-property write and leaves the
              canvas alone. */}
          {paramsOpen && (
            <VfxParamsPanel
              doc={doc}
              selection={selection}
              actions={actions}
              fieldProps={fieldProps}
              diagnostics={selectionDiagnostics}
              level={level}
              getCurvePlayhead={getCurvePlayhead}
              onClose={() => setSelection(null)}
            />
          )}
        </div>

        {/* The class is what places this in the grid. Without an explicit
            column every item after a conditionally-rendered one lands in the
            wrong track - see the note on .vfx-page__body. */}
        {paramsOpen && (
          <VfxSplitter
            className="vfx-page__gutter-params"
            orientation="vertical"
            targetRef={bodyRef}
            variable="--vfx-params-w"
            value={paramsWidth}
            onCommit={setParamsWidth}
            min={220}
            max={520}
            defaultValue={PARAMS_DEFAULT}
            storageKey={PARAMS_KEY}
            label="Resize the parameters pane"
          />
        )}

        <div className="vfx-page__board">
          {/* The provider is above <ReactFlow> so VfxBoard can call
              useReactFlow itself, and so the page can hold the instance. */}
          <ReactFlowProvider>
            <VfxBoard
              doc={doc}
              diagnosticIndex={diagnosticIndex}
              actions={actions}
              expanded={expanded}
              fieldProps={fieldProps}
              selectedBlockId={selection?.kind === 'block' ? selection.id : null}
              selectedContextId={selection?.kind === 'context' ? selection.id : null}
              selectedOperatorId={selection?.kind === 'operator' ? selection.id : null}
              systemId={activeSystemId}
              onSystemChange={setPinnedSystemId}
              engineTarget={engineTarget || null}
              level={level}
              onInit={instance => { flowRef.current = instance }}
            />
          </ReactFlowProvider>

          {/* Pinned inside the board pane, above the timeline, so the two never
              fight for the same edge and the strip never covers the canvas. */}
          <div className={`vfx-page__diagnostics is-${summary.tone}`}>
            <div className="vfx-page__diagnostics-summary">
              <span className="material-symbols-outlined">
                {summary.tone === 'ok' ? 'check_circle' : SEVERITY_ICON[summary.tone] || 'info'}
              </span>
              {summary.text}
            </div>
            {/* A LOAD failure, which no compile diagnostic can see: the
                compiler is pure and knows nothing about whether the bytes
                arrived. Reported here rather than left to the built-in sprite
                fallback, which is correct behaviour and a terrible explanation. */}
            {failedAssets.length > 0 && (
              <ul className="vfx-page__diagnostics-list">
                {failedAssets.map(entry => (
                  <li key={`${entry.kind}-${entry.assetId}`} className="is-warn">
                    <span className="material-symbols-outlined">broken_image</span>
                    <span className="vfx-page__diagnostics-text">
                      The {entry.kind} “{assetLabelFor(doc, entry.assetId)}” could not be loaded,
                      so {entry.kind === 'mesh' ? 'that emitter is spawning at a point' : 'the built-in sprite is being drawn'} instead.
                      It may have been deleted from the library.
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {compiled.diagnostics.length > 0 && (
              <ul className="vfx-page__diagnostics-list">
                {compiled.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`} className={`is-${diagnostic.severity}`}>
                    <span className="material-symbols-outlined">
                      {SEVERITY_ICON[diagnostic.severity] || 'info'}
                    </span>
                    <button
                      type="button"
                      className="vfx-page__diagnostics-text"
                      onClick={() => {
                        const id = diagnostic.target?.blockId
                          || diagnostic.target?.contextId
                          || diagnostic.target?.systemId
                          || diagnostic.target?.nodeId
                        if (!id) return
                        setSelection({
                          kind: diagnostic.target?.blockId ? 'block'
                            : diagnostic.target?.contextId ? 'context'
                              : diagnostic.target?.systemId ? 'system' : 'operator',
                          id,
                        })
                      }}
                      title="Show the thing this is about"
                    >
                      <strong>{diagnostic.title}</strong>
                      {' '}
                      {diagnostic.message}
                      {diagnostic.hint && <em> {diagnostic.hint}</em>}
                    </button>
                    {diagnostic.fix && (
                      <button
                        type="button"
                        className="vfx-page__diagnostics-fix"
                        onClick={() => actions.applyFix(diagnostic)}
                        disabled={!edits.canOfferFix(diagnostic.fix)}
                        title={edits.fixNeedsInput(diagnostic.fix)
                          ? 'Opens a chooser. Your pick becomes one undo step.'
                          : 'Apply this fix. It becomes one undo step.'}
                      >
                        {diagnostic.fix.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <VfxSplitter
          className="vfx-page__gutter-preview"
          orientation="vertical"
          targetRef={bodyRef}
          variable="--vfx-preview-w"
          value={previewWidth}
          onCommit={setPreviewWidth}
          min={300}
          max={900}
          defaultValue={PREVIEW_DEFAULT}
          storageKey={PREVIEW_KEY}
          invert
          label="Resize the preview pane"
        />

        <div className="vfx-page__viewport">
          <VfxViewport
            runtime={runtime}
            batches={batches}
            playing={playing}
            timescale={timescale}
            statsRef={statsRef}
            orthographic={orthographic}
            showGrid={showGrid}
            showScale={showScale}
            showEmitters={showEmitters}
            gizmos={gizmos}
            meshes={meshes}
            bounds={bounds}
            frameKey={`${compiled.ir.graphHash}:${frameNonce}`}
            onCamera={handleCamera}
          />
          {showStats && <VfxPreviewHud statsRef={statsRef} showKernels={profile} />}
          {/* "The preview never fails silently." Names the first
              render-blocking cause in causal order after a grace period, and
              distinguishes "nothing is produced" from "it is off screen" -
              which look identical and have opposite fixes. */}
          <VfxEmptyOverlay
            statsRef={statsRef}
            runtime={runtime}
            cameraRef={cameraRef}
            diagnostics={compiled.diagnostics}
            playing={playing}
            mutedSystems={mutedCount}
            totalSystems={doc.systems.length}
            onAction={handleBlameAction}
            onFix={fix => actions.applyFix({ fix })}
            canFix={edits.canOfferFix}
          />
        </div>
      </div>

      <VfxTimeline
        doc={doc}
        actions={actions}
        playing={playing}
        onTogglePlay={() => setPlaying(current => !current)}
        onRestart={restart}
        onStep={stepOnce}
        onSeek={seek}
        getTime={getTime}
        timescale={timescale}
        onTimescale={setTimescale}
        preview={preview}
        selectedSystemId={selection?.kind === 'system' ? selection.id : null}
        collapsed={timelineCollapsed}
        onToggleCollapsed={() => setTimelineCollapsed(current => !current)}
      />

      {shortcutsOpen && <VfxShortcuts onClose={() => setShortcutsOpen(false)} />}

      {presetsOpen && (
        <VfxPresetsDialog
          onClose={() => setPresetsOpen(false)}
          dirty={dirty}
          currentDoc={doc}
          currentName={name}
          onOpen={preset => {
            loadTemplate(preset)
            setSelection(null)
            setExpanded({})
          }}
        />
      )}

      {spriteOpen && (
        <VfxSpritePanel
          systemId={activeSystemId}
          systemName={doc.systems.find(s => s.id === activeSystemId)?.name || ''}
          onGenerated={asset => actions.setSystemTexture(activeSystemId, asset)}
          onClose={() => setSpriteOpen(false)}
        />
      )}

      {exporting && (
        <VfxExportDialog assetId={assetId} name={name} onClose={() => setExporting(false)} />
      )}

      {picker && (
        <AssetSelectorModal
          assetType={picker.type === PROP_TYPE.MESH ? 'mesh' : 'image'}
          title={picker.type === PROP_TYPE.MESH ? 'Choose a mesh' : 'Choose a sprite texture'}
          // EDITS AND VERSIONS ARE SELECTABLE. They default to hidden in the
          // modal, so the picker offered only root images - and a sprite is very
          // often an edit rather than the original: the generated image cropped,
          // background removed, or channels adjusted. Each one is its own Assets
          // row with its own id, so `asset:<id>` references it exactly like a
          // root and project export/import carries it with no extra work.
          showEdits
          onSelect={handlePickAsset}
          onClose={() => setPicker(null)}
        />
      )}

      <Footer variant="kanban" />
    </div>
  )
}
