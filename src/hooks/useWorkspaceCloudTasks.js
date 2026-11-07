// Cloud mesh tasks of a Workspace project (Tripo AI, Hitem3D, Tencent Cloud).
//
// Those APIs answer a submit with a task id; the mesh is fetched later by
// polling /api/meshes/generate/<provider>/result, which downloads and saves it
// once the provider reports success. The tasks are kept in localStorage per
// project, so a reload — or leaving the page and coming back — resumes polling
// instead of losing a result that was already paid for.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config'
import { buildCloudResultRequest } from '../utils/workspaceMeshCloud'

const POLL_INTERVAL_MS = 5000
// Network or server errors in a row before a task is given up on. Provider
// failures ("status: error") end a task at once.
const MAX_CONSECUTIVE_ERRORS = 6

function storageKeyFor(projectId) {
  return `workspace.cloudTasks.${projectId}`
}

function readTasks(projectId) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKeyFor(projectId)) || '[]')
    return Array.isArray(parsed) ? parsed.filter(task => task && task.id) : []
  } catch {
    return []
  }
}

function writeTasks(projectId, tasks) {
  try {
    if (tasks.length) window.localStorage.setItem(storageKeyFor(projectId), JSON.stringify(tasks))
    else window.localStorage.removeItem(storageKeyFor(projectId))
  } catch {
    // storage unavailable — polling still runs for this session
  }
}

export default function useWorkspaceCloudTasks(projectId, { onCompleted, onFailed }) {
  const [tasks, setTasks] = useState(() => readTasks(projectId))
  const [progressById, setProgressById] = useState({})
  const inFlightRef = useRef(new Set())
  const errorCountsRef = useRef(new Map())
  const handlersRef = useRef({ onCompleted, onFailed })

  useEffect(() => {
    handlersRef.current = { onCompleted, onFailed }
  }, [onCompleted, onFailed])

  useEffect(() => {
    writeTasks(projectId, tasks)
  }, [projectId, tasks])

  const addTask = useCallback((task) => {
    setTasks(prev => [...prev.filter(entry => entry.id !== task.id), task])
  }, [])

  const removeTask = useCallback((id) => {
    setTasks(prev => prev.filter(entry => entry.id !== id))
    errorCountsRef.current.delete(id)
  }, [])

  useEffect(() => {
    if (!tasks.length) return undefined
    let stopped = false

    const pollOne = async (task) => {
      if (inFlightRef.current.has(task.id)) return
      const request = buildCloudResultRequest(task, projectId)
      if (!request) {
        removeTask(task.id)
        return
      }
      inFlightRef.current.add(task.id)
      try {
        const res = await fetch(`${API_BASE}${request.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body)
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error || `Result query failed (HTTP ${res.status})`)
        errorCountsRef.current.delete(task.id)

        if (data.status === 'completed') {
          removeTask(task.id)
          await handlersRef.current.onCompleted?.(task, Array.isArray(data.assets) ? data.assets : [])
        } else if (data.status === 'error') {
          removeTask(task.id)
          handlersRef.current.onFailed?.(task, new Error(data.error || `${task.label || 'Cloud task'} failed`))
        } else if (!stopped) {
          setProgressById(prev => ({
            ...prev,
            [task.id]: {
              progress: Number.isFinite(Number(data.progress)) ? Number(data.progress) : null,
              status: data.taskStatus || data.jobStatus || 'processing'
            }
          }))
        }
      } catch (err) {
        const count = (errorCountsRef.current.get(task.id) || 0) + 1
        errorCountsRef.current.set(task.id, count)
        console.warn(`Cloud task ${task.id}: result query failed (${count}/${MAX_CONSECUTIVE_ERRORS})`, err)
        if (count >= MAX_CONSECUTIVE_ERRORS) {
          removeTask(task.id)
          handlersRef.current.onFailed?.(task, err)
        }
      } finally {
        inFlightRef.current.delete(task.id)
      }
    }

    const tick = () => {
      for (const task of tasks) pollOne(task)
    }
    const timer = setInterval(tick, POLL_INTERVAL_MS)
    // First check soon after a submit or a reload, not a full interval later.
    const first = setTimeout(tick, 1500)
    return () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(first)
    }
  }, [tasks, projectId, removeTask])

  return { tasks, progressById, addTask, removeTask }
}
