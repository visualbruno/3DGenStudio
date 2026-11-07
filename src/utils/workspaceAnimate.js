// Workspace → Animate module: client side of the "Animate with AI" agent
// (server: agent/, routes /api/agent/*). A run is one user message; its events
// stream back as SSE - text, tool calls, preview images and new versions.
import { API_BASE } from '../config'

export async function fetchAgentProviders() {
  const res = await fetch(`${API_BASE}/agent/providers`)
  if (!res.ok) throw new Error(`Could not read the AI providers (${res.status})`)
  return res.json()
}

export async function cancelAgentRun(runId) {
  if (!runId) return
  await fetch(`${API_BASE}/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(() => {})
}

/**
 * Start a run and feed every event to `onEvent` until the stream ends.
 * `signal` aborts the request - the server then stops the run too.
 */
export async function runAgentMessage({ projectId, assetId, assetName, message, conversationId, provider }, onEvent, signal) {
  const res = await fetch(`${API_BASE}/agent/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, assetId, assetName, message, conversationId, provider }),
    signal
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `The AI run could not start (${res.status})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          onEvent(JSON.parse(line.slice(5)))
        } catch {
          // a malformed frame - skip it
        }
      }
    }
  }
}

export const ANIMATE_SUGGESTIONS = [
  { label: 'Walk cycle', prompt: 'Make a natural looping walk cycle, in place.' },
  { label: 'Idle', prompt: 'Make a 3-second looping idle: slow breathing and a gentle look around.' },
  { label: 'Run', prompt: 'Make a fast looping run cycle, in place.' },
  { label: 'Attack', prompt: 'Make a short, punchy attack animation that returns to the rest pose.' },
  { label: 'Tail wag', prompt: 'Make a happy looping tail wag.' },
  { label: 'Fly / flap', prompt: 'Make a looping wing-flap flight cycle.' },
  { label: 'Check the rig', prompt: 'Inspect the rig and tell me if anything needs fixing before we animate.' }
]

export const BILLING_LABEL = { subscription: 'subscription', api: 'API · per token' }
