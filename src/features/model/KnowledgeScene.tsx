import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';

import type { ModelScene, SceneNode } from './lighting';
import {
  attachOrbitControls,
  createOrbitState,
  stepOrbit,
} from './orbit-controls';
import { STAGE } from './stage-tokens';

export { STAGE } from './stage-tokens';

const IGNITION_STAGGER = 0.08; // 每节点点亮间隔(秒),与 ui-style-guide §2③ 一致
const SCENE_SCALE = 1.45;
const CAMERA_TARGET = new THREE.Vector3(0, 3.6, 0); // 只读,useFrame 内零分配
const DRAG_SUPPRESS_PX = 6; // 位移超过该阈值视为拖拽,抑制节点点击

/** three 资源(texture/geometry)统一经此挂 cleanup,防 GPU 泄漏。 */
function useDisposable<T extends { dispose(): void }>(factory: () => T, deps: readonly unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(factory, deps);
  useEffect(() => () => value.dispose(), [value]);
  return value;
}

function makeGlowTexture(color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.35, `${color}aa`);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function makeLabelTexture(text: string, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.font = '600 40px ui-monospace, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, 64, 32);
  return new THREE.CanvasTexture(canvas);
}

interface NodeVisualProps {
  node: SceneNode;
  ignitionStart: number | null;
  reducedMotion: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  suppressClick: MutableRefObject<boolean>;
}

function NodeVisual({ node, ignitionStart, reducedMotion, selected, onSelect, suppressClick }: NodeVisualProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const spriteRef = useRef<THREE.Sprite>(null);
  const lit = node.light === 'full-lit' || node.light === 'half-lit';
  const dimGlow = STAGE.glow[node.dimensionId];

  const { color, emissiveIntensity, glowScale, opacity } = useMemo(() => {
    switch (node.light) {
      case 'full-lit': return { color: dimGlow, emissiveIntensity: 1.6, glowScale: 2.8, opacity: 1 };
      case 'half-lit': return { color: dimGlow, emissiveIntensity: 0.7, glowScale: 1.8, opacity: 0.85 };
      case 'needs-review': return { color: STAGE.needsReview, emissiveIntensity: 0.3, glowScale: 0, opacity: 0.9 };
      case 'unassessed': return { color: STAGE.unassessed, emissiveIntensity: 0, glowScale: 0, opacity: 0.45 };
      default: return { color: STAGE.unlit, emissiveIntensity: 0, glowScale: 0, opacity: 0.9 };
    }
  }, [node.light, dimGlow]);

  const glowMap = useDisposable(
    () => (lit ? makeGlowTexture(dimGlow) : new THREE.Texture()),
    [lit, dimGlow],
  );
  const tagMap = useDisposable(
    () => makeLabelTexture(node.id, lit ? '#ffffff' : STAGE.text),
    [node.id, lit],
  );

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const material = meshRef.current.material as THREE.MeshStandardMaterial;
    let progress = 1;
    if (lit && !reducedMotion && ignitionStart !== null && node.ignitionIndex !== null) {
      const igniteAt = ignitionStart + node.ignitionIndex * IGNITION_STAGGER;
      progress = THREE.MathUtils.clamp((clock.elapsedTime - igniteAt) / 0.45, 0, 1);
    }
    const eased = 1 - (1 - progress) ** 3;
    material.emissiveIntensity = node.light === 'needs-review'
      ? (reducedMotion ? 0.3 : 0.2 + 0.15 * Math.sin(clock.elapsedTime * 3))
      : emissiveIntensity * eased;
    meshRef.current.scale.setScalar(0.7 + 0.3 * eased + (selected ? 0.12 : 0));
    if (spriteRef.current) {
      const breathe = lit
        ? (reducedMotion ? 0.85 : 0.75 + 0.25 * Math.sin(clock.elapsedTime * 2 + (node.ignitionIndex ?? 0)))
        : 0;
      (spriteRef.current.material as THREE.SpriteMaterial).opacity = breathe * eased;
      spriteRef.current.scale.setScalar(glowScale * (0.6 + 0.4 * eased));
    }
  });

  const position: [number, number, number] = [
    node.position.x * SCENE_SCALE,
    node.position.y * SCENE_SCALE,
    node.position.z * SCENE_SCALE,
  ];
  return (
    <group position={position}>
      <mesh
        ref={meshRef}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClick.current) return;
          onSelect(node.id);
        }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      >
        <sphereGeometry args={[0.34, 32, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={lit || node.light === 'needs-review' ? color : '#000000'}
          transparent
          opacity={opacity}
          roughness={0.35}
          metalness={0.1}
        />
      </mesh>
      {lit ? (
        <sprite ref={spriteRef}>
          <spriteMaterial map={glowMap} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
      ) : null}
      <sprite position={[0, 0.55, 0]} scale={[0.66, 0.33, 1]}>
        <spriteMaterial map={tagMap} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}

function toScaled(node: SceneNode) {
  return new THREE.Vector3(node.position.x * SCENE_SCALE, node.position.y * SCENE_SCALE, node.position.z * SCENE_SCALE);
}

function Edges({ scene, reducedMotion }: { scene: ModelScene; reducedMotion: boolean }) {
  const pulseRef = useRef<THREE.LineBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (pulseRef.current) {
      pulseRef.current.opacity = reducedMotion ? 0.7 : 0.55 + 0.3 * Math.sin(clock.elapsedTime * 1.6);
    }
  });
  const nodeById = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene.nodes]);
  const plainGeometry = useDisposable(() => {
    const points: THREE.Vector3[] = [];
    for (const edge of scene.edges) {
      if (edge.crossAxis && edge.bothLit) continue;
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (from && to) points.push(toScaled(from), toScaled(to));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [scene.edges, nodeById]);
  const crossGeometry = useDisposable(() => {
    const points: THREE.Vector3[] = [];
    for (const edge of scene.edges) {
      if (!(edge.crossAxis && edge.bothLit)) continue;
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (from && to) points.push(toScaled(from), toScaled(to));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [scene.edges, nodeById]);

  return (
    <group>
      <lineSegments geometry={plainGeometry}>
        <lineBasicMaterial color={STAGE.text} transparent opacity={0.16} />
      </lineSegments>
      <lineSegments geometry={crossGeometry}>
        <lineBasicMaterial ref={pulseRef} color={STAGE.glow.principle} transparent opacity={0.7} />
      </lineSegments>
    </group>
  );
}

const AXES = [
  { color: STAGE.glow.device, from: new THREE.Vector3(-6.1, 0, 0), to: new THREE.Vector3(6.1, 0, 0), label: '装置', at: [6.7, 0, 0] as const },
  { color: STAGE.glow.principle, from: new THREE.Vector3(0, -0.9, 0), to: new THREE.Vector3(0, 9.3, 0), label: '原理', at: [0, 9.9, 0] as const },
  { color: STAGE.glow.energy, from: new THREE.Vector3(0, 0, 0), to: new THREE.Vector3(-4.1, -3.5, 2.3), label: '能量', at: [-4.6, -4.0, 2.7] as const },
];

function AxisRail({ axis }: { axis: (typeof AXES)[number] }) {
  const geometry = useDisposable(
    () => new THREE.BufferGeometry().setFromPoints([axis.from, axis.to]),
    [axis],
  );
  const label = useDisposable(() => makeLabelTexture(axis.label, axis.color), [axis]);
  return (
    <group>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color={axis.color} transparent opacity={0.5} />
      </lineSegments>
      <sprite position={[axis.at[0], axis.at[1], axis.at[2]]} scale={[1.1, 0.55, 1]}>
        <spriteMaterial map={label} transparent depthWrite={false} />
      </sprite>
    </group>
  );
}

function Rig({ reducedMotion, suppressClick }: {
  reducedMotion: boolean;
  suppressClick: MutableRefObject<boolean>;
}) {
  const { camera, gl, invalidate } = useThree();
  const state = useRef(createOrbitState({ yaw: 0.6, pitch: 0.35, radius: 11.5 }));
  const downAt = useRef({ x: 0, y: 0 });

  useEffect(() => attachOrbitControls(gl.domElement, state.current, MODEL_ORBIT_BOUNDS, {
    down(event) {
      downAt.current.x = event.clientX;
      downAt.current.y = event.clientY;
      suppressClick.current = false;
    },
    move(event) {
      if (Math.hypot(event.clientX - downAt.current.x, event.clientY - downAt.current.y) > DRAG_SUPPRESS_PX) {
        suppressClick.current = true;
      }
    },
    input: invalidate,
  }), [gl, suppressClick, invalidate]);

  useFrame((_, delta) => {
    const current = state.current;
    stepOrbit(current, MODEL_ORBIT_BOUNDS, delta, reducedMotion);
    const idle = performance.now() - current.idleAt > 3000;
    if (!reducedMotion && idle && !current.dragging && current.yawVelocity === 0) {
      current.yaw += delta * 0.08;
    }
    camera.position.set(
      CAMERA_TARGET.x + current.radius * Math.cos(current.pitch) * Math.sin(current.yaw),
      CAMERA_TARGET.y + current.radius * Math.sin(current.pitch),
      CAMERA_TARGET.z + current.radius * Math.cos(current.pitch) * Math.cos(current.yaw),
    );
    camera.lookAt(CAMERA_TARGET);
  });
  return null;
}

const MODEL_ORBIT_BOUNDS = {
  minPitch: -0.2,
  maxPitch: 1.2,
  minRadius: 7,
  maxRadius: 24,
} as const;

export interface KnowledgeSceneProps {
  scene: ModelScene;
  /** 递增即重放点亮序列。 */
  replayToken: number;
  reducedMotion: boolean;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
}

function IgnitionClock({ replayToken, children }: {
  replayToken: number;
  children: (start: number | null) => React.ReactElement;
}) {
  const clock = useThree((state) => state.clock);
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => {
    setStart(clock.elapsedTime + 0.2);
  }, [replayToken, clock]);
  return children(start);
}

export function KnowledgeScene({ scene, replayToken, reducedMotion, onSelect, selectedId }: KnowledgeSceneProps) {
  const suppressClick = useRef(false);
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 52, near: 0.1, far: 100 }}
      frameloop={reducedMotion ? 'demand' : 'always'}
      onPointerMissed={() => { if (!suppressClick.current) onSelect(null); }}
      style={{ background: STAGE.bg }}
    >
      <fog attach="fog" args={[STAGE.fog, 16, 40]} />
      <ambientLight color="#8899bb" intensity={0.55} />
      <directionalLight position={[5, 8, 6]} intensity={0.8} />
      {AXES.map((axis) => <AxisRail key={axis.label} axis={axis} />)}
      <Edges scene={scene} reducedMotion={reducedMotion} />
      <IgnitionClock replayToken={replayToken}>
        {(start) => (
          <group>
            {scene.nodes.map((node) => (
              <NodeVisual
                key={node.id}
                node={node}
                ignitionStart={start}
                reducedMotion={reducedMotion}
                selected={selectedId === node.id}
                onSelect={onSelect}
                suppressClick={suppressClick}
              />
            ))}
          </group>
        )}
      </IgnitionClock>
      <Rig reducedMotion={reducedMotion} suppressClick={suppressClick} />
    </Canvas>
  );
}
