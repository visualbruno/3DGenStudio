/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useProjects } from './ProjectContext'
import { useNotifications } from './NotificationContext'

const WorkflowJobsContext = createContext(null)

// App-level registry of in-flight ComfyUI workflow jobs. It owns the SSE
// progress connection for each job so progress keeps flowing while the user
// navigates between pages/projects, and fires a global notification when a job
// finishes. Pages register a job when they start a workflow and report the
// terminal status; they observe live progress by reading `jobs`.
function createJobsStore() {
  const jobsById = new Map()
  let snapshot = []
  const listeners = new Set()

  const rebuild = () => {
    snapshot = Array.from(jobsById.values())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: () => {
      rebuild()
      listeners.forEach(listener => listener())
    },
    get: (id) => jobsById.get(id),
    has: (id) => jobsById.has(id),
    set: (id, job) => jobsById.set(id, job),
    delete: (id) => jobsById.delete(id),
    values: () => Array.from(jobsById.values())
  }
}

export function WorkflowJobsProvider({ children }) {
  const { subscribeToComfyWorkflowProgress } = useProjects()
  const { addNotification } = useNotifications()

  const [store] = useState(createJobsStore)
  const subscriptionsRef = useRef(new Map())

  const closeSubscription = useCallback((id) => {
    subscriptionsRef.current.get(id)?.()
    subscriptionsRef.current.delete(id)
  }, [])

  const registerJob = useCallback((init = {}) => {
    const id = init.id
    if (!id) {
      return null
    }

    // Re-registering the same promptId (e.g. a retry) replaces the old job.
    closeSubscription(id)

    store.set(id, {
      id,
      projectId: init.projectId ?? null,
      projectName: init.projectName ?? '',
      page: init.page ?? '',
      targetId: init.targetId != null ? String(init.targetId) : null,
      kind: init.kind ?? '',
      label: init.label || 'Workflow',
      status: 'queued',
      progressPercent: 0,
      detail: init.detail || 'Waiting for ComfyUI execution to start',
      currentNodeLabel: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null
    })
    store.emit()

    const unsubscribe = subscribeToComfyWorkflowProgress(id, {
      onMessage: (payload) => {
        const current = store.get(id)
        if (!current || current.status === 'completed' || current.status === 'error') {
          return
        }
        store.set(id, {
          ...current,
          status: payload?.status === 'error' ? 'error' : 'processing',
          progressPercent: Math.max(current.progressPercent || 0, Number(payload?.progressPercent) || 0),
          detail: payload?.detail || current.detail,
          currentNodeLabel: payload?.currentNodeLabel || current.currentNodeLabel
        })
        store.emit()
      },
      onError: () => {}
    })
    subscriptionsRef.current.set(id, unsubscribe)

    return id
  }, [store, closeSubscription, subscribeToComfyWorkflowProgress])

  const completeJob = useCallback((id, result = {}) => {
    closeSubscription(id)

    const current = store.get(id)
    const status = result.status === 'error' ? 'error' : 'completed'
    const label = current?.label || result.label || 'Workflow'
    const projectName = current?.projectName || result.projectName || ''
    const suffix = projectName ? ` — ${projectName}` : ''
    // Carry the job's origin so the notification can deep-link back to the card.
    const projectId = current?.projectId ?? result.projectId ?? null
    const targetId = current?.targetId ?? (result.targetId != null ? String(result.targetId) : null)

    if (current) {
      store.set(id, {
        ...current,
        status,
        progressPercent: status === 'completed' ? 100 : current.progressPercent,
        detail: result.detail || current.detail,
        error: status === 'error' ? (result.error || current.error || 'Workflow failed') : null,
        completedAt: Date.now()
      })
      store.emit()
    }

    if (status === 'completed') {
      addNotification({
        title: 'Workflow completed',
        message: `${label}${suffix}`,
        source: 'ComfyUI',
        tone: 'success',
        projectId,
        targetId
      })
    } else {
      addNotification({
        title: 'Workflow failed',
        message: `${result.error || label}${suffix}`,
        source: 'ComfyUI',
        tone: 'error',
        projectId,
        targetId
      })
    }
  }, [store, closeSubscription, addNotification])

  const removeJob = useCallback((id) => {
    closeSubscription(id)
    if (store.has(id)) {
      store.delete(id)
      store.emit()
    }
  }, [store, closeSubscription])

  const removeJobsForTarget = useCallback((projectId, targetId) => {
    const target = targetId != null ? String(targetId) : null
    let changed = false
    store.values().forEach(job => {
      if (job.projectId === projectId && job.targetId === target) {
        closeSubscription(job.id)
        store.delete(job.id)
        changed = true
      }
    })
    if (changed) {
      store.emit()
    }
  }, [store, closeSubscription])

  // Close every open connection only when the whole app unmounts.
  useEffect(() => {
    const subscriptions = subscriptionsRef.current
    return () => {
      subscriptions.forEach(unsubscribe => unsubscribe?.())
      subscriptions.clear()
    }
  }, [])

  const value = useMemo(() => ({
    store,
    registerJob,
    completeJob,
    removeJob,
    removeJobsForTarget
  }), [store, registerJob, completeJob, removeJob, removeJobsForTarget])

  return (
    <WorkflowJobsContext.Provider value={value}>
      {children}
    </WorkflowJobsContext.Provider>
  )
}

export function useWorkflowJobs() {
  const context = useContext(WorkflowJobsContext)
  if (!context) {
    throw new Error('useWorkflowJobs must be used within WorkflowJobsProvider')
  }

  const jobs = useSyncExternalStore(context.store.subscribe, context.store.getSnapshot)

  return {
    jobs,
    registerJob: context.registerJob,
    completeJob: context.completeJob,
    removeJob: context.removeJob,
    removeJobsForTarget: context.removeJobsForTarget
  }
}
