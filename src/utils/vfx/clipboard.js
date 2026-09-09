// Copy and paste for curves and gradients, as PLAIN TEXT.
//
// ONE ENVELOPE, `{ __vfxClip, version, kind, payload }`, serialised as JSON and
// written to the clipboard as `text/plain` rather than a custom MIME type.
// That choice is the whole point of the module:
//
//   - a curve pastes into a chat message, a bug report, a source file or a
//     commit message, and comes back out again. For a developer audience that
//     is how a "share this ramp with me" conversation actually happens.
//   - `navigator.clipboard.write` with a custom type is unavailable in Firefox
//     and Safari and needs a permission prompt in Chrome, while
//     `writeText`/`readText` work everywhere the app runs.
//   - a human can read it. A base64 blob would be smaller and useless.
//
// THE `kind` FIELD IS CHECKED BEFORE PASTING. Pasting a gradient onto a size
// property has no meaning, and the failure has to be a message rather than a
// curve with `colorKeys` in it that the compiler then chokes on somewhere else.
//
// EVERY READ GOES THROUGH normalizeValue-STYLE REBUILDING. The text may have
// been hand-edited - that is a feature, not a hazard - so `createCurve` and
// `createGradient` re-sort and re-default whatever arrives. A pasted curve with
// keys out of order or a missing tangent is repaired, not rejected.

import { createCurve } from '../../../vfx/curve.js'
import { createGradient } from '../../../vfx/gradient.js'

const MAGIC = 'vfx-clip'
const VERSION = 1

export const CLIP_KIND = Object.freeze({
  CURVE: 'curve',
  GRADIENT: 'gradient',
})

/**
 * Serialise a curve or gradient into the envelope.
 *
 * @param {string} kind one of CLIP_KIND
 * @param {Object} payload a VfxCurve or VfxGradient
 * @returns {string} JSON, indented so it survives being read by a person
 */
export function encodeClip(kind, payload) {
  return JSON.stringify({ __vfxClip: MAGIC, version: VERSION, kind, payload }, null, 2)
}

/**
 * Parse an envelope back out of text.
 *
 * @param {string} text
 * @param {string} [expectKind] refuse anything else
 * @returns {{ok: true, kind: string, payload: Object} | {ok: false, error: string}}
 */
export function decodeClip(text, expectKind = null) {
  let parsed
  try {
    parsed = JSON.parse(String(text || ''))
  } catch {
    return { ok: false, error: 'That does not look like a copied curve or gradient.' }
  }
  if (!parsed || parsed.__vfxClip !== MAGIC) {
    return { ok: false, error: 'That does not look like a copied curve or gradient.' }
  }
  // A newer app wrote it. Refused with a message that says what to do, rather
  // than silently importing fields this build does not understand.
  if (parsed.version > VERSION) {
    return { ok: false, error: 'That was copied from a newer version of the editor.' }
  }
  if (expectKind && parsed.kind !== expectKind) {
    return {
      ok: false,
      error: `That is a ${parsed.kind}, and this property takes a ${expectKind}.`,
    }
  }

  // Rebuilt rather than trusted - see the header. Hand-edited text is an
  // intended input.
  if (parsed.kind === CLIP_KIND.CURVE) {
    const curve = parsed.payload || {}
    return {
      ok: true,
      kind: CLIP_KIND.CURVE,
      payload: createCurve(curve.keys, curve),
    }
  }
  if (parsed.kind === CLIP_KIND.GRADIENT) {
    return {
      ok: true,
      kind: CLIP_KIND.GRADIENT,
      payload: createGradient(parsed.payload || {}),
    }
  }
  return { ok: false, error: `Unknown clipboard kind "${parsed.kind}".` }
}

/**
 * Write text to the clipboard, best-effort.
 *
 * Returns false rather than throwing: the clipboard is denied outright in some
 * contexts (an insecure origin, a permissions policy, a headless capture), and
 * a copy that quietly did not happen should surface as a message rather than an
 * unhandled rejection in the console.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function writeClipText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Read text from the clipboard.
 *
 * `readText` needs a permission in Firefox, so a null return is the normal
 * "the browser said no" path and the caller should offer the paste-into-a-box
 * fallback rather than reporting a failure.
 *
 * @returns {Promise<string|null>}
 */
export async function readClipText() {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}
