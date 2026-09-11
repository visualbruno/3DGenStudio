// Seamless (tileable texture) tool control panel.
//
// The tiled preview that judges these settings is NOT here — it lives in the
// right column (`SeamlessPreview`), pinned where it cannot scroll away. This
// panel is long enough that anything at the top of it is out of view by the
// time you reach the stamp sliders, and a preview you have to scroll back to is
// a preview you stop looking at.
//
// The panel is in two halves because the tool is: the JOIN makes the opposite
// edges continuous, and the STAMPS break up the straight line the join leaves
// behind. Either half can do the whole job alone — overlap 0 is stamps only,
// and stamping off is the join only — which is why both are switchable rather
// than merged into one "strength" slider.

export default function SeamlessControls({
  seamlessValues,
  setSeamlessValues,
  setSeamlessPreviewDirty,
  onReset,
  onApply,
}) {
  const handleChange = key => event => {
    const raw = event.target.value
    const value = event.target.type === 'checkbox'
      ? event.target.checked
      : (event.target.type === 'range' || event.target.type === 'number' ? Number(raw) : raw)
    setSeamlessValues(prev => ({ ...prev, [key]: value }))
    setSeamlessPreviewDirty(true)
  }

  // Always lands on a different seed, so the dice never looks broken.
  const rollSeed = () => {
    setSeamlessValues(prev => {
      let next = prev.seed
      while (next === prev.seed) next = Math.round(-50 + Math.random() * 100)
      return { ...prev, seed: next }
    })
    setSeamlessPreviewDirty(true)
  }

  const joins = seamlessValues.mode !== 'mirror' && seamlessValues.overlap > 0
  const stamping = seamlessValues.stamp !== false

  return (
    <div className="image-editor-controls">
      <label className="image-editor-label">
        Method
        <select
          className="image-editor-input"
          value={seamlessValues.mode}
          onChange={handleChange('mode')}
        >
          <option value="cut">Cut — hides the join in existing detail (best for photos)</option>
          <option value="blend">Blend — cross-fades the edges (smooth, can ghost)</option>
          <option value="mirror">Mirror — perfect tiling, visibly symmetrical</option>
        </select>
      </label>

      {/* Mirror has no say in this: folding the image tiles it both ways whether
          you asked for it or not, so offering the choice would be a lie. */}
      {seamlessValues.mode !== 'mirror' && (
        <>
          <label className="image-editor-label">
            Dimensions to loop
            <select
              className="image-editor-input"
              value={seamlessValues.loopAxis || 'xy'}
              onChange={handleChange('loopAxis')}
            >
              <option value="xy">XY — tile in both directions</option>
              <option value="x">X — left and right edges only</option>
              <option value="y">Y — top and bottom edges only</option>
            </select>
          </label>
          <p className="seamless-hint">
            Leave a pair of edges alone when nothing will ever butt against them — a wall strip
            that repeats sideways but is capped top and bottom keeps its real top and bottom this
            way, instead of spending them on a join nobody sees.
          </p>

          <label className="image-editor-label">
            Overlap ({seamlessValues.overlap === 0 ? 'off' : `${seamlessValues.overlap}%`})
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="40"
              value={seamlessValues.overlap}
              onChange={handleChange('overlap')}
            />
          </label>
          {seamlessValues.overlap === 0 && (
            <p className="seamless-hint">
              No join at all — the stamps below do the whole job. Nothing is resampled and no
              strip of the texture is spent, so the pixels stay exactly as they were everywhere a
              stamp did not land. Needs stamping switched on to do anything.
            </p>
          )}
        </>
      )}

      {joins && (
        <>
          <label className="image-editor-label">
            Softness ({seamlessValues.feather}px)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="12"
              value={seamlessValues.feather}
              onChange={handleChange('feather')}
            />
          </label>
          <p className="seamless-hint">
            Quoted for a 1K texture and scaled from there, so the preview softens the join by the
            same amount, relative to the picture, as the full-size result will.
          </p>

          <label className="image-editor-toggle">
            <input
              type="checkbox"
              checked={seamlessValues.keepSize !== false}
              onChange={handleChange('keepSize')}
            />
            <span>Keep original size</span>
          </label>
          <p className="seamless-hint">
            Joining spends the overlap, so keeping the original size means resampling — at a 17%
            overlap that is a 1.17× magnification of everything, not just the edges. Turn it off
            for a slightly smaller but pixel-exact texture.
          </p>
        </>
      )}

      <label className="image-editor-label">
        Flatten lighting ({seamlessValues.flatten}%)
        <input
          className="image-editor-input"
          type="range"
          min="0"
          max="100"
          value={seamlessValues.flatten}
          onChange={handleChange('flatten')}
        />
      </label>
      <p className="seamless-hint">
        Evens out large-scale brightness across the finished tile. Matching edges is only half the
        job — a texture that is darker on one side still reads as a grid when it repeats, and no
        amount of overlap fixes that. Turn it down if you want to keep the photo&apos;s own lighting.
      </p>

      {/* ---- Stamping ---------------------------------------------------- */}

      <label className="image-editor-toggle">
        <input
          type="checkbox"
          checked={stamping}
          onChange={handleChange('stamp')}
        />
        <span>Stamp the seam</span>
      </label>
      <p className="seamless-hint">
        Scatters round patches of the texture across the seam, each one wrapping around the edge
        so it stays continuous. A join alone leaves one ruler-straight line through the tile, and
        on bark, planks or stone courses the eye finds it even when the pixels match perfectly —
        this is what makes that line ragged.
      </p>

      {stamping && (
        <div className="seamless-group">
          <div className="seamless-seed">
            <label className="image-editor-label">
              Seed ({seamlessValues.seed})
              <input
                className="image-editor-input"
                type="range"
                min="-50"
                max="50"
                step="1"
                value={seamlessValues.seed}
                onChange={handleChange('seed')}
              />
            </label>
            <button
              type="button"
              className="image-editor-btn"
              onClick={rollSeed}
              title="Pick a different set of stamps"
            >
              🎲
            </button>
          </div>
          <p className="seamless-hint">
            Which patches get picked and where they land. Everything else held still, this is the
            reroll button — if one stamp has dropped something recognisable onto the seam, step
            the seed rather than fighting it with the other sliders.
          </p>

          <label className="image-editor-label">
            Stamp Radius ({seamlessValues.stampRadius.toFixed(2)})
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={seamlessValues.stampRadius}
              onChange={handleChange('stampRadius')}
            />
          </label>
          <label className="image-editor-label">
            Stamp Density ({seamlessValues.stampDensity.toFixed(2)})
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={seamlessValues.stampDensity}
              onChange={handleChange('stampDensity')}
            />
          </label>
          <label className="image-editor-label">
            Hardness ({seamlessValues.hardness.toFixed(2)})
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={seamlessValues.hardness}
              onChange={handleChange('hardness')}
            />
          </label>
          <p className="seamless-hint">
            Radius is 5–30% of the texture; density is how far consecutive stamps overlap.
            Hardness is how far the patch stays fully opaque before it starts fading — hard
            patches read as their own thing, soft ones dissolve into what is underneath.
          </p>

          <label className="image-editor-label">
            Stamp Noise ({seamlessValues.stampNoise.toFixed(2)})
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={seamlessValues.stampNoise}
              onChange={handleChange('stampNoise')}
            />
          </label>
          <p className="seamless-hint">
            Eats the stamp&apos;s edge away with noise so it lands as an irregular blotch instead
            of a circle.
            {seamlessValues.stampNoise > 1.35 && (
              <strong className="seamless-warn">
                {' '}Above 1 the noise starts punching holes through the middle of the stamp,
                which can re-expose the seam it was covering.
              </strong>
            )}
          </p>

          <label className="image-editor-label">
            Randomize ({seamlessValues.randomize.toFixed(2)})
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="0.5"
              step="0.01"
              value={seamlessValues.randomize}
              onChange={handleChange('randomize')}
            />
          </label>
          <label className="image-editor-label">
            Rotate ({seamlessValues.stampRotate}°)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="360"
              step="1"
              value={seamlessValues.stampRotate}
              onChange={handleChange('stampRotate')}
            />
          </label>
          <p className="seamless-hint">
            Randomize varies each stamp&apos;s size and nudges it off the seam line; Rotate turns
            it, which breaks up a texture with an obvious grain direction.
            {seamlessValues.stampRotate > 1 && (
              <strong className="seamless-warn">
                {' '}Rotation above 1° resamples each stamp pixel-by-pixel, so fine detail inside
                it comes back slightly less precise.
              </strong>
            )}
          </p>
        </div>
      )}

      <div className="image-editor-toggle-row">
        <button type="button" className="image-editor-btn" onClick={onReset}>
          Reset
        </button>
        <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={onApply}>
          Make Seamless
        </button>
      </div>
    </div>
  )
}
