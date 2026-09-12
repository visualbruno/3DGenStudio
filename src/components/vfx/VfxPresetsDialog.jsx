// The VFX preset library: browse ready-made effects and open one.
//
// THIS IS THE ON-RAMP, and it is the single biggest lever on "make VFX easy".
// Nobody learns a particle system from an empty board - they learn it by
// opening something that already works and changing one number at a time. So
// the dialog is built to answer, in this order, the three questions a newcomer
// actually has: what KIND of effect am I making (the category rail), which one
// looks like the thing in my head (the thumbnail grid), and what will I learn
// from it (the description and the "teaches" list).
//
// CLICKING A CARD OPENS IT. There is no select-then-confirm step, because the
// preset IS the preview and a second click teaches nothing. The one thing that
// gets in the way is unsaved work, so that - and only that - asks first.
//
// AUTHOR MODE mirrors the wiki exactly: the server reports whether this
// installation carries the marker file, and the editing affordances simply are
// not rendered without it. Nothing here is a security boundary - the routes
// enforce it - it is about not showing a Delete button to someone whose Delete
// would 403.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PRESET_CATEGORIES,
  PRESET_TAGS,
  groupPresets,
  presetMatches,
} from '../../../vfx/preset.js'
import { compileVfxGraph } from '../../../vfx/compile.js'
import { normalizeVfxDoc } from '../../../vfx/doc.js'
import { createVfxThumbnailFile } from '../../utils/vfxThumbnail.js'
import {
  bundleDocAssets,
  describeDocAssets,
  packSlug,
  resolvePresetAssets,
} from '../../utils/vfx/presetAssets.js'
import {
  deleteVfxPreset,
  getVfxPreset,
  listVfxPresets,
  saveVfxPreset,
  saveVfxPresetThumbnail,
  vfxPresetThumbnailUrl,
} from '../../utils/vfxApi.js'
import './VfxPresetsDialog.css'

// A card with no thumbnail still has to look like something. Rather than a grey
// box, the category picks a hue and the initials stand in - so a wall of
// un-thumbnailed presets still reads as a library sorted by kind, and the ones
// that DO have art stand out rather than being lost in a uniform grid.
const CATEGORY_HUE = {
  'Fire & Smoke': 18,
  'Impacts & Hits': 44,
  Explosions: 8,
  'Magic & Energy': 276,
  Weather: 205,
  Environment: 145,
  Liquids: 190,
  'Sci-Fi & Tech': 225,
  'Trails & Projectiles': 320,
  'Creatures & Organic': 95,
  'UI & Feedback': 255,
}

const initialsOf = (name) => name
  .split(/\s+/)
  .slice(0, 2)
  .map((word) => word[0] || '')
  .join('')
  .toUpperCase()

function PresetCard({ preset, authorMode, busy, onOpen, onEdit, onDelete, onShoot, epoch }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const hue = CATEGORY_HUE[preset.category] ?? 220
  const showThumb = preset.hasThumbnail && !thumbFailed

  return (
    <div className="vfx-preset-card">
      <button
        type="button"
        className="vfx-preset-card__open"
        onClick={() => onOpen(preset)}
        disabled={busy}
        // The full teaching list as a title, so it is reachable without opening
        // anything. The card shows the first two; a hover shows all of them.
        title={preset.teaches?.length
          ? `${preset.description}\n\nTeaches:\n- ${preset.teaches.join('\n- ')}`
          : preset.description}
      >
        <span
          className="vfx-preset-card__art"
          style={{ '--vfx-preset-hue': hue }}
        >
          {showThumb ? (
            <img
              src={`${vfxPresetThumbnailUrl(preset.id)}${epoch ? `?v=${epoch}` : ''}`}
              alt=""
              loading="lazy"
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <span className="vfx-preset-card__initials" aria-hidden="true">
              {initialsOf(preset.name)}
            </span>
          )}
        </span>

        <span className="vfx-preset-card__name">{preset.name}</span>
        <span className="vfx-preset-card__blurb">{preset.description}</span>

        <span className="vfx-preset-card__tags">
          {(preset.tags || []).slice(0, 3).map((tag) => (
            <span key={tag} className="vfx-preset-card__tag">
              {PRESET_TAGS[tag]?.label || tag}
            </span>
          ))}
        </span>
      </button>

      {authorMode && (
        <span className="vfx-preset-card__admin">
          <button type="button" onClick={() => onEdit(preset)} title="Edit this preset">
            <span className="material-symbols-outlined">edit</span>
          </button>
          <button
            type="button"
            onClick={() => onShoot(preset)}
            title="Render a thumbnail for this preset"
          >
            <span className="material-symbols-outlined">photo_camera</span>
          </button>
          <button type="button" onClick={() => onDelete(preset)} title="Delete this preset">
            <span className="material-symbols-outlined">delete</span>
          </button>
        </span>
      )}
    </div>
  )
}

/**
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {(preset: Object) => void} props.onOpen called with the full preset,
 *   document included
 * @param {boolean} props.dirty whether the open effect has unsaved changes
 * @param {Object|null} props.currentDoc the open document, for "save as preset"
 * @param {string} props.currentName
 * @param {() => Promise<Array<Object>>} props.listLibrary reads the asset
 *   library, so a preset's bundled sprites are deduped against what is
 *   already installed rather than added again on every open
 * @param {(message: string, type?: string) => void} props.notify
 */
export default function VfxPresetsDialog({
  onClose, onOpen, dirty, currentDoc, currentName, listLibrary, notify,
}) {
  const [presets, setPresets] = useState([])
  const [authorMode, setAuthorMode] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [activeTags, setActiveTags] = useState([])
  const [editing, setEditing] = useState(null)
  // Bumped after a thumbnail is written, and appended to the image URL. Without
  // it the browser keeps serving the cached bytes for a path that has not
  // changed, and re-rendering a card appears to do nothing.
  const [thumbEpoch, setThumbEpoch] = useState(0)

  const searchRef = useRef(null)

  // No synchronous setState here: `loading` starts true and is cleared when the
  // first fetch lands, so the effect below only kicks off a request. A reload
  // after a save or a delete needs no spinner - the list is already on screen
  // and the round trip is a few milliseconds against the local server.
  const reload = () => listVfxPresets()
    .then(({ presets: list, authorMode: mode }) => {
      setPresets(list)
      setAuthorMode(mode)
      setError('')
    })
    .catch((err) => setError(err?.message || 'Could not read the preset library.'))
    .finally(() => setLoading(false))

  useEffect(() => {
    reload()
    // The search box takes focus because typing is how anyone with a library
    // this size finds anything, and it costs a newcomer nothing.
    searchRef.current?.focus()
    // Mount only: `reload` is recreated each render but the library does not
    // change under us, and re-fetching on every keystroke of the search box
    // would be absurd.
  }, [])

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Counts come from the SEARCH-filtered set but ignore the category and tag
  // filters, so the rail always says how many results each category would give
  // rather than going to zero everywhere as soon as one is picked.
  const searched = useMemo(
    () => presets.filter((preset) => presetMatches(preset, query)),
    [presets, query],
  )

  const counts = useMemo(() => {
    const map = new Map()
    for (const preset of searched) map.set(preset.category, (map.get(preset.category) || 0) + 1)
    return map
  }, [searched])

  // Only tags that exist in the library, grouped by the vocabulary's own
  // grouping. An unknown tag still appears - under "Other" - because a filter
  // bar that silently drops a tag makes those presets unfindable.
  const tagGroups = useMemo(() => {
    const present = new Set()
    for (const preset of presets) for (const tag of preset.tags || []) present.add(tag)
    const groups = new Map()
    for (const tag of present) {
      const group = PRESET_TAGS[tag]?.group || 'Other'
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(tag)
    }
    for (const list of groups.values()) list.sort()
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [presets])

  const visible = useMemo(() => searched.filter((preset) => (
    (!category || preset.category === category)
    // EVERY selected tag must match, not any: picking "Loops" and "Beginner"
    // means both, which is what a person building a filter expects.
    && activeTags.every((tag) => (preset.tags || []).includes(tag))
  )), [searched, category, activeTags])

  const groups = useMemo(() => groupPresets(visible), [visible])

  const toggleTag = (tag) => setActiveTags((current) => (
    current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag]
  ))

  const open = async (preset) => {
    if (dirty && !window.confirm(
      `Opening "${preset.name}" replaces the effect you have open, and it has unsaved changes.\n\n`
      + 'Open the preset anyway?',
    )) return
    setBusy(true)
    try {
      const full = await getVfxPreset(preset.id)

      // A preset names the sprites and meshes it needs by FILENAME, because an
      // asset id from the authoring machine means nothing here. Installing them
      // into this library and rewiring the slots is what turns the preset into
      // an ordinary document - see src/utils/vfx/presetAssets.js.
      const { doc, installed, missing } = await resolvePresetAssets(full, {
        listLibrary,
        onProgress: (done, total) => setError(
          total > 1 ? `Adding preset assets to your library... ${done} of ${total}` : '',
        ),
      })

      onOpen({ ...full, doc })
      onClose()

      // SAID OUT LOUD, both ways. An install the author did not ask for should
      // not be a surprise they find in their library later; and a texture that
      // failed to install leaves a system drawing with the built-in blob, which
      // is indistinguishable from a preset nobody bothered to texture.
      if (missing.length) {
        notify?.(
          `${full.name} opened, but ${missing.length} asset${missing.length === 1 ? '' : 's'} `
          + `could not be wired: ${missing.map((need) => need.file).join(', ')}`,
          'error',
        )
      } else if (installed.length) {
        notify?.(
          `Added ${installed.length} preset asset${installed.length === 1 ? '' : 's'} to your library`,
          'success',
        )
      }
    } catch (err) {
      setError(err?.message || 'Could not open that preset.')
    } finally {
      setBusy(false)
    }
  }

  // RENDERING A CARD IMAGE FROM THE PRESET ITSELF, offscreen, with no viewport
  // involved: createVfxThumbnailFile simulates to a fixed time on a fixed seed
  // and captures that frame, which is also what makes the result STABLE - the
  // same preset renders the same card every time rather than flickering between
  // saves. There is no live runtime here to borrow a frame from, and that is
  // fine; the simulated path is the one the asset thumbnails already use.
  const renderThumbnail = async (preset) => {
    const full = preset.doc ? preset : await getVfxPreset(preset.id)
    const { ir } = compileVfxGraph(normalizeVfxDoc(full.doc), { assetIndex: new Set() })
    const file = await createVfxThumbnailFile(ir, { name: full.name })
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('Could not read the rendered thumbnail.'))
      reader.readAsDataURL(file)
    })
    await saveVfxPresetThumbnail(full.id, dataUrl)
  }

  const shoot = async (preset) => {
    setBusy(true)
    try {
      await renderThumbnail(preset)
      await reload()
      // The <img> src does not change when the bytes behind it do, so a card
      // that already showed a thumbnail would keep showing the old one.
      setThumbEpoch((current) => current + 1)
      setError('')
    } catch (err) {
      setError(err?.message || 'Could not render that thumbnail.')
    } finally {
      setBusy(false)
    }
  }

  // The whole library in one go, for the author filling it in after adding a
  // batch of presets. Sequential rather than parallel: each render builds a
  // WebGL context, and fifty at once is how you lose the tab.
  const shootMissing = async () => {
    const pending = presets.filter((entry) => !entry.hasThumbnail)
    if (!pending.length) return setError('Every preset already has a thumbnail.')
    setBusy(true)
    for (let index = 0; index < pending.length; index += 1) {
      setError(`Rendering thumbnails… ${index + 1} of ${pending.length}`)
      try {
        await renderThumbnail(pending[index])
      } catch (err) {
        setError(`Stopped at "${pending[index].name}": ${err?.message || 'render failed'}`)
        setBusy(false)
        return
      }
    }
    await reload()
    setThumbEpoch((current) => current + 1)
    setError(`Rendered ${pending.length} thumbnail${pending.length === 1 ? '' : 's'}.`)
    setBusy(false)
  }

  const remove = async (preset) => {
    if (!window.confirm(`Delete the preset "${preset.name}"? This cannot be undone.`)) return
    try {
      await deleteVfxPreset(preset.id)
      reload()
    } catch (err) {
      setError(err?.message || 'Could not delete that preset.')
    }
  }

  const startEdit = async (preset) => {
    try {
      // The metadata form edits the FULL preset, because saving sends the whole
      // thing back - editing a summary would write a preset with no document.
      setEditing(await getVfxPreset(preset.id))
    } catch (err) {
      setError(err?.message || 'Could not read that preset.')
    }
  }

  const startCreate = () => setEditing({
    id: '',
    name: currentName || 'New preset',
    category: PRESET_CATEGORIES[0],
    description: '',
    tags: [],
    teaches: [],
    assets: [],
    doc: currentDoc,
    isNew: true,
  })

  const commitEdit = async (draft) => {
    setBusy(true)
    try {
      // THE BUNDLING STEP, and the reason it is here rather than in the form:
      // it is the last thing before the write, so an author who cancels has
      // copied nothing into the shipped pack.
      //
      // A preset may not carry `asset:41` - it means nothing on anyone else's
      // install - so every library sprite and mesh the effect uses is copied
      // into resources/vfx/assets/ and the slots are rewritten to name the
      // FILE. validatePreset refuses the save otherwise, and used to do it
      // while promising this dialog would offer exactly this.
      const bundled = await bundleDocAssets(draft.doc, {
        listLibrary,
        names: draft.assetNames,
        onProgress: (done, total) => setError(
          total > 1 ? `Adding assets to the preset pack... ${done} of ${total}` : '',
        ),
      })
      // KEPT, NOT REPLACED. Re-saving an EXISTING preset bundles nothing - its
      // document already names files rather than ids, so there are no refs to
      // collect - and taking the empty result as the answer would strip the
      // declarations it already had, leaving an effect whose slots name
      // textures nobody installs.
      const bundledSlots = new Set(bundled.assets.map((need) => need.slot))
      const assets = [
        ...bundled.assets,
        ...(draft.assets || []).filter((need) => !bundledSlots.has(need.slot)),
      ]

      // STOPPING HERE RATHER THAN SAVING WHAT WORKED. A slot that could not be
      // bundled still holds a library id, so the save would be refused anyway -
      // but by validatePreset, naming a slot rather than the sprite, after the
      // others had already been copied into the shipped pack.
      if (bundled.failed.length) {
        setError(
          `Could not bundle ${bundled.failed.map((f) => `"${f.name || f.slot}" (${f.error})`).join(', ')}.`,
        )
        return
      }

      const { warnings } = await saveVfxPreset(draft.id, {
        name: draft.name,
        category: draft.category,
        description: draft.description,
        tags: draft.tags,
        teaches: draft.teaches,
        assets,
        doc: bundled.doc,
      })
      setEditing(null)
      // Said out loud, because both outcomes matter. A file copied into the
      // pack now ships with the application; a REUSED one means the author's
      // own sprite was not copied at all - the preset will open with whatever
      // was already under that name, which is right when it is the same sprite
      // and wrong if they meant a new one.
      if (bundled.added.length || bundled.reused.length) {
        notify?.(
          [
            bundled.added.length ? `Bundled ${bundled.added.join(', ')}` : '',
            bundled.reused.length
              ? `reused ${bundled.reused.join(', ')} already in the pack`
              : '',
          ].filter(Boolean).join('; '),
          bundled.reused.length ? 'warning' : 'success',
        )
      }
      // Warnings do not block the save, but they are the author's problem to
      // fix now rather than a player's to discover later.
      setError(warnings.length ? `Saved, with warnings: ${warnings.join(' ')}` : '')
      reload()
    } catch (err) {
      setError(err?.message || 'Could not save the preset.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vfx-presets-overlay" role="presentation" onClick={onClose}>
      <div
        className="vfx-presets"
        role="dialog"
        aria-modal="true"
        aria-label="VFX presets"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="vfx-presets__header">
          <div className="vfx-presets__title">
            <span className="material-symbols-outlined">auto_awesome</span>
            <h2 className="font-headline">VFX Presets</h2>
            <span className="vfx-presets__count">
              {loading ? 'Loading…' : `${visible.length} of ${presets.length}`}
            </span>
            {!authorMode && !loading && (
              <span className="vfx-presets__badge" title="Presets are read-only on this installation">
                Read-only
              </span>
            )}
          </div>

          <input
            ref={searchRef}
            className="vfx-presets__search"
            type="search"
            value={query}
            placeholder="Search effects, tags, techniques…"
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />

          {authorMode && (
            <button
              type="button"
              className="vfx-presets__new"
              onClick={shootMissing}
              disabled={busy}
              title="Render a card image for every preset that has none"
            >
              Thumbnails
            </button>
          )}
          {authorMode && currentDoc && (
            <button type="button" className="vfx-presets__new" onClick={startCreate}>
              Save current as preset
            </button>
          )}
          <button type="button" className="vfx-presets__close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="vfx-presets__body">
          <nav className="vfx-presets__rail" aria-label="Categories">
            <button
              type="button"
              className={`vfx-presets__cat${category === '' ? ' is-active' : ''}`}
              onClick={() => setCategory('')}
            >
              <span>All effects</span>
              <span className="vfx-presets__cat-count">{searched.length}</span>
            </button>
            {PRESET_CATEGORIES.filter((entry) => counts.get(entry)).map((entry) => (
              <button
                key={entry}
                type="button"
                className={`vfx-presets__cat${category === entry ? ' is-active' : ''}`}
                onClick={() => setCategory(category === entry ? '' : entry)}
                style={{ '--vfx-preset-hue': CATEGORY_HUE[entry] ?? 220 }}
              >
                <span className="vfx-presets__cat-dot" aria-hidden="true" />
                <span>{entry}</span>
                <span className="vfx-presets__cat-count">{counts.get(entry)}</span>
              </button>
            ))}
          </nav>

          <div className="vfx-presets__main">
            <div className="vfx-presets__filters">
              {tagGroups.map(([group, list]) => (
                <div className="vfx-presets__filter-group" key={group}>
                  <span className="vfx-presets__filter-label">{group}</span>
                  {list.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`vfx-presets__chip${activeTags.includes(tag) ? ' is-active' : ''}`}
                      onClick={() => toggleTag(tag)}
                      aria-pressed={activeTags.includes(tag)}
                    >
                      {PRESET_TAGS[tag]?.label || tag}
                    </button>
                  ))}
                </div>
              ))}
              {(activeTags.length > 0 || category || query) && (
                <button
                  type="button"
                  className="vfx-presets__clear"
                  onClick={() => { setActiveTags([]); setCategory(''); setQuery('') }}
                >
                  Clear filters
                </button>
              )}
            </div>

            {error && <div className="vfx-presets__error">{error}</div>}

            {!loading && visible.length === 0 && (
              <p className="vfx-presets__empty">
                Nothing matches those filters. Clear them to see all {presets.length} effects.
              </p>
            )}

            {groups.map((group) => (
              <section className="vfx-presets__group" key={group.category}>
                <h3
                  className="vfx-presets__group-title"
                  style={{ '--vfx-preset-hue': CATEGORY_HUE[group.category] ?? 220 }}
                >
                  {group.category}
                  <span>{group.presets.length}</span>
                </h3>
                <div className="vfx-presets__grid">
                  {group.presets.map((preset) => (
                    <PresetCard
                      key={preset.id}
                      preset={preset}
                      authorMode={authorMode}
                      busy={busy}
                      onOpen={open}
                      onEdit={startEdit}
                      onDelete={remove}
                      onShoot={shoot}
                      epoch={thumbEpoch}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        {editing && (
          <PresetEditor
            draft={editing}
            busy={busy}
            listLibrary={listLibrary}
            onCancel={() => setEditing(null)}
            onSave={commitEdit}
          />
        )}
      </div>
    </div>
  )
}

// The author's metadata form. Deliberately plain: it edits the card, not the
// effect - the effect is edited on the board, which is the whole application.
//
// THE ONE EXCEPTION IS THE ASSET LIST, and it is not metadata. A preset may not
// store a library asset id, so every sprite and mesh the effect uses has to be
// copied into the shipped pack under a filename before the preset can be saved
// at all. That is a real decision - the file ships with the application and
// other presets can name it - so the author names each one rather than having a
// slug guessed for them.
function PresetEditor({ draft, busy, listLibrary, onCancel, onSave }) {
  const [form, setForm] = useState({
    ...draft,
    // Suggested from the name, and only for a NEW preset: an existing id is the
    // filename, the thumbnail path and any link to it, so renaming one silently
    // would orphan all three.
    id: draft.id || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    tagText: (draft.tags || []).join(', '),
    teachText: (draft.teaches || []).join('\n'),
  })
  // What the effect references, and what each will be called in the pack. Null
  // until the library listing lands, so the form can say "checking" rather than
  // flashing "nothing to bundle" and then contradicting itself.
  const [needs, setNeeds] = useState(null)
  const [names, setNames] = useState({})

  useEffect(() => {
    let live = true
    Promise.resolve(listLibrary?.() || [])
      .then((rows) => {
        if (!live) return
        const found = describeDocAssets(draft.doc, rows)
        setNeeds(found)
        setNames(Object.fromEntries(found.map((need) => [need.slot, need.suggested])))
      })
      .catch(() => { if (live) setNeeds([]) })
    return () => { live = false }
    // Mount only. The draft does not change while the form is open - picking
    // another preset unmounts this - and `listLibrary` is rebuilt on every
    // render of the page above, so depending on it would re-read the whole
    // library on every keystroke in the name field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))

  // TWO WAYS THE SAME PACK FILENAME GETS CLAIMED TWICE, and both end the same
  // way: the second upload answers 409, the slot is wired to the FIRST one's
  // bytes, and the author ships an effect whose two textures are one texture.
  // An empty name is the sneakier of the two, because the route slugs it to
  // "asset" rather than refusing it.
  const slugs = (needs || []).map((need) => packSlug(names[need.slot]))
  const unnamed = (needs || []).filter((need, index) => (
    !slugs[index] || slugs.indexOf(slugs[index]) !== index
  ))

  return (
    <div className="vfx-presets__editor" role="dialog" aria-label="Edit preset">
      <h3 className="font-headline">{draft.isNew ? 'Save as a preset' : `Edit “${draft.name}”`}</h3>

      <label>
        <span>Name</span>
        <input value={form.name} onChange={set('name')} />
      </label>

      <label>
        <span>Id</span>
        <input
          value={form.id}
          onChange={set('id')}
          disabled={!draft.isNew}
          spellCheck={false}
        />
      </label>

      <label>
        <span>Category</span>
        <select value={form.category} onChange={set('category')}>
          {PRESET_CATEGORIES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>

      <label>
        <span>Description</span>
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </label>

      <label>
        <span>Tags, comma separated</span>
        <input value={form.tagText} onChange={set('tagText')} spellCheck={false} />
      </label>

      <label>
        <span>Teaches, one per line</span>
        <textarea rows={3} value={form.teachText} onChange={set('teachText')} />
      </label>

      {needs === null && (
        <p className="vfx-presets__assets-note">Checking what this effect needs…</p>
      )}

      {needs !== null && needs.length > 0 && (
        <div className="vfx-presets__assets">
          <span className="vfx-presets__assets-title">
            Bundled with the preset
            <em>{needs.length}</em>
          </span>
          <p className="vfx-presets__assets-note">
            A preset cannot point at your library, so these are copied into the
            shipped asset pack and named by filename. Anyone opening the preset
            gets them installed into their own library.
          </p>
          {needs.map((need) => (
            <label className="vfx-presets__asset" key={need.slot}>
              <span
                className="material-symbols-outlined"
                title={need.kind === 'mesh' ? 'Mesh' : 'Image'}
              >
                {need.kind === 'mesh' ? 'deployed_code' : 'image'}
              </span>
              <input
                value={names[need.slot] ?? ''}
                onChange={(event) => setNames((current) => ({
                  ...current, [need.slot]: event.target.value,
                }))}
                spellCheck={false}
                aria-label={`Pack filename for ${need.name || need.slot}`}
              />
              <span
                className={`vfx-presets__asset-file${unnamed.includes(need) ? ' is-bad' : ''}`}
              >
                {packSlug(names[need.slot]) || '(needs a name)'}
                {packSlug(names[need.slot]) && need.extension ? `.${need.extension}` : ''}
              </span>
              {!need.row && (
                <span className="vfx-presets__asset-gone" title="Not in your library any more">
                  missing
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      <div className="vfx-presets__editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="is-primary"
          // Blocked on an unnamed asset rather than slugging it to "asset":
          // two of those would collide on one pack filename and the second
          // would silently reuse the first's bytes.
          disabled={busy || !form.id || !form.name || unnamed.length > 0}
          title={unnamed.length ? 'Give every bundled asset its own name first' : ''}
          onClick={() => onSave({
            ...form,
            tags: form.tagText.split(',').map((entry) => entry.trim()).filter(Boolean),
            teaches: form.teachText.split('\n').map((entry) => entry.trim()).filter(Boolean),
            assetNames: names,
          })}
        >
          {busy ? 'Saving…' : 'Save preset'}
        </button>
      </div>
    </div>
  )
}
