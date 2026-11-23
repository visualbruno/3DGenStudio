// The one rule for attaching an OpenGL / glTF normal map (green = top of the
// image) to a three.js material. Every normal map the app produces is in that
// convention: Blender bakes (default swizzle +X +Y +Z) and the PBR tool.
//
// Whether three.js reads green that way depends on the UV orientation:
//   - glTF textures load with flipY = false, so V runs DOWN the image and, on a
//     mesh without a TANGENT attribute (three derives the frame from the UVs),
//     green has to be negated: normalScale.y = -1. GLTFLoader does exactly this
//     on import.
//   - with explicit tangents, or a flipY = true texture, +1 is right.
//
// This sign is ALSO what makes the saved file correct: GLTFExporter inverts the
// green channel of a tangent-less mesh whose normalScale.y > 0. Leaving a fresh
// material at its default (1, 1) therefore shows the bumps lit from below AND
// writes a DirectX-convention map into the GLB.
//
// No imports on purpose — meshExport, meshSegment, pbrMaterial and the editor
// all need it, and none of them should pull in the others.
export function normalScaleSignFor(texture, geometry) {
  return geometry?.attributes?.tangent || texture?.flipY ? 1 : -1
}

// Attach `normalMap` to `material` for a mesh with `geometry`, keeping the
// strength (|normalScale.x|, default 1) and setting the sign above.
export function setGltfNormalMap(material, normalMap, geometry, strength = null) {
  if (!material || !('normalMap' in material)) return
  material.normalMap = normalMap
  if (!normalMap || !material.normalScale) return
  const scale = strength ?? (Math.abs(material.normalScale.x) || 1)
  material.normalScale.set(scale, scale * normalScaleSignFor(normalMap, geometry))
}
