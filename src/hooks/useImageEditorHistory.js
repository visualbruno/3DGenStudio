import { useCallback, useRef, useState } from 'react'
import { cloneCanvasElement } from '../utils/imageEditorCanvas'

// Undo/redo snapshot system for the Image Editor. Owns the history stacks and
// the canUndo/canRedo flags; operates on the layer + mask state passed in.
export default function useImageEditorHistory({
  layers,
  selectedLayerId,
  setLayers,
  setSelectedLayerId,
  layerCanvasesRef,
  maskCanvasRef,
  // The editor's bumpMask / bumpRender: a restore swaps the mask and every
  // layer canvas, and these are what tell the page to re-read them.
  onMaskChanged,
  onCanvasChanged
}) {
  const historyUndoRef = useRef([])
  const historyRedoRef = useRef([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(historyUndoRef.current.length > 0)
    setCanRedo(historyRedoRef.current.length > 0)
  }, [])

  const captureSnapshot = useCallback(() => {
    const layerCanvases = {}
    layers.forEach(layer => {
      layerCanvases[layer.id] = cloneCanvasElement(layerCanvasesRef.current.get(layer.id))
    })

    return {
      layers: layers.map(layer => ({ ...layer })),
      selectedLayerId,
      layerCanvases,
      maskCanvas: cloneCanvasElement(maskCanvasRef.current)
    }
  }, [layers, selectedLayerId, layerCanvasesRef, maskCanvasRef])

  const restoreSnapshot = useCallback((snapshot) => {
    const nextMap = new Map()
    snapshot.layers.forEach(layer => {
      const sourceCanvas = snapshot.layerCanvases[layer.id]
      if (sourceCanvas) {
        nextMap.set(layer.id, cloneCanvasElement(sourceCanvas))
      }
    })

    layerCanvasesRef.current = nextMap
    maskCanvasRef.current = snapshot.maskCanvas ? cloneCanvasElement(snapshot.maskCanvas) : null
    setLayers(snapshot.layers.map(layer => ({ ...layer })))
    setSelectedLayerId(snapshot.selectedLayerId || null)
    onMaskChanged()
    onCanvasChanged()
  }, [layerCanvasesRef, maskCanvasRef, setLayers, setSelectedLayerId, onMaskChanged, onCanvasChanged])

  const pushUndoSnapshot = useCallback(() => {
    if (layers.length === 0) return
    const snapshot = captureSnapshot()
    historyUndoRef.current.push(snapshot)
    if (historyUndoRef.current.length > 40) {
      historyUndoRef.current.shift()
    }
    historyRedoRef.current = []
    syncHistoryFlags()
  }, [captureSnapshot, layers.length, syncHistoryFlags])

  const undo = useCallback(() => {
    if (historyUndoRef.current.length === 0) return
    const current = captureSnapshot()
    const previous = historyUndoRef.current.pop()
    historyRedoRef.current.push(current)
    restoreSnapshot(previous)
    syncHistoryFlags()
  }, [captureSnapshot, restoreSnapshot, syncHistoryFlags])

  const redo = useCallback(() => {
    if (historyRedoRef.current.length === 0) return
    const current = captureSnapshot()
    const next = historyRedoRef.current.pop()
    historyUndoRef.current.push(current)
    restoreSnapshot(next)
    syncHistoryFlags()
  }, [captureSnapshot, restoreSnapshot, syncHistoryFlags])

  const resetHistory = useCallback(() => {
    historyUndoRef.current = []
    historyRedoRef.current = []
    syncHistoryFlags()
  }, [syncHistoryFlags])

  return {
    canUndo,
    canRedo,
    captureSnapshot,
    pushUndoSnapshot,
    undo,
    redo,
    resetHistory
  }
}
