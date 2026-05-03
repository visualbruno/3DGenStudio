import { readAbr } from 'ag-psd'

/**
 * Converts a single ABR brush sample (grayscale alpha Uint8Array) to a PNG File
 * using the browser canvas API.
 *
 * The brush is rendered as black-on-transparent so it looks like a brush stamp.
 *
 * @param {Uint8Array} alpha - Grayscale alpha values, one byte per pixel (w*h)
 * @param {number} width
 * @param {number} height
 * @param {string} filename - Desired filename for the resulting File object
 * @returns {Promise<File>}
 */
async function alphaToPngFile(alpha, width, height, filename) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(width, height)

  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i]
    imageData.data[i * 4 + 0] = 0   // R
    imageData.data[i * 4 + 1] = 0   // G
    imageData.data[i * 4 + 2] = 0   // B
    imageData.data[i * 4 + 3] = a   // A
  }

  ctx.putImageData(imageData, 0, 0)

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error(`Failed to encode brush sample "${filename}" as PNG`))
        return
      }
      resolve(new File([blob], filename, { type: 'image/png' }))
    }, 'image/png')
  })
}

/**
 * Parses an Adobe Brush (.abr) File and extracts all brush samples as PNG Files.
 *
 * @param {File} file - The .abr File object from a file input
 * @returns {Promise<Array<{ name: string, pngFile: File }>>}
 *   Array of { name, pngFile } where the first entry is the "main" brush.
 * @throws If the ABR version is unsupported or the file contains no samples.
 */
export async function parseAbrFile(file) {
  const buffer = await file.arrayBuffer()
  let abr

  try {
    abr = readAbr(new Uint8Array(buffer))
  } catch (err) {
    if (err.message?.includes('Unsupported ABR version')) {
      throw new Error(
        `"${file.name}" uses an unsupported ABR format (legacy v1/v2). ` +
        'Please re-save the brush preset in a modern version of Photoshop (CS or later).'
      )
    }
    throw new Error(`Failed to parse "${file.name}": ${err.message}`)
  }

  const samples = abr.samples || []

  if (samples.length === 0) {
    throw new Error(
      `"${file.name}" contains no brush samples. ` +
      'Only sampled (bitmap) brushes can be imported; procedural brushes are not supported.'
    )
  }

  const baseName = file.name.replace(/\.[^.]+$/, '')
  const brushNames = abr.brushes || []

  const results = await Promise.all(
    samples.map(async (sample, index) => {
      const { w, h } = sample.bounds
      const brushEntry = brushNames[index]
      const brushName = brushEntry?.name?.trim()
        ? brushEntry.name.trim()
        : `${baseName} ${index + 1}`

      const sanitizedName = brushName.replace(/[/\\:*?"<>|]/g, '_')
      const pngFilename = `${sanitizedName}.png`
      const pngFile = await alphaToPngFile(sample.alpha, w, h, pngFilename)

      return { name: brushName, pngFile }
    })
  )

  return results
}
