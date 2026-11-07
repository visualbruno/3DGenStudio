// Workspace → Animate module: "Animate with AI". The user describes a motion;
// an AI agent (Claude Code / Codex on the user's subscription, or the Claude /
// OpenAI APIs / a local OpenAI-compatible model with a key) reads the rig,
// previews, fixes and saves the clip with the animation tools. Every save is a
// new VERSION of the mesh: it is logged to the history, becomes the panel's
// mesh, and plays in the viewer.
import { useEffect, useMemo, useRef, useState } from 'react'
import AssetSelectorModal from '../AssetSelectorModal'
import WorkspaceMeshSlot from './WorkspaceMeshSlot'
import {
  ANIMATE_SUGGESTIONS,
  BILLING_LABEL,
  cancelAgentRun,
  fetchAgentProviders,
  runAgentMessage
} from '../../utils/workspaceAnimate'

const STORAGE_PREFIX = 'workspace.animate.v1.'
const TOOL_LABELS = {
  describe_rig: 'Reading the rig',
  inspect_rig: 'Checking the rig',
  annotate_rig: 'Correcting the rig labels',
  preview_animation: 'Previewing',
  save_animation: 'Saving the clip',
  list_animations: 'Listing clips',
  delete_animation: 'Removing a clip',
  list_motion_library: 'Browsing the motion library',
  publish_animation: 'Saving to the animation library',
  rebind_weights: 'Fixing skin weights',
  rename_bones: 'Renaming bones',
  add_bone: 'Adding a bone',
  split_bone: 'Splitting a bone',
  rig_rigid_parts: 'Rigging the parts'
}

// Per-viewer convenience: the conversation survives a reload (without the
// preview images, which would overflow storage).
function readSaved(projectId) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + projectId) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeSaved(projectId, value) {
  try {
    const items = value.items.slice(-200).map(item => (item.kind === 'image' ? { kind: 'image', expired: true, tool: item.tool } : item))
    window.localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify({ ...value, items }))
  } catch {
    // storage unavailable or full - the conversation just won't survive a reload
  }
}

function formatUsage(u) {
  if (!u) return ''
  const parts = []
  const input = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
  if (input) parts.push(`${input.toLocaleString()} in`)
  if (u.outputTokens) parts.push(`${u.outputTokens.toLocaleString()} out`)
  if (u.subscription) parts.push('subscription')
  else if (u.costUsd) parts.push(`$${u.costUsd.toFixed(3)}`)
  return parts.join(' · ')
}

export default function WorkspaceAnimatePanel({
  projectId,
  target,
  targetBusy,
  importers,
  onTargetChange,
  selectedMeshEntry,
  onResult,
  onOpenInEditor,
  onOpenSettings,
  settingsVersion = 0
}) {
  const saved = useMemo(() => readSaved(projectId), [projectId])
  const [providers, setProviders] = useState([])
  const [provider, setProvider] = useState(saved?.provider || '')
  const [providersError, setProvidersError] = useState('')
  const [items, setItems] = useState(saved?.items || [])
  const [conversationId, setConversationId] = useState(saved?.conversationId || null)
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState(false)
  const [runUsage, setRunUsage] = useState(null)
  const [assetPicker, setAssetPicker] = useState(false)
  const [slotBusy, setSlotBusy] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const runRef = useRef({ runId: null, controller: null })
  const scrollRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetchAgentProviders()
      .then((data) => {
        if (cancelled) return
        setProviders(data.providers || [])
        setProvider(prev => prev || data.selected || 'claude_code')
      })
      .catch(err => { if (!cancelled) setProvidersError(err.message) })
    return () => { cancelled = true }
  }, [settingsVersion])

  useEffect(() => { writeSaved(projectId, { provider, conversationId, items }) }, [projectId, provider, conversationId, items])
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])
  // Leaving the Workspace stops a run in flight.
  useEffect(() => () => runRef.current.controller?.abort(), [])

  const current = providers.find(p => p.id === provider) || null
  const busy = running || targetBusy || slotBusy

  const push = (item) => setItems(prev => [...prev, item])
  const patchLast = (kind, fn) => setItems((prev) => {
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      if (prev[i].kind === kind) {
        const next = prev.slice()
        next[i] = fn(prev[i])
        return next
      }
      if (prev[i].kind === 'user') break
    }
    return prev
  })

  const fillTarget = async (load) => {
    setSlotBusy(true)
    try {
      onTargetChange(await load())
    } catch (err) {
      push({ kind: 'error', text: err.message || 'Could not use that mesh.' })
    } finally {
      setSlotBusy(false)
    }
  }

  const send = async (text) => {
    const prompt = String(text ?? message).trim()
    if (!prompt || !target || busy || !current?.available) return
    setMessage('')
    push({ kind: 'user', text: prompt })
    setRunning(true)
    setRunUsage(null)
    const controller = new AbortController()
    runRef.current = { runId: null, controller }
    let streaming = false
    try {
      await runAgentMessage({
        projectId,
        assetId: target.assetId,
        assetName: target.name,
        message: prompt,
        conversationId,
        provider
      }, (ev) => {
        if (ev.type === 'start') {
          runRef.current.runId = ev.runId
          setConversationId(ev.conversationId)
        } else if (ev.type === 'text') {
          if (!streaming) { push({ kind: 'assistant', text: ev.delta }); streaming = true } else patchLast('assistant', item => ({ ...item, text: item.text + ev.delta }))
        } else if (ev.type === 'turn_end') {
          streaming = false
        } else if (ev.type === 'note') {
          streaming = false
          push({ kind: 'note', text: ev.text })
        } else if (ev.type === 'tool') {
          streaming = false
          push({ kind: 'tool', id: ev.id, name: ev.name, status: 'running' })
        } else if (ev.type === 'tool_result') {
          setItems(prev => prev.map(item => (item.kind === 'tool' && item.id === ev.id
            ? { ...item, status: ev.isError ? 'error' : 'done', summary: ev.summary }
            : item)))
        } else if (ev.type === 'image') {
          push({ kind: 'image', data: ev.data, mimeType: ev.mimeType, tool: ev.tool })
        } else if (ev.type === 'asset') {
          push({ kind: 'asset', assetId: ev.assetId, clip: ev.clip, tool: ev.tool })
          onResult?.(ev)
        } else if (ev.type === 'usage') {
          setRunUsage(prev => ({
            inputTokens: (prev?.inputTokens || 0) + (ev.inputTokens || 0),
            cacheReadTokens: (prev?.cacheReadTokens || 0) + (ev.cacheReadTokens || 0),
            cacheWriteTokens: (prev?.cacheWriteTokens || 0) + (ev.cacheWriteTokens || 0),
            outputTokens: (prev?.outputTokens || 0) + (ev.outputTokens || 0),
            costUsd: ev.costUsd ?? prev?.costUsd,
            subscription: Boolean(ev.subscription)
          }))
        } else if (ev.type === 'error') {
          push({ kind: 'error', text: ev.message })
        } else if (ev.type === 'done') {
          setConversationId(ev.conversationId)
        }
      }, controller.signal)
    } catch (err) {
      if (!controller.signal.aborted) push({ kind: 'error', text: err.message || 'The AI run failed.' })
    } finally {
      setRunning(false)
      runRef.current = { runId: null, controller: null }
    }
  }

  const stop = () => {
    cancelAgentRun(runRef.current.runId)
    runRef.current.controller?.abort()
    push({ kind: 'note', text: 'Stopped.' })
  }

  const newConversation = () => {
    if (running) return
    setItems([])
    setConversationId(null)
    setRunUsage(null)
  }

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">animation</span>
        Animate with AI
        {items.length > 0 && (
          <button type="button" className="workspace-animate__new" onClick={newConversation} disabled={running} title="Start a new conversation">
            <span className="material-symbols-outlined">add_comment</span>
          </button>
        )}
      </div>

      <div className="workspace-panel__scroll workspace-animate__scroll" ref={scrollRef}>
        <WorkspaceMeshSlot
          value={target}
          label="Rigged mesh"
          emptyLabel="Choose a rigged mesh"
          busy={targetBusy || slotBusy}
          onFile={(file) => fillTarget(() => importers.fromMeshFile(file))}
          onPickAsset={() => setAssetPicker(true)}
          onUseSelected={selectedMeshEntry ? () => fillTarget(() => importers.fromEntry(selectedMeshEntry)) : null}
          onDropEntry={(entry) => fillTarget(() => importers.fromEntry(entry))}
          onClear={() => onTargetChange(null)}
        />

        <label className="workspace-field">
          <span className="workspace-field__label">AI</span>
          <select className="workspace-input" value={provider} onChange={event => setProvider(event.target.value)} disabled={running}>
            {providers.map(p => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label} · {BILLING_LABEL[p.billing]}{p.available ? '' : ' (not set up)'}
              </option>
            ))}
          </select>
        </label>
        {providersError && <span className="workspace-hint workspace-hint--error">{providersError}</span>}
        {current && !current.available && (
          <span className="workspace-hint">
            {current.detail}.{' '}
            <button type="button" className="workspace-inline-link" onClick={onOpenSettings}>Open Settings</button>
          </span>
        )}
        {current?.available && (
          <span className="workspace-hint">
            {current.billing === 'subscription'
              ? `Uses your ${current.label} login (${current.detail}) - no API key, billed to your subscription.`
              : `Uses an API key - billed per token${current.model ? ` (${current.model})` : ''}.`}
          </span>
        )}

        <div className="workspace-animate__transcript">
          {items.length === 0 && (
            <div className="workspace-animate__empty">
              <span className="workspace-hint">
                Describe a motion. The AI reads the rig, previews, fixes what the checks report, and saves the clip as a new version. Works on any rigged creature - and on unrigged robots made of parts.
              </span>
              <div className="workspace-animate__chips">
                {ANIMATE_SUGGESTIONS.map(s => (
                  <button key={s.label} type="button" className="workspace-chip" disabled={!target || busy || !current?.available} onClick={() => send(s.prompt)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((item, i) => {
            if (item.kind === 'user') return <div key={i} className="workspace-animate__msg workspace-animate__msg--user">{item.text}</div>
            if (item.kind === 'assistant') return <div key={i} className="workspace-animate__msg workspace-animate__msg--ai">{item.text}</div>
            if (item.kind === 'note') return <div key={i} className="workspace-animate__note">{item.text}</div>
            if (item.kind === 'error') return <div key={i} className="workspace-status workspace-status--error">{item.text}</div>
            if (item.kind === 'tool') {
              return (
                <div key={i} className={`workspace-animate__tool workspace-animate__tool--${item.status}`} title={item.name}>
                  <span className="material-symbols-outlined">
                    {item.status === 'running' ? 'progress_activity' : item.status === 'error' ? 'error' : 'check_circle'}
                  </span>
                  <span className="workspace-animate__tool-name">{TOOL_LABELS[item.name] || item.name}</span>
                  {item.summary && <span className="workspace-animate__tool-summary">{item.summary}</span>}
                </div>
              )
            }
            if (item.kind === 'image') {
              if (item.expired) return <div key={i} className="workspace-animate__note">(preview from an earlier session)</div>
              const src = `data:${item.mimeType || 'image/png'};base64,${item.data}`
              return (
                <button key={i} type="button" className="workspace-animate__image" onClick={() => setLightbox(src)} title="Enlarge">
                  <img src={src} alt={`${item.tool} preview`} />
                </button>
              )
            }
            if (item.kind === 'asset') {
              return (
                <div key={i} className="workspace-animate__asset">
                  <span className="material-symbols-outlined">save</span>
                  <span>{item.clip ? `Saved "${item.clip}"` : `${TOOL_LABELS[item.tool] || item.tool}: saved`} - version {item.assetId}</span>
                </div>
              )
            }
            return null
          })}
          {running && <div className="workspace-animate__note workspace-animate__thinking">Working…</div>}
          {!running && runUsage && <div className="workspace-animate__usage">{formatUsage(runUsage)}</div>}
        </div>
      </div>

      <div className="workspace-panel__footer">
        <div className="workspace-prompt">
          <textarea
            className="workspace-prompt__text workspace-animate__input"
            value={message}
            onChange={event => setMessage(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={target ? 'Describe the motion… e.g. "a heavy, stomping walk" or "make it hop twice, then roar"' : 'Choose a rigged mesh first'}
            disabled={!target || !current?.available}
            rows={3}
          />
          <div className="workspace-prompt__bar">
            {target && (
              <button type="button" className="workspace-action-btn" onClick={() => onOpenInEditor?.({ id: target.assetId, name: target.name, filename: target.filename, filePath: target.filePath, type: 'mesh' })} title="Hand-edit the clips in the Mesh Editor dopesheet">
                <span className="material-symbols-outlined">open_in_new</span>
              </button>
            )}
            <span className="workspace-prompt__count">{running ? '' : 'Enter to send'}</span>
            {running
              ? (
                <button type="button" className="workspace-run-btn workspace-animate__send" onClick={stop}>
                  <span className="material-symbols-outlined">stop</span>
                  Stop
                </button>
                )
              : (
                <button type="button" className="workspace-run-btn workspace-animate__send" onClick={() => send()} disabled={!message.trim() || !target || busy || !current?.available}>
                  <span className="material-symbols-outlined">send</span>
                  Send
                </button>
                )}
          </div>
        </div>
      </div>

      {lightbox && (
        <div className="workspace-animate__lightbox" role="dialog" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Preview" />
        </div>
      )}

      {assetPicker && (
        <AssetSelectorModal
          assetType="mesh"
          showEdits
          onSelect={(asset) => {
            setAssetPicker(false)
            if (asset) fillTarget(() => importers.fromMeshAsset(asset))
          }}
          onClose={() => setAssetPicker(false)}
        />
      )}
    </div>
  )
}
