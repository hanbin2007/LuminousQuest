import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import type { ModelScene, SceneNode } from './lighting';

/** 与 tokens.css 的 .stage-dark 保持同源;canvas 内无法读 CSS 变量,此处为唯一镜像点。 */
export const STAGE = {
  bg: '#0a1526',
  fog: '#101f38',
  glow: { device: '#5b8de8', principle: '#3fe0d8', energy: '#ffb84d' } as const,
  unlit: '#2a3a52',
  unassessed: '#5a636d',
  needsReview: '#e8960c',
  text: '#d7e2ef',
};

const IGNITION_STAGGER = 0.08; // 每节点点亮间隔(秒),与 ui-style-guide §2③ 一致

function glowTexture(color: string) {
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

function labelTexture(text: string, color: string) {
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
}

function NodeVisual({ node, ignitionStart, reducedMotion, selected, onSelect }: NodeVisualProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const spriteRef = useRef<THREE.Sprite>(null);
  const lit = node.light === 'full-lit' || node.light === 'half-lit';
  const dimGlow = STAGE.glow[node.dimensionId];

  const { color, emissiveIntensity, glowScale, opacity } = useMemo(() => {
    switch (node.light) {
      case 'full-lit': return { color: dimGlow, emissiveIntensity: 1.6, glowScale: 2.8, opacity: 1 };
      case 'half-lit': return { color: dimGlow, emissiveIntensity: 0.7, glowScale: 1.8, opacity: 0.85 };
      case 'needs-review': return { color: STAGE.needsReview, emissiveIntensity: 0.25, glowScale: 0, opacity: 0.9 };
      case 'unassessed': return { color: STAGE.unassessed, emissiveIntensity: 0, glowScale: 0, opacity: 0.45 };
      default: return { color: STAGE.unlit, emissiveIntensity: 0, glowScale: 0, opacity: 0.9 };
    }
  }, [node.light, dimGlow]);

  const glowMap = useMemo(() => (lit ? glowTexture(dimGlow) : null), [lit, dimGlow]);
  const tagMap = useMemo(
    () => labelTexture(node.id, lit ? '#ffffff' : STAGE.text),
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
    material.emissiveIntensity = emissiveIntensity * eased;
    meshRef.current.scale.setScalar(0.7 + 0.3 * eased + (selected ? 0.12 : 0));
    if (spriteRef.current) {
      const breathe = lit ? 0.75 + 0.25 * Math.sin(clock.elapsedTime * 2 + (node.ignitionIndex ?? 0)) : 0;
      (spriteRef.current.material as THREE.SpriteMaterial).opacity = breathe * eased;
      spriteRef.current.scale.setScalar(glowScale * (0.6 + 0.4 * eased));
    }
    if (node.light === 'needs-review') {
      material.emissiveIntensity = 0.2 + 0.15 * Math.sin(clock.elapsedTime * 3);
    }
  });

  const position: [number, number, number] = [node.position.x * 1.45, node.position.y * 1.45, node.position.z * 1.45];
  return (
    <group position={position}>
      <mesh
        ref={meshRef}
        onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}
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
      {glowMap ? (
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

function Edges({ scene }: { scene: ModelScene }) {
  const nodeById = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene.nodes]);
  const pulseRef = useRef<THREE.LineBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (pulseRef.current) pulseRef.current.opacity = 0.55 + 0.3 * Math.sin(clock.elapsedTime * 1.6);
  });
  const groups = useMemo(() => {
    const plain: THREE.Vector3[] = [];
    const crossLit: THREE.Vector3[] = [];
    for (const edge of scene.edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const pair = [
        new THREE.Vector3(from.position.x * 1.45, from.position.y * 1.45, from.position.z * 1.45),
        new THREE.Vector3(to.position.x * 1.45, to.position.y * 1.45, to.position.z * 1.45),
      ];
      (edge.crossAxis && edge.bothLit ? crossLit : plain).push(...pair);
    }
    return { plain, crossLit };
  }, [scene.edges, nodeById]);

  return (
    <group>
      {groups.plain.length > 0 ? (
        <lineSegments geometry={new THREE.BufferGeometry().setFromPoints(groups.plain)}>
          <lineBasicMaterial color={STAGE.text} transparent opacity={0.16} />
        </lineSegments>
      ) : null}
      {groups.crossLit.length > 0 ? (
        <lineSegments geometry={new THREE.BufferGeometry().setFromPoints(groups.crossLit)}>
          <lineBasicMaterial ref={pulseRef} color={STAGE.glow.principle} transparent opacity={0.7} />
        </lineSegments>
      ) : null}
    </group>
  );
}

function AxisRails() {
  const axes = useMemo(() => ([
    { color: STAGE.glow.device, points: [new THREE.Vector3(-6.1, 0, 0), new THREE.Vector3(6.1, 0, 0)], label: '装置', at: new THREE.Vector3(6.7, 0, 0) },
    { color: STAGE.glow.principle, points: [new THREE.Vector3(0, -0.9, 0), new THREE.Vector3(0, 9.3, 0)], label: '原理', at: new THREE.Vector3(0, 9.9, 0) },
    { color: STAGE.glow.energy, points: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(-4.1, -3.5, 2.3)], label: '能量', at: new THREE.Vector3(-4.6, -4.0, 2.7) },
  ]), []);
  return (
    <group>
      {axes.map((axis) => (
        <group key={axis.label}>
          <lineSegments geometry={new THREE.BufferGeometry().setFromPoints(axis.points)}>
            <lineBasicMaterial color={axis.color} transparent opacity={0.5} />
          </lineSegments>
          <sprite position={axis.at.toArray() as [number, number, number]} scale={[1.1, 0.55, 1]}>
            <spriteMaterial map={labelTexture(axis.label, axis.color)} transparent depthWrite={false} />
          </sprite>
        </group>
      ))}
    </group>
  );
}

function Rig({ reducedMotion }: { reducedMotion: boolean }) {
  const { camera, gl } = useThree();
  const state = useRef({ yaw: 0.6, pitch: 0.35, radius: 11.5, dragging: false, lastX: 0, lastY: 0, idleAt: 0 });

  useEffect(() => {
    const element = gl.domElement;
    const current = state.current;
    const down = (event: PointerEvent) => {
      current.dragging = true;
      current.lastX = event.clientX;
      current.lastY = event.clientY;
    };
    const move = (event: PointerEvent) => {
      if (!current.dragging) return;
      current.yaw -= (event.clientX - current.lastX) * 0.005;
      current.pitch = THREE.MathUtils.clamp(current.pitch + (event.clientY - current.lastY) * 0.004, -0.2, 1.2);
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      current.idleAt = performance.now();
    };
    const up = () => { current.dragging = false; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      current.radius = THREE.MathUtils.clamp(current.radius + event.deltaY * 0.01, 7, 24);
      current.idleAt = performance.now();
    };
    element.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      element.removeEventListener('wheel', wheel);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const current = state.current;
    const idle = performance.now() - current.idleAt > 3000;
    if (!reducedMotion && idle && !current.dragging) current.yaw += delta * 0.08;
    const target = new THREE.Vector3(0, 3.6, 0);
    camera.position.set(
      target.x + current.radius * Math.cos(current.pitch) * Math.sin(current.yaw),
      target.y + current.radius * Math.sin(current.pitch),
      target.z + current.radius * Math.cos(current.pitch) * Math.cos(current.yaw),
    );
    camera.lookAt(target);
  });
  return null;
}

export interface KnowledgeSceneProps {
  scene: ModelScene;
  /** 传入非空即重放点亮序列(时间基准由内部时钟重置)。 */
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
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 52, near: 0.1, far: 100 }}
      onPointerMissed={() => onSelect(null)}
      style={{ background: STAGE.bg }}
    >
      <fog attach="fog" args={[STAGE.fog, 16, 40]} />
      <ambientLight color="#8899bb" intensity={0.55} />
      <directionalLight position={[5, 8, 6]} intensity={0.8} />
      <AxisRails />
      <Edges scene={scene} />
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
                onSelect={(id) => onSelect(id)}
              />
            ))}
          </group>
        )}
      </IgnitionClock>
      <Rig reducedMotion={reducedMotion} />
    </Canvas>
  );
}
