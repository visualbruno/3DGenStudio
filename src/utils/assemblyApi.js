// Client for the Mesh Assembly document API (/api/mesh-assemblies).
//
// Assemblies are GLOBAL — an assembly is a character (a base body plus the
// pieces being fitted onto it), and its pieces routinely come from different
// projects. So these live here as plain fetch helpers rather than in
// ProjectContext, exactly like the motion and custom-animation libraries
// (src/utils/motionGen.js, src/utils/customAnimations.js), which are global for
// the same reason.
//
// The document shape itself is owned by src/utils/assemblyHelpers.js; the
// server only round-trips it as JSON.
import { API_BASE } from '../config'

const ASSEMBLY_BASE = `${API_BASE}/mesh-assemblies`

async function assemblyJson(response, fallback) {
  if (!response.ok) {
    let message = `${fallback} (${response.status})`
    try {
      const payload = await response.json()
      message = payload.error || message
    } catch { /* non-JSON body — keep the status message */ }
    throw new Error(message)
  }
  return response.json()
}

const jsonRequest = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// Catalogue only — id, name, thumbnail, dates. The server deliberately omits
// each document's state here: a switcher needs none of it, and a 10-piece
// assembly with its landmark pairs is far too much to ship per row.
export async function listAssemblies() {
  const body = await assemblyJson(await fetch(ASSEMBLY_BASE), 'Could not load the assemblies')
  return body.assemblies || []
}

// The full document, including `state`. The only way to read a piece list.
export async function getAssembly(id) {
  const body = await assemblyJson(await fetch(`${ASSEMBLY_BASE}/${id}`), 'Could not load the assembly')
  return body.assembly
}

export async function createAssembly(name, state = null) {
  const body = await assemblyJson(
    await fetch(ASSEMBLY_BASE, jsonRequest('POST', { name, state })),
    'Could not create the assembly',
  )
  return body.assembly
}

// Each of the three writers below sends ONLY its own field. The server applies
// a partial update, so an autosave in flight can never clobber a rename (or the
// reverse) — which matters because the two fire from different UI affordances
// and routinely overlap.
export async function renameAssembly(id, name) {
  const body = await assemblyJson(
    await fetch(`${ASSEMBLY_BASE}/${id}`, jsonRequest('PUT', { name })),
    'Could not rename the assembly',
  )
  return body.assembly
}

export async function saveAssemblyState(id, state) {
  const body = await assemblyJson(
    await fetch(`${ASSEMBLY_BASE}/${id}`, jsonRequest('PUT', { state })),
    'Could not save the assembly',
  )
  return body.assembly
}

export async function setAssemblyThumbnail(id, thumbnailPath) {
  const body = await assemblyJson(
    await fetch(`${ASSEMBLY_BASE}/${id}`, jsonRequest('PUT', { thumbnailPath })),
    'Could not update the assembly thumbnail',
  )
  return body.assembly
}

export async function deleteAssembly(id) {
  return await assemblyJson(
    await fetch(`${ASSEMBLY_BASE}/${id}`, { method: 'DELETE' }),
    'Could not delete the assembly',
  )
}
