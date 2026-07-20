import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import BoardSwitcher from '../components/board/BoardSwitcher'
import BoardAiPanel from '../components/board/BoardAiPanel'
import { useProjects } from '../context/ProjectContext'
import { assetUrl } from '../config'
import {
  sanitizeBoardAppState,
  boardStateSignature,
  urlToDataURL,
  dataURLToFile,
  measureImage,
  mimeFromName,
  extFromMime,
  toServedAssetPath
} from '../utils/boardHelpers'
import './BoardPage.css'

const AUTOSAVE_DELAY = 800

export default function BoardPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = searchParams.get('projectId')
  const boardId = searchParams.get('boardId')

  const {
    getProject,
    getProjectBoards,
    getBoard,
    createBoard,
    deleteBoard,
    updateBoard,
    saveBoardState,
    uploadAsset
  } = useProjects()

  const [project, setProject] = useState(null)
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [initialData, setInitialData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  const [saveStatus, setSaveStatus] = useState('idle') // 'idle' | 'saving' | 'saved' | 'error'

  const excalidrawApiRef = useRef(null)
  const bootstrappingRef = useRef(null) // projectId currently being bootstrapped (guards StrictMode double-run)
  const imageRefsRef = useRef({})      // excalidraw fileId -> asset filename (url path)
  const uploadingRef = useRef(new Set())
  const lastSavedSigRef = useRef('')
  const saveTimerRef = useRef(null)
  const latestSceneRef = useRef(null)  // latest { elements, appState } from onChange
  const boardIdRef = useRef(null)      // current boardId, so async saves target the right board

  // ---- Load the project (name for the header) ------------------------------
  useEffect(() => {
    let cancelled = false
    if (!projectId) return undefined
    getProject(projectId)
      .then(data => { if (!cancelled) setProject(data) })
      .catch(() => { if (!cancelled) setProject(null) })
    return () => { cancelled = true }
  }, [projectId, getProject])

  // ---- Load the project's boards + bootstrap a default when empty ----------
  const refreshBoards = useCallback(async () => {
    if (!projectId) return []
    const list = await getProjectBoards(projectId)
    setBoards(list)
    return list
  }, [projectId, getProjectBoards])

  useEffect(() => {
    let cancelled = false
    if (!projectId) return undefined

    ;(async () => {
      try {
        let list = await getProjectBoards(projectId)
        if (cancelled) return

        // No board selected in the URL: open the first, or create one.
        if (!boardId) {
          if (list.length === 0) {
            // Guard against StrictMode's double effect run creating two boards.
            if (bootstrappingRef.current === projectId) return
            bootstrappingRef.current = projectId
            const created = await createBoard(projectId, 'Board 1')
            list = [created]
          }
          if (cancelled) return
          setBoards(list)
          setSearchParams({ projectId, boardId: String(list[0].id) }, { replace: true })
          return
        }

        setBoards(list)
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Failed to load boards')
      }
    })()

    return () => { cancelled = true }
  }, [projectId, boardId, getProjectBoards, createBoard, setSearchParams])

  // ---- Load the selected board + build Excalidraw initialData --------------
  useEffect(() => {
    let cancelled = false
    if (!boardId) return undefined

    setInitialData(null)
    setSaveStatus('idle')
    imageRefsRef.current = {}
    uploadingRef.current = new Set()
    latestSceneRef.current = null
    boardIdRef.current = boardId

    ;(async () => {
      try {
        const data = await getBoard(boardId)
        if (cancelled) return
        setBoard(data)

        const state = data?.state || {}
        const elements = Array.isArray(state.elements) ? state.elements : []
        const appState = sanitizeBoardAppState(state.appState || {})
        const imageRefs = state.imageRefs && typeof state.imageRefs === 'object' ? state.imageRefs : {}
        imageRefsRef.current = { ...imageRefs }

        // Re-hydrate image binaries from their backing assets on disk.
        const files = {}
        await Promise.all(Object.entries(imageRefs).map(async ([fileId, filename]) => {
          try {
            const dataURL = await urlToDataURL(assetUrl(filename))
            files[fileId] = { id: fileId, dataURL, mimeType: mimeFromName(filename), created: Date.now() }
          } catch (err) {
            console.error('Failed to load board image', filename, err)
          }
        }))

        if (cancelled) return
        lastSavedSigRef.current = boardStateSignature(elements, appState)
        setInitialData({ elements, appState, files, scrollToContent: true })
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Failed to load board')
      }
    })()

    return () => { cancelled = true }
  }, [boardId, getBoard])

  // ---- Persist board state (debounced) -------------------------------------
  // Saves from the latest onChange snapshot (falling back to the API) so it
  // never silently no-ops if the API ref hasn't populated yet.
  const persistNow = useCallback(async () => {
    const targetBoardId = boardIdRef.current
    if (!targetBoardId) return

    let elements = latestSceneRef.current?.elements
    let appState = latestSceneRef.current?.appState
    if (!elements) {
      const api = excalidrawApiRef.current
      if (!api) return
      elements = api.getSceneElements()
      appState = api.getAppState()
    }
    elements = (elements || []).filter(el => !el.isDeleted)
    appState = sanitizeBoardAppState(appState || {})

    // Prune image refs whose element no longer exists on the canvas.
    const liveFileIds = new Set(
      elements.filter(el => el.type === 'image' && el.fileId).map(el => el.fileId)
    )
    const imageRefs = {}
    for (const [fileId, filename] of Object.entries(imageRefsRef.current)) {
      if (liveFileIds.has(fileId)) imageRefs[fileId] = filename
    }
    imageRefsRef.current = imageRefs

    setSaveStatus('saving')
    const ok = await saveBoardState(targetBoardId, { elements, appState, imageRefs })
    setSaveStatus(ok ? 'saved' : 'error')
  }, [saveBoardState])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; persistNow() }, AUTOSAVE_DELAY)
  }, [persistNow])

  // ---- Upload pasted/dropped local images so they persist as assets --------
  const backfillLocalImages = useCallback(async (elements, files) => {
    if (!projectId || !files) return
    const imageElements = elements.filter(el => el.type === 'image' && !el.isDeleted && el.fileId)
    for (const el of imageElements) {
      const fileId = el.fileId
      if (imageRefsRef.current[fileId] || uploadingRef.current.has(fileId)) continue
      const file = files[fileId]
      if (!file?.dataURL) continue

      uploadingRef.current.add(fileId)
      try {
        const ext = extFromMime(file.mimeType || 'image/png')
        const uploadFile = dataURLToFile(file.dataURL, `board-${fileId}.${ext}`)
        const asset = await uploadAsset(projectId, uploadFile, 'image', { source: 'board-upload' })
        if (asset?.filename) {
          imageRefsRef.current[fileId] = asset.filename
          scheduleSave()
        }
      } catch (err) {
        console.error('Failed to persist board image upload', err)
      } finally {
        uploadingRef.current.delete(fileId)
      }
    }
  }, [projectId, uploadAsset, scheduleSave])

  const handleChange = useCallback((elements, appState, files) => {
    latestSceneRef.current = { elements, appState }
    const sig = boardStateSignature(elements, appState)
    if (sig === lastSavedSigRef.current) return
    lastSavedSigRef.current = sig
    scheduleSave()
    backfillLocalImages(elements, files)
  }, [scheduleSave, backfillLocalImages])

  // Flush a pending save on unmount / board switch.
  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      persistNow()
    }
  }, [persistNow])

  // Flush on tab hide / close so in-flight edits aren't lost.
  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        persistNow()
      }
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [persistNow])

  // ---- Place an AI-generated (already-saved) asset onto the canvas ---------
  const placeAssetImage = useCallback(async (asset) => {
    const api = excalidrawApiRef.current
    if (!api || !asset) return
    // Edits return a stored filePath (with data/assets/ prefix) and no filename;
    // normalize either to the served path so reload URLs resolve correctly.
    const refPath = asset.filename || (asset.filePath ? toServedAssetPath(asset.filePath) : null)
    try {
      // ComfyUI results carry an absolute `url`; external-API/persisted assets
      // resolve from their served filename. Either way we render from a data URL.
      const src = (typeof asset.url === 'string' && /^(https?:|data:)/i.test(asset.url))
        ? asset.url
        : (refPath ? assetUrl(refPath) : null)
      if (!src) return
      const dataURL = src.startsWith('data:') ? src : await urlToDataURL(src)
      const fileId = `board-asset-${asset.id || Date.now()}`
      api.addFiles([{ id: fileId, dataURL, mimeType: mimeFromName(refPath || 'image.png'), created: Date.now() }])

      // Cap on-canvas size to a usable footprint regardless of render size.
      const { width, height } = await measureImage(dataURL)

      const st = api.getAppState()
      const zoom = st.zoom?.value || 1
      const centerX = (st.width / 2) / zoom - st.scrollX
      const centerY = (st.height / 2) / zoom - st.scrollY

      const skeleton = {
        type: 'image',
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
        fileId
      }
      const newElements = convertToExcalidrawElements([skeleton])
      api.updateScene({ elements: [...api.getSceneElements(), ...newElements] })

      // Only persist a ref when the image is backed by a served asset file
      // (so it re-hydrates on reload); pure data-URL results won't be.
      if (refPath) imageRefsRef.current[fileId] = refPath
      // updateScene triggers onChange → scheduleSave; nudge it explicitly too.
      scheduleSave()
    } catch (err) {
      console.error('Failed to place generated image on board', err)
    }
  }, [scheduleSave])

  const handleBoardsChanged = useCallback((nextBoards) => {
    if (Array.isArray(nextBoards)) setBoards(nextBoards)
    else refreshBoards()
  }, [refreshBoards])

  const currentBoard = useMemo(
    () => boards.find(b => String(b.id) === String(boardId)) || board,
    [boards, boardId, board]
  )

  if (!projectId) {
    return (
      <div className="board-page">
        <Header onSettingsClick={() => setShowSettings(true)} title="Boards" centerTitle />
        <div className="board-page__empty">No project selected.</div>
        <Footer />
      </div>
    )
  }

  return (
    <div className="board-page">
      <Header
        onSettingsClick={() => setShowSettings(true)}
        projectId={projectId}
        title={project?.name || 'Boards'}
        centerTitle
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="board-page__bar">
        <BoardSwitcher
          projectId={projectId}
          boards={boards}
          currentBoard={currentBoard}
          onBoardsChanged={handleBoardsChanged}
          createBoard={createBoard}
          updateBoard={updateBoard}
          deleteBoard={deleteBoard}
          onSelect={(id) => setSearchParams({ projectId, boardId: String(id) })}
        />
        <span className={`board-page__save board-page__save--${saveStatus}`}>
          {saveStatus === 'saving' && 'Saving…'}
          {saveStatus === 'saved' && 'All changes saved'}
          {saveStatus === 'error' && 'Save failed — retrying on next edit'}
        </span>
      </div>

      {loadError && <div className="board-page__error">{loadError}</div>}

      <div className="board-page__body">
        <div className="board-page__canvas">
          {initialData ? (
            <Excalidraw
              key={boardId}
              excalidrawAPI={(api) => { excalidrawApiRef.current = api }}
              initialData={initialData}
              onChange={handleChange}
              theme="dark"
              name={currentBoard?.name || 'Board'}
            />
          ) : (
            <div className="board-page__loading">Loading board…</div>
          )}
        </div>

        <BoardAiPanel
          projectId={projectId}
          projectName={project?.name || ''}
          boardId={boardId}
          onImageGenerated={placeAssetImage}
        />
      </div>
    </div>
  )
}
