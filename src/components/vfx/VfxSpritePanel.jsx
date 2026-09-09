import { useEffect, useMemo, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { API_BASE } from '../../config'
import { createComfyExecutionId } from '../../utils/ids'
// THE SAME FIELD THE GRAPH, KANBAN AND IMAGE EDITOR PANELS USE. A sprite
// workflow has a seed, a step count, a sampler and a resolution like any other,
// and hiding them behind one prompt box meant every sprite came out of the same
// dice roll. Reusing the field also means enum parameters arrive here as
// dropdowns for free, and a fourth spelling of "render a ComfyUI parameter"
// never gets written.
import WorkflowParameterField from '../imageEditor/controls/WorkflowParameterField'
import './VfxSpritePanel.css'

// Generate a particle sprite with ComfyUI and wire it straight into the effect.
//
// THE ONE THING WORTH KNOWING BEFORE READING ANY OF THIS: an additive particle
// needs NO ALPHA CHANNEL. The shader adds the texture as light, so black
// contributes nothing and IS the transparency. That is why every prompt here is
// steered onto a pure black background, and it is why ComfyUI not producing
// alpha - the obvious objection to generating sprites this way - costs nothing
// for fire, sparks, magic, glows and explosions, which is most of what a
// particle sprite ever is.
//
// Alpha only matters for ALPHA-blended sprites: smoke, dust, debris, decals,
// where black renders as a black blob. Three of the shipped ComfyUI workflows
// remove a background, and the resulting image is a normal image EDIT that the
// sprite picker can select - so that path exists and is one step, just not this
// button's job.
//
// NO PROJECT IS INVOLVED. VFX assets are library-global, so the run asks for no
// project and for `persistGeneratedAssets: false` - the bytes come back as a
// data URL and are uploaded to the LIBRARY here. Persisting through the run
// would have required a project the effect does not belong to.

// Appended to whatever the author types. Stated in the UI rather than hidden,
// because an author who does not know why their sprite has a grey background
// cannot fix it.
const BLACK_BACKGROUND = 'on a pure solid black background, centered, no border, no text'

// The type of a workflow parameter or output.
//
// ONE READER, because there are two spellings and they are not both always
// present: a PARAMETER carries `type` and `valueType`, an OUTPUT carries only
// `valueType`. Reading `output.type` matched nothing and emptied the dropdown
// while the library held six perfectly good text-to-image workflows.
const typeOf = (entry) => entry?.valueType || entry?.type || ''

const PRESETS = [
  { label: 'Soft glow', prompt: 'a soft round glowing orb of white hot light, radial falloff' },
  { label: 'Flame wisp', prompt: 'a single wisp of orange and yellow flame, licking upward' },
  { label: 'Spark streak', prompt: 'a thin bright spark streak, white core fading to orange' },
  { label: 'Smoke puff', prompt: 'a soft grey smoke puff, wispy edges' },
  { label: 'Magic rune', prompt: 'a glowing violet arcane rune, thin bright lines' },
  { label: 'Debris chip', prompt: 'a small jagged stone chip, hard edges, lit from above' },
]

/**
 * @param {Object} props
 * @param {string|null} props.systemId the system whose Output receives the sprite
 * @param {string} props.systemName
 * @param {(asset: {assetId: number, name: string}) => void} props.onGenerated
 * @param {() => void} props.onClose
 */
export default function VfxSpritePanel({ systemId, systemName, onGenerated, onClose }) {
  const { getComfyWorkflows, runComfyWorkflow } = useProjects()
  const [workflows, setWorkflows] = useState([])
  const [workflowId, setWorkflowId] = useState('')
  const [prompt, setPrompt] = useState(PRESETS[0].prompt)
  // Every parameter EXCEPT the prompt, which keeps its own state so that it
  // survives a change of workflow and so the presets have something to write
  // to. Sparse, like ImageEditorPage's: a missing entry means "whatever the
  // workflow saved as its default", and it is resolved at submit time.
  const [values, setValues] = useState({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  // How many workflows were looked at, so an empty dropdown can say whether the
  // library is empty or whether nothing in it matched.
  const [considered, setConsidered] = useState(null)

  useEffect(() => {
    let cancelled = false
    getComfyWorkflows?.()
      .then(list => {
        if (cancelled) return
        // TEXT IN, IMAGE OUT, AND NOTHING ELSE REQUIRED.
        //
        // The three clauses are not interchangeable. Of 52 shipped workflows,
        // 27 take a prompt and return an image - but 21 of those also need an
        // IMAGE supplied (Inpainting, Remove Background, Mesh Projection,
        // CharacterSheet, Segmentation), and this panel has none to give. They
        // would fail after the author had waited for the run. The six that
        // remain are the "Gen Image with ..." ones.
        //
        const all = list || []
        const usable = all.filter(entry => (
          (entry.outputs || []).some(output => typeOf(output) === 'image')
          && (entry.parameters || []).some(p => typeOf(p) === 'string')
          && !(entry.parameters || []).some(p => ['image', 'mesh'].includes(typeOf(p)))
        ))
        // BY NAME. The library ships them in insertion order, which is
        // meaningless to the author staring at the dropdown.
        usable.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        setWorkflows(usable)
        setConsidered(all.length)
        setWorkflowId(current => current || usable[0]?.id || '')
      })
      .catch(() => setError('Could not read the ComfyUI workflow library.'))
    return () => { cancelled = true }
  }, [getComfyWorkflows])

  const workflow = useMemo(
    () => workflows.find(entry => String(entry.id) === String(workflowId)) || null,
    [workflows, workflowId],
  )

  // Parameter ids are `<nodeId>.<inputKey>`, so "6.text" exists in most of these
  // workflows and means something different in each. Carrying edits across a
  // workflow change would silently apply one workflow's step count to another's
  // sampler, so picking a workflow drops them and its own defaults show through.
  const selectWorkflow = (id) => {
    setWorkflowId(id)
    setValues({})
  }

  // The first string parameter is the prompt. Every text-to-image workflow in
  // the shipped library has exactly one, and guessing by NAME would break the
  // moment someone renamed a node.
  const promptParam = useMemo(
    () => (workflow?.parameters || []).find(p => typeOf(p) === 'string'),
    [workflow],
  )

  const generate = async () => {
    if (!workflow || !promptParam) return setError('Choose a workflow that takes a text prompt.')
    if (!prompt.trim()) return setError('Describe the sprite first.')
    if (!systemId) return setError('Select a system to give the sprite to.')

    setRunning(true)
    setError('')
    setResult(null)
    try {
      // EVERY parameter, resolved the way ImageEditorPage resolves them: an
      // untouched field falls back to the workflow's own saved default rather
      // than to an empty string, which for a seed or a step count would be a
      // run that fails or produces noise.
      const inputs = {}
      for (const parameter of workflow.parameters || []) {
        inputs[parameter.id] = values[parameter.id] ?? parameter.defaultValue ?? ''
      }
      // The prompt is the one field this panel owns, because it appends the
      // black background the additive shader depends on - see the header.
      inputs[promptParam.id] = `${prompt.trim()}, ${BLACK_BACKGROUND}`
      const outputs = await runComfyWorkflow(null, {
        workflowId: workflow.id,
        inputs,
        clientId: createComfyExecutionId('comfy-client'),
        promptId: createComfyExecutionId('comfy-prompt'),
        persistProcessingCard: false,
        // The bytes come back inline rather than being saved against a project
        // this effect does not have - see the header.
        persistGeneratedAssets: false,
      })
      const image = (Array.isArray(outputs) ? outputs : [outputs])
        .find(entry => entry?.url && String(entry.url).startsWith('data:image'))
      if (!image) throw new Error('The workflow produced no image.')

      const blob = await (await fetch(image.url)).blob()
      const name = `${prompt.trim().slice(0, 40)} sprite`
      const form = new FormData()
      form.append('file', new File([blob], `${name.replace(/[^\w.-]+/g, '_')}.png`, { type: blob.type || 'image/png' }))
      form.append('type', 'image')
      form.append('name', name)
      const response = await fetch(`${API_BASE}/assets/library-upload`, { method: 'POST', body: form })
      const saved = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(saved?.error || 'Could not save the sprite to the library.')

      const assetId = Number(String(saved.id).replace('library:', ''))
      setResult({ assetId, name, preview: image.url })
      onGenerated({ assetId, name })
    } catch (err) {
      setError(err?.message || 'The sprite could not be generated.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="vfx-sprite-overlay" role="presentation" onClick={onClose}>
      <div
        className="vfx-sprite"
        role="dialog"
        aria-modal="true"
        aria-label="Generate a sprite"
        onClick={event => event.stopPropagation()}
      >
        <div className="vfx-sprite__header">
          <h3 className="font-headline">Generate a sprite</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="vfx-sprite__body">
          <p className="vfx-sprite__teach">
            The sprite is drawn on <strong>pure black</strong>, which is added to your prompt.
            With Additive blending black is already invisible, so a particle texture needs no
            alpha channel at all. For Alpha blending — smoke, dust, debris — run one of the
            Remove Background workflows on the result and pick the edit instead.
          </p>
          <p className="vfx-sprite__teach">
            If the finished effect shows a faint haze around each particle, raise
            <strong> Black point</strong> on the Sprite Texture block. A generated
            background is often nearly black rather than exactly black, and additive
            blending adds that remainder once per overlapping particle.
          </p>

          <label className="vfx-sprite__field">
            <span>Workflow</span>
            <select value={workflowId} onChange={event => selectWorkflow(event.target.value)}>
              {workflows.length === 0 && (
                <option value="">
                  {considered === null ? 'Reading the workflow library…'
                    : considered === 0 ? 'No ComfyUI workflows in the library'
                      : `None of ${considered} workflows is text-to-image`}
                </option>
              )}
              {workflows.map(entry => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>

          {workflows.length === 0 && considered > 0 && (
            <p className="vfx-sprite__note">
              This needs a workflow that takes a text prompt and returns an image, and
              needs no image of its own — the “Gen Image with …” ones. Inpainting,
              Remove Background and the projection workflows all require an input
              image, so they cannot be driven from a prompt alone here.
            </p>
          )}

          {workflow && (
            <>
              <div className="vfx-sprite__presets">
                {PRESETS.map(preset => (
                  <button key={preset.label} type="button" onClick={() => setPrompt(preset.prompt)}>
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="vfx-sprite__params">
                {(workflow.parameters || [])
                  // Defensive: the workflow filter above already rejects
                  // anything needing an image or a mesh, and this field would
                  // render one as a text box asking for a filename.
                  .filter(parameter => !['image', 'mesh'].includes(typeOf(parameter)))
                  .map(parameter => (
                    <WorkflowParameterField
                      key={parameter.id}
                      parameter={parameter}
                      // The prompt reads from its own state so the presets above
                      // can write to it and so it survives a workflow change;
                      // everything else is sparse over the workflow's defaults.
                      value={parameter.id === promptParam?.id
                        ? prompt
                        : values[parameter.id] ?? parameter.defaultValue ?? ''}
                      onChange={(id, next) => (id === promptParam?.id
                        ? setPrompt(next)
                        : setValues(prev => ({ ...prev, [id]: next })))}
                    />
                  ))}
              </div>
            </>
          )}

          <p className="vfx-sprite__note">
            Goes to <strong>{systemName || 'the selected system'}</strong> as its Sprite Texture,
            and is saved to the image library so other effects can use it.
          </p>

          {error && <div className="vfx-sprite__message is-error">{error}</div>}
          {result && (
            <div className="vfx-sprite__message is-success">
              <img src={result.preview} alt="" />
              <span>Wired “{result.name}” into {systemName}.</span>
            </div>
          )}
        </div>

        <div className="vfx-sprite__actions">
          <button type="button" onClick={onClose}>Close</button>
          <button
            type="button"
            className="is-primary"
            onClick={generate}
            disabled={running || !workflow || !systemId}
          >
            {running ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
