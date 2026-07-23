import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

interface AmbientChemistrySceneProps {
  reducedMotion: boolean;
}

interface FloatingRigProps {
  children: React.ReactNode;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: number;
  speed: number;
  phase: number;
  drift: number;
  reducedMotion: boolean;
}

interface WireShapeProps {
  geometry: THREE.BufferGeometry;
  color: string;
  opacity?: number;
}

const BLUE = '#6e8fb9';
const TEAL = '#718991';
const AMBER = '#89919c';
const GRAPHITE = '#66717f';

function useDisposable<T extends { dispose(): void }>(
  factory: () => T,
  deps: readonly unknown[],
): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(factory, deps);
  useEffect(() => () => value.dispose(), [value]);
  return value;
}

function lineGeometry(segments: Array<readonly [THREE.Vector3, THREE.Vector3]>) {
  const positions = new Float32Array(segments.length * 6);
  segments.forEach(([start, end], index) => {
    positions.set([start.x, start.y, start.z, end.x, end.y, end.z], index * 6);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function latheWireGeometry(
  profile: ReadonlyArray<readonly [number, number]>,
  radialSegments = 18,
  ribStep = 3,
) {
  const segments: Array<readonly [THREE.Vector3, THREE.Vector3]> = [];
  const point = (y: number, radius: number, angle: number) =>
    new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);

  profile.forEach(([y, radius]) => {
    for (let index = 0; index < radialSegments; index += 1) {
      const angle = (index / radialSegments) * Math.PI * 2;
      const next = ((index + 1) / radialSegments) * Math.PI * 2;
      segments.push([point(y, radius, angle), point(y, radius, next)]);
    }
  });

  for (let index = 0; index < radialSegments; index += ribStep) {
    const angle = (index / radialSegments) * Math.PI * 2;
    for (let profileIndex = 0; profileIndex < profile.length - 1; profileIndex += 1) {
      const [startY, startRadius] = profile[profileIndex];
      const [endY, endRadius] = profile[profileIndex + 1];
      segments.push([
        point(startY, startRadius, angle),
        point(endY, endRadius, angle),
      ]);
    }
  }

  return lineGeometry(segments);
}

function boxWireGeometry(width: number, height: number, depth: number) {
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const corners = [
    new THREE.Vector3(-x, -y, -z),
    new THREE.Vector3(x, -y, -z),
    new THREE.Vector3(x, y, -z),
    new THREE.Vector3(-x, y, -z),
    new THREE.Vector3(-x, -y, z),
    new THREE.Vector3(x, -y, z),
    new THREE.Vector3(x, y, z),
    new THREE.Vector3(-x, y, z),
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ] as const;
  return lineGeometry(edges.map(([start, end]) => [corners[start], corners[end]]));
}

function curveWireGeometry(points: THREE.Vector3[]) {
  const sampled = new THREE.CatmullRomCurve3(points).getPoints(56);
  const segments = sampled.slice(1).map((point, index) => [sampled[index], point] as const);
  return lineGeometry(segments);
}

function WireShape({ geometry, color, opacity = 0.34 }: WireShapeProps) {
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </lineSegments>
  );
}

function FloatingRig({
  children,
  position,
  rotation,
  scale,
  speed,
  phase,
  drift,
  reducedMotion,
}: FloatingRigProps) {
  const rig = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (!rig.current || reducedMotion) return;
    const time = clock.elapsedTime * speed + phase;
    rig.current.position.set(
      position[0] + Math.sin(time * 0.63) * drift,
      position[1] + Math.cos(time * 0.82) * drift * 0.72,
      position[2] + Math.sin(time * 0.47) * drift * 0.42,
    );
    rig.current.rotation.set(
      rotation[0] + Math.sin(time * 0.41) * 0.12,
      rotation[1] + time * 0.16,
      rotation[2] + Math.cos(time * 0.52) * 0.08,
    );
  });

  return (
    <group
      ref={rig}
      position={[position[0], position[1], position[2]]}
      rotation={[rotation[0], rotation[1], rotation[2]]}
      scale={scale}
    >
      {children}
    </group>
  );
}

function Flask() {
  const outline = useDisposable(
    () => latheWireGeometry([
      [1.65, 0.28],
      [1.5, 0.36],
      [0.72, 0.3],
      [-0.72, 1.04],
      [-1.12, 0.92],
    ]),
    [],
  );
  const liquid = useDisposable(
    () => latheWireGeometry([
      [-0.44, 0.82],
      [-0.72, 1.04],
      [-1.1, 0.91],
    ], 18, 6),
    [],
  );

  return (
    <group>
      <WireShape geometry={outline} color={TEAL} opacity={0.42} />
      <WireShape geometry={liquid} color={BLUE} opacity={0.3} />
      <mesh position={[0, -0.78, 0]}>
        <cylinderGeometry args={[0.95, 0.88, 0.56, 24, 1, true]} />
        <meshPhysicalMaterial
          color={BLUE}
          transparent
          opacity={0.035}
          roughness={0.28}
          transmission={0.72}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function Beaker() {
  const outline = useDisposable(
    () => latheWireGeometry([
      [1.28, 0.84],
      [1.15, 0.76],
      [-1.15, 0.72],
      [-1.28, 0.62],
    ], 20, 4),
    [],
  );
  const liquid = useDisposable(
    () => latheWireGeometry([
      [-0.12, 0.74],
      [-1.14, 0.72],
      [-1.27, 0.62],
    ], 20, 5),
    [],
  );

  return (
    <group>
      <WireShape geometry={outline} color={BLUE} opacity={0.4} />
      <WireShape geometry={liquid} color={TEAL} opacity={0.28} />
      <mesh position={[0, -0.68, 0]}>
        <cylinderGeometry args={[0.73, 0.66, 1.08, 28, 1, true]} />
        <meshPhysicalMaterial
          color={TEAL}
          transparent
          opacity={0.03}
          transmission={0.8}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function ElectrochemicalCell() {
  const leftBeaker = useDisposable(
    () => latheWireGeometry([[0.74, 0.62], [-0.76, 0.6], [-0.86, 0.5]], 16, 4),
    [],
  );
  const electrode = useDisposable(() => boxWireGeometry(0.24, 1.75, 0.24), []);
  const bridge = useDisposable(
    () => curveWireGeometry([
      new THREE.Vector3(-1.15, 0.18, 0),
      new THREE.Vector3(-0.74, 1.25, 0.15),
      new THREE.Vector3(0, 1.5, 0.35),
      new THREE.Vector3(0.74, 1.25, 0.15),
      new THREE.Vector3(1.15, 0.18, 0),
    ]),
    [],
  );
  const circuit = useDisposable(
    () => curveWireGeometry([
      new THREE.Vector3(-1.15, 0.9, -0.05),
      new THREE.Vector3(-0.82, 1.92, -0.12),
      new THREE.Vector3(0, 2.2, -0.16),
      new THREE.Vector3(0.82, 1.92, -0.12),
      new THREE.Vector3(1.15, 0.9, -0.05),
    ]),
    [],
  );

  return (
    <group>
      <group position={[-0.92, -0.25, 0]}>
        <WireShape geometry={leftBeaker} color={TEAL} opacity={0.34} />
      </group>
      <group position={[0.92, -0.25, 0]}>
        <WireShape geometry={leftBeaker} color={BLUE} opacity={0.34} />
      </group>
      <group position={[-1.12, 0.25, 0]}>
        <WireShape geometry={electrode} color={AMBER} opacity={0.45} />
      </group>
      <group position={[1.12, 0.25, 0]}>
        <WireShape geometry={electrode} color={GRAPHITE} opacity={0.45} />
      </group>
      <WireShape geometry={bridge} color={TEAL} opacity={0.34} />
      <WireShape geometry={circuit} color={BLUE} opacity={0.42} />
      <mesh position={[0, 2.16, -0.16]}>
        <torusGeometry args={[0.28, 0.018, 8, 32]} />
        <meshBasicMaterial
          color={AMBER}
          transparent
          opacity={0.32}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function Condenser() {
  const shell = useDisposable(
    () => latheWireGeometry([[1.5, 0.46], [-1.5, 0.46]], 14, 2),
    [],
  );
  const coil = useDisposable(() => {
    const points = Array.from({ length: 90 }, (_, index) => {
      const progress = index / 89;
      const angle = progress * Math.PI * 9;
      return new THREE.Vector3(
        Math.cos(angle) * 0.28,
        1.36 - progress * 2.72,
        Math.sin(angle) * 0.28,
      );
    });
    const segments = points.slice(1).map((point, index) => [points[index], point] as const);
    return lineGeometry(segments);
  }, []);
  const nozzle = useDisposable(
    () => curveWireGeometry([
      new THREE.Vector3(-0.45, 0.82, 0),
      new THREE.Vector3(-0.92, 0.82, 0),
      new THREE.Vector3(-1.2, 0.58, 0),
    ]),
    [],
  );

  return (
    <group>
      <WireShape geometry={shell} color={GRAPHITE} opacity={0.3} />
      <WireShape geometry={coil} color={TEAL} opacity={0.42} />
      <WireShape geometry={nozzle} color={BLUE} opacity={0.32} />
      <group rotation={[0, Math.PI, Math.PI]} position={[0, 0, 0]}>
        <WireShape geometry={nozzle} color={AMBER} opacity={0.28} />
      </group>
    </group>
  );
}

function Molecule() {
  const atomPositions = useMemo(() => [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1.08, 0.66, 0.42),
    new THREE.Vector3(-1.05, 0.58, -0.35),
    new THREE.Vector3(0.42, -1.08, -0.62),
    new THREE.Vector3(-0.5, -0.92, 0.75),
  ], []);
  const bonds = useDisposable(
    () => lineGeometry(atomPositions.slice(1).map((position) => [atomPositions[0], position])),
    [atomPositions],
  );

  return (
    <group>
      <WireShape geometry={bonds} color={GRAPHITE} opacity={0.34} />
      {atomPositions.map((position, index) => (
        <mesh key={`${position.x}-${position.y}`} position={position}>
          <icosahedronGeometry args={[index === 0 ? 0.34 : 0.24, 1]} />
          <meshBasicMaterial
            color={index === 0 ? AMBER : index % 2 ? BLUE : TEAL}
            transparent
            opacity={index === 0 ? 0.28 : 0.22}
            wireframe
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function SpatialGrid() {
  const grid = useRef<THREE.GridHelper>(null);

  useEffect(() => {
    if (!grid.current) return;
    const materials = Array.isArray(grid.current.material)
      ? grid.current.material
      : [grid.current.material];
    materials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.1;
      material.depthWrite = false;
    });
  }, []);

  return (
    <gridHelper
      ref={grid}
      args={[26, 26, '#a9bad2', '#cbd6e4']}
      position={[0, -4.25, -4]}
      rotation={[0.28, 0, 0]}
    />
  );
}

function BackdropWorld({ reducedMotion }: AmbientChemistrySceneProps) {
  const viewport = useThree((state) => state.viewport);
  const compact = viewport.width < 6;
  const x = Math.max(viewport.width * 0.4, compact ? 1.25 : 3.6);
  const y = viewport.height * 0.36;

  return (
    <>
      <SpatialGrid />
      <FloatingRig
        position={[-x, y, -1.2]}
        rotation={[0.2, -0.42, -0.14]}
        scale={compact ? 0.56 : 0.76}
        speed={0.35}
        phase={0.2}
        drift={compact ? 0.12 : 0.25}
        reducedMotion={reducedMotion}
      >
        <Flask />
      </FloatingRig>
      <FloatingRig
        position={[x * 0.98, y * 0.72, -1.8]}
        rotation={[-0.15, 0.46, 0.08]}
        scale={compact ? 0.48 : 0.68}
        speed={0.29}
        phase={2.1}
        drift={compact ? 0.1 : 0.23}
        reducedMotion={reducedMotion}
      >
        <ElectrochemicalCell />
      </FloatingRig>
      <FloatingRig
        position={[x * 1.05, -y * 0.92, -0.7]}
        rotation={[0.18, -0.6, 0.12]}
        scale={compact ? 0.52 : 0.72}
        speed={0.32}
        phase={4.4}
        drift={compact ? 0.1 : 0.2}
        reducedMotion={reducedMotion}
      >
        <Beaker />
      </FloatingRig>
      {!compact ? (
        <>
          <FloatingRig
            position={[-x * 0.82, -y * 0.92, -2.1]}
            rotation={[-0.12, 0.28, -0.08]}
            scale={0.7}
            speed={0.27}
            phase={5.8}
            drift={0.22}
            reducedMotion={reducedMotion}
          >
            <Molecule />
          </FloatingRig>
          <FloatingRig
            position={[x * 0.12, -y * 1.18, -2.8]}
            rotation={[0.18, 0.2, 0.06]}
            scale={0.56}
            speed={0.24}
            phase={3.2}
            drift={0.18}
            reducedMotion={reducedMotion}
          >
            <Condenser />
          </FloatingRig>
        </>
      ) : null}
    </>
  );
}

export function AmbientChemistryScene({ reducedMotion }: AmbientChemistrySceneProps) {
  return (
    <Canvas
      className="ambient-chemistry__canvas"
      camera={{ position: [0, 0, 10], fov: 38, near: 0.1, far: 40 }}
      dpr={[1, 1.5]}
      frameloop={reducedMotion ? 'demand' : 'always'}
      gl={{
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,
      }}
    >
      <BackdropWorld reducedMotion={reducedMotion} />
    </Canvas>
  );
}
