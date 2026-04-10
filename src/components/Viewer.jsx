import { Canvas } from '@react-three/fiber'
import { OrbitControls, Stage, Grid, PerspectiveCamera, Environment } from '@react-three/drei'
import { Suspense } from 'react'

function PlaceholderMesh() {
  return (
    <mesh castShadow receiveShadow>
      <torusKnotGeometry args={[1, 0.3, 128, 32]} />
      <meshPhysicalMaterial 
        color="#AC89FF" 
        roughness={0.1} 
        metalness={1} 
        emissive="#AC89FF"
        emissiveIntensity={0.2}
      />
    </mesh>
  )
}

export default function Viewer({ height = '100%' }) {
  return (
    <div style={{ width: '100%', height, background: '#0D0E10', borderRadius: '8px', overflow: 'hidden' }}>
      <Canvas shadows>
        <PerspectiveCamera makeDefault position={[3, 3, 5]} />
        <Suspense fallback={null}>
          <Stage environment="city" intensity={0.5} contactShadow={{ opacity: 0.4, blur: 2 }}>
            <PlaceholderMesh />
          </Stage>
          <Grid 
            infiniteGrid 
            fadeDistance={30} 
            cellColor="#47484A" 
            sectionColor="#AC89FF" 
            sectionThickness={1.5}
            sectionSize={10}
          />
        </Suspense>
        <Environment preset="night" />
        <OrbitControls makeDefault autoRotate autoRotateSpeed={0.5} />
      </Canvas>
    </div>
  )
}
