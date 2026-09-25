/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from './ProjectContext'
import { useWorkflowJobs } from './WorkflowJobsContext'

const BatchRunContext = createContext(null)

const IDLE_STATE = { status: 'idle', runId: null, projectId: null, cells: {}, error: null }

const SETTLED_CELL_STATUSES = new Set(['completed', 'error', 'cancelled'])

// A mirror of the batch runs the BACKEND is executing (batch/runner.js).
//
// The loop used to live here, in the tab. A batch that runs for hours outlives
// the tab's attention: a frozen background tab stopped dispatching, and a reload
// threw the loop away while its last job kept running, so the page came back
// saying "not running" and offered Continue on top of it. The backend owns the
// loop now; this only draws it, and turns its cell transitions into the global
// jobs indicator and the "workflow completed" notifications.
//
// It stays above the router so opening a result in an editor and coming back
// finds the grid exactly as it was.
export function BatchRunProvider({ children }) {
  const { subscribeToBatchRuns, startBatchRun, cancelBatchRun, clearBatchRunCells } = useProjects()
  const { registerJob, completeJob } = useWorkflowJobs()

  const [runs, setRuns] = useState({})
  // False until the backend has sent its list of runs. Until then "no run" only
  // means "not heard yet", and the page must not offer Run or Continue.
  const [synced, setSynced] = useState(false)
  // Bumped whenever a cell settles, so a mounted BatchPage knows to re-fetch the
  // project's assets and show the new thumbnail.
  const [resultsVersion, setResultsVersion] = useState(0)

  const jobsRef = useRef(new Map()) // promptId registered with the jobs store -> projectId
  const settledRef = useRef(new Map()) // projectId -> signature of its settled cells

  useEffect(() => subscribeToBatchRuns(({ runs: nextRuns, synced: nextSynced }) => {
    setRuns(nextRuns)
    setSynced(nextSynced)

    // The cell in flight is registered as a job; its settling completes it. A
    // cell that started and finished while the tab was asleep is never seen
    // running, so it raises no notification — the grid shows it either way.
    const running = new Set()
    for (const run of Object.values(nextRuns)) {
      for (const cell of Object.values(run?.cells || {})) {
        const promptId = cell?.promptId
        if (!promptId) continue
        if (cell.status === 'running') {
          running.add(promptId)
          if (!jobsRef.current.has(promptId)) {
            jobsRef.current.set(promptId, run.projectId)
            registerJob({
              id: promptId,
              projectId: run.projectId,
              projectName: run.projectName,
              page: 'batch',
              targetId: cell.cardKey,
              kind: 'batch',
              label: cell.label || 'Batch result'
            })
          }
        } else if (jobsRef.current.has(promptId) && SETTLED_CELL_STATUSES.has(cell.status)) {
          jobsRef.current.delete(promptId)
          completeJob(promptId, { status: cell.status, error: cell.error || undefined })
        }
      }
    }
    // A job whose cell vanished: the backend restarted mid-run, or the cell was
    // cleared. Nothing will ever settle it, so it is closed here.
    if (nextSynced) {
      for (const promptId of [...jobsRef.current.keys()]) {
        if (!running.has(promptId)) {
          jobsRef.current.delete(promptId)
          completeJob(promptId, { status: 'error', error: 'The batch run is no longer running' })
        }
      }
    }

    let changed = false
    for (const [projectId, run] of Object.entries(nextRuns)) {
      const settledCount = Object.values(run?.cells || {}).filter(cell => SETTLED_CELL_STATUSES.has(cell?.status)).length
      const signature = `${run?.runId}|${run?.status}|${settledCount}`
      if (settledRef.current.get(projectId) !== signature) {
        settledRef.current.set(projectId, signature)
        changed = true
      }
    }
    if (changed) {
      setResultsVersion(current => current + 1)
    }
  }), [subscribeToBatchRuns, registerJob, completeJob])

  // mode: "continue" keeps every cell that already has a result (the backend
  // reads them off the result cards); "restart" starts a fresh run.
  const startBatch = useCallback((projectId, { config, mode = 'continue' } = {}) => (
    startBatchRun(projectId, { config, mode })
  ), [startBatchRun])

  const cancelBatch = useCallback((projectId) => cancelBatchRun(projectId), [cancelBatchRun])

  // Deleting a result has to drop its cell from the remembered run as well:
  // while a run is remembered the grid is drawn from its cells, so a deleted
  // card would keep showing its old thumbnail.
  const clearCells = useCallback(async (projectId, cellKeys) => {
    if (!cellKeys?.length) return null
    const run = await clearBatchRunCells(projectId, cellKeys)
    setResultsVersion(current => current + 1)
    return run
  }, [clearBatchRunCells])

  const value = useMemo(() => ({
    runs,
    synced,
    resultsVersion,
    startBatch,
    cancelBatch,
    clearCells
  }), [runs, synced, resultsVersion, startBatch, cancelBatch, clearCells])

  return <BatchRunContext.Provider value={value}>{children}</BatchRunContext.Provider>
}

export function useBatchRun(projectId) {
  const context = useContext(BatchRunContext)
  if (!context) {
    throw new Error('useBatchRun must be used within BatchRunProvider')
  }

  // A run belongs to one project; another project's page must not show its grid.
  const run = context.runs[String(projectId)] || null
  return {
    runState: run || IDLE_STATE,
    synced: context.synced,
    resultsVersion: context.resultsVersion,
    startBatch: ({ config, mode } = {}) => context.startBatch(projectId, { config, mode }),
    cancelBatch: () => context.cancelBatch(projectId),
    clearCells: (cellKeys) => context.clearCells(projectId, cellKeys)
  }
}
