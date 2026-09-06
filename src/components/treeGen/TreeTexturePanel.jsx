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
import { assetUrl } from '../../config'

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
    hint: 'One or more leaf cut-outs WITH ALPHA. They are composed into an atlas and every card picks a tile at random, '
      + 'so a few variants read as far more.',
  },
]

// Where an asset's BYTES actually live.
//
// A library asset carries two paths that look interchangeable and are not:
// `filename` ("images/x.png") is relative to the /assets mount, while `filePath`
// ("data/assets/images/x.png") is storage-prefixed. Handing the second to
// assetUrl() yields /assets/data/assets/... and a 404 — and the mistake hides,
// because thumbnails render off the absolute `url` field and look fine.
function assetFileUrl(asset) {
  if (asset.url) return asset.url
  const relative = String(asset.filename || asset.filePath || '')
    .replace(/^\/+/, '')
    .replace(/^data\/assets\//, '')
  return relative ? assetUrl(relative) : null
}

// An asset row and a File both end up here as { id, name, url, source, file }.
function assetToEntry(asset) {
  const source = assetFileUrl(asset)
  return {
    // Library listings expose the real numeric id as `assetId`, alongside a
    // prefixed "library:<id>" display id — record the one that means something.
    id: asset.assetId ?? asset.id ?? null,
    name: asset.name || asset.filename || 'Image',
    url: asset.thumbnailUrl || source,
    // The bytes are fetched lazily at generate time, not here: picking six
    // leaves should not download six images the user may never build with.
    source,
    file: null,
  }
}

function fileToEntry(file) {
  return { id: null, name: file.name, url: URL.createObjectURL(file), source: null, file }
}

function Slot({ slot, value, onChange, onPick }) {
  const entries = slot.multiple ? (value || []) : (value ? [value] : [])

  const onUpload = event => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return
    const added = files.map(fileToEntry)
    onChange(slot.multiple ? [...(value || []), ...added] : added[0])
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
            <button
              key={`${entry.id ?? entry.name}-${index}`}
              type="button"
              className="treegen__thumb"
              title={`${entry.name} — click to remove`}
              onClick={() => removeAt(index)}
            >
              <img src={entry.url} alt={entry.name} />
              <span className="treegen__thumb-remove">×</span>
            </button>
          ))}
        </div>
      )}

      <div className="treegen__slot-actions">
        <button type="button" onClick={() => onPick(slot)}>
          {entries.length && !slot.multiple ? 'Replace…' : 'Choose…'}
        </button>
        <label className="treegen__upload">
          Upload
          <input type="file" accept="image/*" multiple={slot.multiple} onChange={onUpload} hidden />
        </label>
      </div>
    </div>
  )
}

export default function TreeTexturePanel({ textures, onChange }) {
  const [picking, setPicking] = useState(null)

  const handlePicked = useCallback(selection => {
    const slot = picking
    setPicking(null)
    if (!slot) return
    const chosen = Array.isArray(selection) ? selection : [selection]
    const added = chosen.filter(Boolean).map(assetToEntry)
    if (!added.length) return
    onChange(slot.key, slot.multiple ? [...(textures[slot.key] || []), ...added] : added[0])
  }, [picking, textures, onChange])

  return (
    <div className="treegen__textures">
      {SLOTS.map(slot => (
        <Slot
          key={slot.key}
          slot={slot}
          value={textures[slot.key]}
          onChange={value => onChange(slot.key, value)}
          onPick={setPicking}
        />
      ))}

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
