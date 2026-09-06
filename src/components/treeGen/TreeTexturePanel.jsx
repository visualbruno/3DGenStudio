// Texture slots: Trunk, Branches, Leaves.
//
// Leaves take a LIST of images, not an atlas. An atlas is what the renderer
// wants — one image holding a grid of cut-outs that cards index into — but it is
// the wrong thing to ask a person for, because nobody has one lying around; they
// have a handful of leaf PNGs. The service composes the grid, so the UI can ask
// for the natural thing.
//
// Branches are a separate, optional slot. Left empty they wear the trunk texture
// and the tree stays one bark material and one draw call; filling it splits the
// bark in two, which is a real cost and so is never done behind the user's back.
import { useCallback, useState } from 'react'
import AssetSelectorModal from '../AssetSelectorModal'
import { assetToTextureEntry, detectLeafPivots, resolveTextureEntry } from '../../utils/treeGen'
import LeafPivotDialog from './LeafPivotDialog'

const SLOTS = [
  {
    key: 'trunk',
    label: 'Trunk',
    hint: 'Tileable bark. Tiles along the branch — the Bark UV tile parameter sets how much world length one tile covers.',
  },
  {
    key: 'branches',
    label: 'Branches',
    optional: true,
    hint: 'Optional. Empty means the branches wear the trunk texture, which keeps the tree at one bark material. '
      + 'Setting it splits the bark into two materials and costs a draw call.',
  },
  {
    key: 'leaves',
    label: 'Leaves',
    multiple: true,
    pivots: true,
    hint: 'One or more leaf cut-outs WITH ALPHA. They are composed into an atlas and every card picks a tile at '
      + 'random, so a few variants read as far more. Use the crosshair on a thumbnail to set where its stem '
      + 'attaches to the branch.',
  },
]

function fileToEntry(file) {
  return { id: null, name: file.name, url: URL.createObjectURL(file), source: null, file }
}

function Slot({ slot, value, onChange, onUpload, onPick, onEditPivot }) {
  const entries = slot.multiple ? (value || []) : (value ? [value] : [])

  const handleFiles = event => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return
    onUpload(files.map(fileToEntry))
    event.target.value = ''
  }

  const removeAt = index => {
    if (!slot.multiple) return onChange(null)
    const next = [...(value || [])]
    next.splice(index, 1)
    return onChange(next.length ? next : null)
  }

  return (
    <div className="treegen__slot" title={slot.hint}>
      <div className="treegen__slot-head">
        <span className="treegen__slot-label">{slot.label}</span>
        {slot.optional && !entries.length && <span className="treegen__slot-optional">optional</span>}
        {slot.multiple && entries.length > 0 && (
          <span className="treegen__slot-optional">{entries.length} image{entries.length === 1 ? '' : 's'}</span>
        )}
      </div>

      {entries.length > 0 && (
        <div className="treegen__thumbs">
          {entries.map((entry, index) => (
            <div key={`${entry.id ?? entry.name}-${index}`} className="treegen__thumb-wrap">
              <button
                type="button"
                className="treegen__thumb"
                title={`${entry.name} — click to remove`}
                onClick={() => removeAt(index)}
              >
                <img src={entry.url} alt={entry.name} />
                <span className="treegen__thumb-remove">×</span>
              </button>
              {slot.pivots && (
                <button
                  type="button"
                  className={`treegen__thumb-pivot ${entry.pivot ? 'treegen__thumb-pivot--set' : ''}`}
                  title={entry.pivot
                    ? `Stem at ${entry.pivot.x.toFixed(2)}, ${entry.pivot.y.toFixed(2)} — click to adjust`
                    : 'Set where the stem attaches'}
                  onClick={() => onEditPivot(slot, index)}
                >
                  ⌖
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="treegen__slot-actions">
        <button type="button" onClick={() => onPick(slot)}>
          {entries.length && !slot.multiple ? 'Replace…' : 'Choose…'}
        </button>
        <label className="treegen__upload">
          Upload
          <input type="file" accept="image/*" multiple={slot.multiple} onChange={handleFiles} hidden />
        </label>
      </div>
    </div>
  )
}

export default function TreeTexturePanel({ textures, onChange }) {
  const [picking, setPicking] = useState(null)
  const [editing, setEditing] = useState(null)   // { slotKey, index }

  // Seed each new leaf's pivot from the detector, so the crosshair opens on a
  // guess instead of a blank. Best-effort: a leaf with no pivot still renders
  // (the service falls back to its own detection), so a failure here must not
  // block adding images.
  const seedPivots = useCallback(async added => {
    try {
      const images = await Promise.all(added.map(entry => resolveTextureEntry(entry)))
      const usable = images.map((image, index) => ({ image, index })).filter(item => item.image)
      if (!usable.length) return added
      const detected = await detectLeafPivots(usable.map(item => item.image))
      const withPivots = [...added]
      usable.forEach((item, position) => {
        const pivot = detected[position]
        if (pivot) withPivots[item.index] = { ...withPivots[item.index], pivot }
      })
      return withPivots
    } catch (error) {
      console.warn('Could not detect leaf pivots', error)
      return added
    }
  }, [])

  const handlePicked = useCallback(async selection => {
    const slot = picking
    setPicking(null)
    if (!slot) return
    const chosen = Array.isArray(selection) ? selection : [selection]
    let added = chosen.filter(Boolean).map(assetToTextureEntry)
    if (!added.length) return
    if (slot.pivots) added = await seedPivots(added)
    onChange(slot.key, slot.multiple ? [...(textures[slot.key] || []), ...added] : added[0])
  }, [picking, textures, onChange, seedPivots])

  const handleUploaded = useCallback(async (slot, added) => {
    const seeded = slot.pivots ? await seedPivots(added) : added
    onChange(slot.key, slot.multiple ? [...(textures[slot.key] || []), ...seeded] : seeded[0])
  }, [textures, onChange, seedPivots])

  const editingEntry = editing
    ? (textures[editing.slotKey] || [])[editing.index] || null
    : null

  const savePivot = useCallback(pivot => {
    if (!editing) return
    const list = [...(textures[editing.slotKey] || [])]
    if (!list[editing.index]) return setEditing(null)
    list[editing.index] = { ...list[editing.index], pivot }
    onChange(editing.slotKey, list)
    return setEditing(null)
  }, [editing, textures, onChange])

  return (
    <div className="treegen__textures">
      {SLOTS.map(slot => (
        <Slot
          key={slot.key}
          slot={slot}
          value={textures[slot.key]}
          onChange={value => onChange(slot.key, value)}
          onUpload={added => handleUploaded(slot, added)}
          onPick={setPicking}
          onEditPivot={(target, index) => setEditing({ slotKey: target.key, index })}
        />
      ))}

      {editingEntry && (
        <LeafPivotDialog
          entry={editingEntry}
          onSave={savePivot}
          onClose={() => setEditing(null)}
        />
      )}

      {picking && (
        <AssetSelectorModal
          assetType="image"
          multiple={!!picking.multiple}
          showEdits
          title={`Choose ${picking.label.toLowerCase()} image${picking.multiple ? 's' : ''}`}
          onSelect={handlePicked}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}
