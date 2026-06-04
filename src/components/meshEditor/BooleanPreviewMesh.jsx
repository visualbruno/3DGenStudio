import { useEffect, useMemo } from 'react'
import * as THREE from 'three'

// R3F scene helper extracted from MeshEditorPage.jsx (behaviour-preserving move).
export default function BooleanPreviewMesh({
  geometry,
  maskTexture,
  maskWidth,
  maskHeight,
  stampMatrix,
  operation = 'union',
  size = 0.2,
  depth = 0.06,
  offset = 0.01,
  threshold = 24,
  previewColor = '#72ff9d',
  showShadows = false
}) {
  const uniforms = useMemo(() => ({
    uInvStamp: { value: new THREE.Matrix4() },
    uStampZ: { value: new THREE.Vector3(0, 0, 1) },
    uStampSize: { value: new THREE.Vector2(0.2, 0.2) },
    uDepth: { value: 0.06 },
    uThreshold: { value: 24 / 255 },
    uHitSide: { value: -1 },
    uSign: { value: 1 },
    uMask: { value: null },
    uBaseColor: { value: new THREE.Color('#a9b6ff') },
    uPreviewColor: { value: new THREE.Color('#72ff9d') }
  }), [])

  useEffect(() => {
    const maxDim = Math.max(maskWidth || 1, maskHeight || 1)
    const stampWidth = Math.max(1e-5, size * ((maskWidth || 1) / maxDim))
    const stampHeight = Math.max(1e-5, size * ((maskHeight || 1) / maxDim))
    const sign = (String(operation || 'out').toLowerCase() === 'out') ? 1 : -1

    uniforms.uInvStamp.value.copy(stampMatrix).invert()
    uniforms.uStampSize.value.set(stampWidth, stampHeight)
    uniforms.uDepth.value = Math.max(1e-5, depth)
    uniforms.uThreshold.value = Math.max(0, Math.min(1, threshold / 255))
    uniforms.uHitSide.value = offset < 0 ? 1 : -1
    uniforms.uSign.value = sign
    uniforms.uMask.value = maskTexture
    uniforms.uPreviewColor.value.set(previewColor)

    const stampZ = new THREE.Vector3().setFromMatrixColumn(stampMatrix, 2).normalize()
    uniforms.uStampZ.value.copy(stampZ)
  }, [depth, maskHeight, maskTexture, maskWidth, offset, operation, previewColor, size, stampMatrix, threshold, uniforms])

  useEffect(() => () => {
    uniforms.uPreviewColor.value?.dispose?.()
  }, [uniforms])

  return (
    <group>
      <mesh geometry={geometry} castShadow={showShadows} receiveShadow={showShadows}>
        <shaderMaterial
          uniforms={uniforms}
          side={THREE.DoubleSide}
          transparent={false}
          depthTest
          depthWrite
          vertexShader={`
            varying vec3 vNormal;
            varying float vStrength;

            uniform mat4 uInvStamp;
            uniform vec3 uStampZ;
            uniform vec2 uStampSize;
            uniform float uDepth;
            uniform float uThreshold;
            uniform float uHitSide;
            uniform float uSign;
            uniform sampler2D uMask;

            void main() {
              vec3 displaced = position;
              float strength = 0.0;

              vec3 localPoint = (uInvStamp * vec4(position, 1.0)).xyz;
              float halfW = uStampSize.x * 0.5;
              float halfH = uStampSize.y * 0.5;
              float u = (localPoint.x + halfW) / uStampSize.x;
              float v = (halfH - localPoint.y) / uStampSize.y;

              if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) {
                float alpha = texture2D(uMask, vec2(u, v)).r;
                if (alpha >= uThreshold) {
                  float sideDistance = localPoint.z * uHitSide;
                  if (sideDistance >= 0.0) {
                    float zFalloff = max(0.0, 1.0 - sideDistance / (uDepth * 2.0));
                    float edgeU = min(u, 1.0 - u);
                    float edgeV = min(v, 1.0 - v);
                    float edgeSoftness = clamp(uThreshold, 0.02, 0.22);
                    float edgeWeight = min(1.0, min(edgeU, edgeV) / edgeSoftness);

                    strength = uDepth * alpha * zFalloff * edgeWeight;
                    displaced += uStampZ * (uSign * strength);
                  }
                }
              }

              vStrength = strength;
              vNormal = normalize(normalMatrix * normal);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
            }
          `}
          fragmentShader={`
            varying vec3 vNormal;
            varying float vStrength;

            uniform vec3 uBaseColor;
            uniform vec3 uPreviewColor;
            uniform float uDepth;

            void main() {
              vec3 n = normalize(vNormal);
              vec3 l1 = normalize(vec3(0.4, 0.8, 0.5));
              vec3 l2 = normalize(vec3(-0.55, 0.35, -0.45));
              float lambert = 0.28 + 0.52 * max(dot(n, l1), 0.0) + 0.20 * max(dot(n, l2), 0.0);
              float normalizedStrength = clamp(vStrength / max(uDepth, 1e-5), 0.0, 1.0);
              float t = smoothstep(0.08, 0.55, normalizedStrength);
              vec3 base = mix(uBaseColor, uPreviewColor, t);
              vec3 lit = base * lambert + (uPreviewColor * (0.18 * t));
              gl_FragColor = vec4(lit, 1.0);
            }
          `}
        />
      </mesh>
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.08} depthWrite={false} />
      </mesh>
    </group>
  )
}
