import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import {
  attachOrbitControls,
  createOrbitState,
  stepOrbit,
} from './orbit-controls';
import { STAGE } from './stage-tokens';
import type { LiveCellState, LiveCellNode } from './live-cell';

/**
 * 训练分屏 · 抽象原电池 + 三维度叠加(陆老师《电化学统一认知模型》手稿的 3D 化)。
 * 装置维度即电池本体(D1 左电极 / D2 导线 / D3 电解液 / D4 右电极 / D5 双层环),
 * 原理维度为左侧纵向轨道(P1–P7 标记),能量维度为左下对角轨道(E1–E3 标记)。
 * 灯态/点亮/色彩语言与模块三 KnowledgeScene 完全同源。
 */

const IGNITION_STAGGER = 0.08;
const ELECTRODE_X = 3;
const WIRE_TOP_Y = 4.3;
const PRINCIPLE_RAIL_X = -4.9;
const DEVICE_RAIL_Y = -0.42;

/** 锚点 token → 电极材质色(STYLE.md 色板;未收录回退石墨深灰)。 */
const ELECTRODE_COLORS: Record<string, string> = {
  Zn: '#9aa3ab',
  Cu: '#c4703a',
  Al: '#b9c2c9',
  'porous-carbon': '#3a4148',
  'hydrogen-Pt': '#c9cdd4',
  'oxygen-Pt': '#c9cdd4',
  'methane-side': '#3a4148',
  'oxygen-side': '#3a4148',
};

const DEVICE_TICKS = [
  { nodeId: 'D1', x: -ELECTRODE_X, label: '失电子场所' },
  { nodeId: 'D2', x: -1, label: '电子导体' },
  { nodeId: 'D3', x: 1, label: '离子导体' },
  { nodeId: 'D4', x: ELECTRODE_X, label: '得电子场所' },
] as const;

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

/** 中文文本贴图:量宽绘制,返回 texture 与建议 sprite 宽高比。 */
function makeTextTexture(text: string, color: string, fontPx = 44, weight = 600) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = `${weight} ${fontPx}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width) + 24;
  const height = fontPx + 28;
  canvas.width = width;
  canvas.height = height;
  context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  return { texture, aspect: width / height };
}

interface TextSpriteProps {
  text: string;
  color: string;
  position: readonly [number, number, number];
  height?: number;
  opacity?: number;
}

/** 标签全局放大系数(用户 2026-07-17:3D 视图字太小)。 */
const LABEL_SCALE = 1.4;

function TextSprite({ text, color, position, height = 0.42, opacity = 1 }: TextSpriteProps) {
  const made = useDisposable(() => makeTextTexture(text, color).texture, [text, color]);
  const aspect = useMemo(() => {
    const image = made.image as HTMLCanvasElement;
    return image.width / image.height;
  }, [made]);
  return (
    <sprite
      position={[position[0], position[1], position[2]]}
      scale={[height * LABEL_SCALE * aspect, height * LABEL_SCALE, 1]}
    >
      <spriteMaterial map={made} transparent opacity={opacity} depthWrite={false} />
    </sprite>
  );
}

function lightPresentation(light: LiveCellNode['light'], dimensionColor: string) {
  switch (light) {
    case 'full-lit': return { color: dimensionColor, emissive: 1.5, opacity: 1, lit: true };
    case 'half-lit': return { color: dimensionColor, emissive: 0.65, opacity: 0.88, lit: true };
    case 'needs-review': return { color: STAGE.needsReview, emissive: 0.3, opacity: 0.9, lit: false };
    case 'unassessed': return { color: STAGE.unassessed, emissive: 0, opacity: 0.5, lit: false };
    default: return { color: STAGE.unlit, emissive: 0, opacity: 0.9, lit: false };
  }
}

function ignitionEase(
  clockTime: number,
  ignitionStart: number | null,
  ignitionIndex: number | null,
  lit: boolean,
  reducedMotion: boolean,
) {
  if (!lit) return 1;
  if (reducedMotion || ignitionStart === null || ignitionIndex === null) return 1;
  const progress = THREE.MathUtils.clamp(
    (clockTime - (ignitionStart + ignitionIndex * IGNITION_STAGGER)) / 0.45,
    0,
    1,
  );
  return 1 - (1 - progress) ** 3;
}

interface SceneCommon {
  state: LiveCellState;
  ignitionStart: number | null;
  reducedMotion: boolean;
  focusNodeId: string | null;
}

function nodeOf(state: LiveCellState, id: string) {
  return state.nodes.find((node) => node.id === id) ?? null;
}

/** 聚焦脉冲光晕:挂在任意场景元素上。 */
function FocusHalo({ active, radius = 1.1, reducedMotion }: {
  active: boolean;
  radius?: number;
  reducedMotion: boolean;
}) {
  const spriteRef = useRef<THREE.Sprite>(null);
  const map = useDisposable(() => makeGlowTexture('#ffffff'), []);
  useFrame(({ clock }) => {
    if (!spriteRef.current) return;
    const material = spriteRef.current.material as THREE.SpriteMaterial;
    if (!active) { material.opacity = 0; return; }
    const pulse = reducedMotion ? 0.5 : 0.35 + 0.3 * Math.sin(clock.elapsedTime * 3.2);
    material.opacity = pulse;
    spriteRef.current.scale.setScalar(radius * (reducedMotion ? 1.5 : 1.35 + 0.25 * Math.sin(clock.elapsedTime * 3.2)));
  });
  return (
    <sprite ref={spriteRef}>
      <spriteMaterial map={map} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0} />
    </sprite>
  );
}

function Electrode({ side, common }: { side: 'negative' | 'positive'; common: SceneCommon }) {
  const { state, ignitionStart, reducedMotion, focusNodeId } = common;
  const nodeId = side === 'negative' ? 'D1' : 'D4';
  const node = nodeOf(state, nodeId);
  const dual = nodeOf(state, 'D5');
  const x = side === 'negative' ? -ELECTRODE_X : ELECTRODE_X;
  const electrode = state.electrodes[side];
  const materialColor = electrode.token ? ELECTRODE_COLORS[electrode.token] ?? '#3a4148' : STAGE.glow.device;
  const view = lightPresentation(node?.light ?? 'unassessed', STAGE.glow.device);
  const dualView = lightPresentation(dual?.light ?? 'unassessed', STAGE.glow.device);
  const meshRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const material = meshRef.current.material as THREE.MeshStandardMaterial;
    const eased = ignitionEase(clock.elapsedTime, ignitionStart, node?.ignitionIndex ?? null, view.lit, reducedMotion);
    material.emissiveIntensity = node?.light === 'needs-review'
      ? (reducedMotion ? 0.3 : 0.2 + 0.15 * Math.sin(clock.elapsedTime * 3))
      : view.emissive * eased * 0.9;
    if (ringRef.current) {
      const ringMaterial = ringRef.current.material as THREE.MeshBasicMaterial;
      const dualEased = ignitionEase(clock.elapsedTime, ignitionStart, dual?.ignitionIndex ?? null, dualView.lit, reducedMotion);
      ringMaterial.opacity = dualView.lit ? 0.65 * dualEased : 0;
    }
  });

  const roleLines = side === 'negative'
    ? { bright: '放电 · 氧化 · 负极', dim: '充电 · 还原 · 阴极' }
    : { bright: '放电 · 还原 · 正极', dim: '充电 · 氧化 · 阳极' };
  const focusActive = focusNodeId === nodeId || focusNodeId === 'D5';

  return (
    <group position={[x, 0, 0]}>
      <mesh ref={meshRef} position={[0, 1.5, 0]}>
        <boxGeometry args={[0.55, 3.0, 0.55]} />
        <meshStandardMaterial
          color={view.lit ? materialColor : view.color}
          emissive={view.lit || node?.light === 'needs-review' ? view.color : '#000000'}
          transparent
          opacity={view.opacity}
          roughness={0.45}
          metalness={0.1}
        />
      </mesh>
      {/* D5 双层环:场所(装置)与材料双层认知 */}
      <mesh ref={ringRef} position={[0, 1.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.62, 0.035, 12, 40]} />
        <meshBasicMaterial color={STAGE.glow.device} transparent opacity={0} depthWrite={false} />
      </mesh>
      <group position={[0, 1.5, 0]}>
        <FocusHalo active={focusActive} radius={1.6} reducedMotion={reducedMotion} />
      </group>
      {/* 极性徽章 */}
      <TextSprite
        text={side === 'negative' ? '−' : '+'}
        color={state.polarityLit ? STAGE.glow.energy : STAGE.unassessed}
        position={[0, 3.45, 0]}
        height={0.5}
        opacity={state.polarityLit ? 1 : 0.55}
      />
      {/* 电极名:答对极性判定后才绑定(防泄题,揭示即奖励);判定前显示 ? */}
      <TextSprite
        text={electrode.label ?? '?'}
        color={STAGE.text}
        position={[0, 2.35, 0.42]}
        height={0.42}
        opacity={electrode.label ? 1 : 0.85}
      />
      {/* 角色双行(放电亮 / 充电暗置,与手稿一致):通用框架标注,非案例答案 */}
      <TextSprite text={roleLines.bright} color={view.lit ? '#ffffff' : STAGE.text} position={[0, -1.5, 0]} height={0.3} opacity={0.95} />
      <TextSprite text={roleLines.dim} color={STAGE.text} position={[0, -1.98, 0]} height={0.26} opacity={0.38} />
    </group>
  );
}

function Wire({ common }: { common: SceneCommon }) {
  const { state, ignitionStart, reducedMotion, focusNodeId } = common;
  const wireNode = nodeOf(state, 'D2');
  const flowNode = nodeOf(state, 'P4');
  const currentNode = nodeOf(state, 'P5');
  const view = lightPresentation(wireNode?.light ?? 'unassessed', STAGE.glow.device);
  const flowing = flowNode?.light === 'full-lit' || flowNode?.light === 'half-lit';
  const showCurrent = currentNode?.light === 'full-lit' || currentNode?.light === 'half-lit';

  const curve = useMemo(() => new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-ELECTRODE_X, 3.0, 0),
    new THREE.Vector3(0, WIRE_TOP_Y + 0.6, 0),
    new THREE.Vector3(ELECTRODE_X, 3.0, 0),
  ), []);
  const tube = useDisposable(() => new THREE.TubeGeometry(curve, 48, 0.045, 10, false), [curve]);
  const glowMap = useDisposable(() => makeGlowTexture(STAGE.glow.principle), []);
  const tubeRef = useRef<THREE.Mesh>(null);
  const particleRefs = useRef<Array<THREE.Sprite | null>>([]);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const particleCount = 6;

  useFrame(({ clock }) => {
    if (tubeRef.current) {
      const material = tubeRef.current.material as THREE.MeshStandardMaterial;
      const eased = ignitionEase(clock.elapsedTime, ignitionStart, wireNode?.ignitionIndex ?? null, view.lit, reducedMotion);
      material.emissiveIntensity = view.emissive * eased * 0.8;
      material.opacity = 0.55 + 0.45 * (view.lit ? eased : 0);
    }
    for (let index = 0; index < particleCount; index += 1) {
      const sprite = particleRefs.current[index];
      if (!sprite) continue;
      const material = sprite.material as THREE.SpriteMaterial;
      if (!flowing) { material.opacity = 0; continue; }
      // 电子流:负极 → 外电路 → 正极(t 沿曲线正向)
      const t = reducedMotion
        ? (index + 0.5) / particleCount
        : (index / particleCount + clock.elapsedTime * 0.11) % 1;
      curve.getPointAt(t, scratch);
      sprite.position.set(scratch.x, scratch.y, scratch.z);
      material.opacity = reducedMotion ? 0.85 : 0.55 + 0.4 * Math.sin((t + clock.elapsedTime) * Math.PI * 2);
    }
  });

  return (
    <group>
      <mesh ref={tubeRef} geometry={tube}>
        <meshStandardMaterial
          color={view.lit ? STAGE.glow.device : view.color}
          emissive={view.lit ? STAGE.glow.device : '#000000'}
          transparent
          opacity={0.6}
          roughness={0.5}
        />
      </mesh>
      {Array.from({ length: particleCount }, (_, index) => (
        <sprite
          key={index}
          scale={[0.34, 0.34, 1]}
          ref={(sprite) => { particleRefs.current[index] = sprite; }}
        >
          <spriteMaterial map={glowMap} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0} />
        </sprite>
      ))}
      {flowing ? (
        <TextSprite text="e⁻ →" color={STAGE.glow.principle} position={[-1.7, WIRE_TOP_Y + 0.35, 0]} height={0.34} />
      ) : null}
      {showCurrent ? (
        <TextSprite text="← 电流 I" color={STAGE.glow.energy} position={[1.7, WIRE_TOP_Y + 0.35, 0]} height={0.32} />
      ) : null}
      <group position={[0, WIRE_TOP_Y - 0.2, 0]}>
        <FocusHalo active={focusNodeId === 'D2' || focusNodeId === 'P4' || focusNodeId === 'P5'} radius={1.2} reducedMotion={reducedMotion} />
      </group>
    </group>
  );
}

function Electrolyte({ common }: { common: SceneCommon }) {
  const { state, ignitionStart, reducedMotion, focusNodeId } = common;
  const node = nodeOf(state, 'D3');
  const flowNode = nodeOf(state, 'P4');
  const view = lightPresentation(node?.light ?? 'unassessed', STAGE.glow.principle);
  const drifting = flowNode?.light === 'full-lit' || flowNode?.light === 'half-lit';
  const bodyRef = useRef<THREE.Mesh>(null);
  const cationRefs = useRef<Array<THREE.Mesh | null>>([]);
  const anionRefs = useRef<Array<THREE.Mesh | null>>([]);
  const arrowGeometry = useDisposable(() => new THREE.ConeGeometry(0.11, 0.36, 12), []);
  const ionCount = 3;
  const span = 2.4;

  useFrame(({ clock }) => {
    if (bodyRef.current) {
      const material = bodyRef.current.material as THREE.MeshStandardMaterial;
      const eased = ignitionEase(clock.elapsedTime, ignitionStart, node?.ignitionIndex ?? null, view.lit, reducedMotion);
      material.opacity = 0.12 + (view.lit ? 0.22 * eased : node?.light === 'needs-review' ? 0.14 : 0.05);
      material.emissiveIntensity = view.lit ? 0.65 * eased : 0;
    }
    for (let index = 0; index < ionCount; index += 1) {
      const progress = reducedMotion
        ? (index + 0.5) / ionCount
        : ((index / ionCount) + clock.elapsedTime * 0.07) % 1;
      const fade = drifting ? Math.sin(progress * Math.PI) : 0;
      const cation = cationRefs.current[index];
      if (cation) {
        cation.position.x = -span + progress * span * 2;
        (cation.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
      }
      const anion = anionRefs.current[index];
      if (anion) {
        anion.position.x = span - progress * span * 2;
        (anion.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
      }
    }
  });

  return (
    <group>
      <mesh ref={bodyRef} position={[0, 0.8, 0]}>
        <boxGeometry args={[7.0, 1.6, 1.7]} />
        <meshStandardMaterial
          color="#2cb8b8"
          emissive="#2cb8b8"
          transparent
          opacity={0.12}
          roughness={0.8}
          depthWrite={false}
        />
      </mesh>
      {/* 隔膜:x=0 虚线立面(手稿中的分隔虚线) */}
      {Array.from({ length: 5 }, (_, index) => (
        <mesh key={index} position={[0, 0.24 + index * 0.32, 0]}>
          <boxGeometry args={[0.03, 0.18, 1.5]} />
          <meshBasicMaterial color={STAGE.text} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      ))}
      <TextSprite text="隔膜" color={STAGE.text} position={[0, 2.0, 0]} height={0.28} opacity={0.6} />
      {/* 阳离子 →(移向正极) / ← 阴离子(移向负极) */}
      {Array.from({ length: ionCount }, (_, index) => (
        <mesh
          key={`cation-${index}`}
          position={[0, 1.08, 0.5]}
          rotation={[0, 0, -Math.PI / 2]}
          geometry={arrowGeometry}
          ref={(mesh) => { cationRefs.current[index] = mesh; }}
        >
          <meshBasicMaterial color={STAGE.glow.energy} transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
      {Array.from({ length: ionCount }, (_, index) => (
        <mesh
          key={`anion-${index}`}
          position={[0, 0.5, -0.5]}
          rotation={[0, 0, Math.PI / 2]}
          geometry={arrowGeometry}
          ref={(mesh) => { anionRefs.current[index] = mesh; }}
        >
          <meshBasicMaterial color={STAGE.glow.principle} transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
      {drifting ? (
        <group>
          <TextSprite text="阳离子 →" color={STAGE.glow.energy} position={[1.55, 1.42, 0.5]} height={0.26} />
          <TextSprite text="← 阴离子" color={STAGE.glow.principle} position={[-1.55, 0.16, -0.5]} height={0.26} />
        </group>
      ) : null}
      <group position={[0, 0.8, 0]}>
        <FocusHalo active={focusNodeId === 'D3'} radius={1.9} reducedMotion={reducedMotion} />
      </group>
    </group>
  );
}

/** 原理 / 能量维度轨道上的节点标记(位置直接来自 knowledge-model 配置)。 */
function RailMarker({ node, position, common }: {
  node: LiveCellNode;
  position: readonly [number, number, number];
  common: SceneCommon;
}) {
  const { ignitionStart, reducedMotion, focusNodeId } = common;
  const dimensionColor = STAGE.glow[node.dimensionId];
  const view = lightPresentation(node.light, dimensionColor);
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Sprite>(null);
  const glowMap = useDisposable(
    () => (view.lit ? makeGlowTexture(dimensionColor) : new THREE.Texture()),
    [view.lit, dimensionColor],
  );

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const material = meshRef.current.material as THREE.MeshStandardMaterial;
    const eased = ignitionEase(clock.elapsedTime, ignitionStart, node.ignitionIndex, view.lit, reducedMotion);
    material.emissiveIntensity = node.light === 'needs-review'
      ? (reducedMotion ? 0.3 : 0.2 + 0.15 * Math.sin(clock.elapsedTime * 3))
      : view.emissive * eased;
    meshRef.current.scale.setScalar(0.75 + 0.25 * eased);
    if (glowRef.current) {
      const glow = glowRef.current.material as THREE.SpriteMaterial;
      glow.opacity = view.lit
        ? (reducedMotion ? 0.7 : 0.5 + 0.25 * Math.sin(clock.elapsedTime * 2 + (node.ignitionIndex ?? 0))) * eased
        : 0;
    }
  });

  return (
    <group position={[position[0], position[1], position[2]]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.17, 20, 20]} />
        <meshStandardMaterial
          color={view.color}
          emissive={view.lit || node.light === 'needs-review' ? view.color : '#000000'}
          transparent
          opacity={view.opacity}
          roughness={0.35}
        />
      </mesh>
      {view.lit ? (
        <sprite ref={glowRef} scale={[1.0, 1.0, 1]}>
          <spriteMaterial map={glowMap} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
      ) : null}
      <TextSprite
        text={node.id}
        color={view.lit ? '#ffffff' : STAGE.text}
        position={[node.position.x > 0 ? 0.42 : -0.42, 0.02, 0]}
        height={0.26}
        opacity={view.lit ? 1 : 0.7}
      />
      <FocusHalo active={focusNodeId === node.id} radius={0.85} reducedMotion={reducedMotion} />
    </group>
  );
}

function DimensionRails({ common }: { common: SceneCommon }) {
  const { state } = common;
  const principleNodes = state.nodes.filter((node) => node.dimensionId === 'principle');
  const energyNodes = state.nodes.filter((node) => node.dimensionId === 'energy');
  const anyEnergyLit = energyNodes.some((node) => node.light === 'full-lit' || node.light === 'half-lit');
  const energyDirection = useMemo(() => new THREE.Vector3(-0.22, -0.52, 0.83).normalize(), []);
  const energyOrigin = useMemo(() => new THREE.Vector3(PRINCIPLE_RAIL_X, DEVICE_RAIL_Y, 0), []);

  const railGeometry = useDisposable(() => {
    const points = [
      // 原理轴(纵向)
      new THREE.Vector3(PRINCIPLE_RAIL_X, DEVICE_RAIL_Y, 0),
      new THREE.Vector3(PRINCIPLE_RAIL_X, 6.1, 0),
      // 装置轴(底部横向)
      new THREE.Vector3(PRINCIPLE_RAIL_X, DEVICE_RAIL_Y, 0),
      new THREE.Vector3(4.9, DEVICE_RAIL_Y, 0),
      // 能量轴(左下对角)
      energyOrigin.clone(),
      energyOrigin.clone().addScaledVector(energyDirection, 3.5),
    ];
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [energyDirection, energyOrigin]);

  const energyMarkerAt = (index: number): readonly [number, number, number] => {
    const point = energyOrigin.clone().addScaledVector(energyDirection, 0.9 + index * 0.95);
    return [point.x, point.y, point.z];
  };

  return (
    <group>
      <lineSegments geometry={railGeometry}>
        <lineBasicMaterial color={STAGE.text} transparent opacity={0.28} />
      </lineSegments>
      <TextSprite text="原理维度" color={STAGE.glow.principle} position={[PRINCIPLE_RAIL_X, 6.55, 0]} height={0.4} />
      <TextSprite text="装置维度" color={STAGE.glow.device} position={[5.7, DEVICE_RAIL_Y, 0]} height={0.4} />
      {(() => {
        const tip = energyOrigin.clone().addScaledVector(energyDirection, 4.05);
        return <TextSprite text="能量维度" color={STAGE.glow.energy} position={[tip.x, tip.y, tip.z]} height={0.4} />;
      })()}
      {/* 装置轴四类目刻度:对应 D1–D4,点亮则增亮 */}
      {DEVICE_TICKS.map((tick) => {
        const node = nodeOf(state, tick.nodeId);
        const lit = node?.light === 'full-lit' || node?.light === 'half-lit';
        return (
          <TextSprite
            key={tick.nodeId}
            text={tick.label}
            color={lit ? STAGE.glow.device : STAGE.text}
            position={[tick.x, DEVICE_RAIL_Y - 0.42, 0]}
            height={0.28}
            opacity={lit ? 1 : 0.55}
          />
        );
      })}
      {/* 原理轨道标记:y 直接取配置;P6/P7 的 x 偏移映射为轨道右侧小枝 */}
      {principleNodes.map((node) => (
        <RailMarker
          key={node.id}
          node={node}
          position={[PRINCIPLE_RAIL_X + node.position.x * 0.5, 0.4 + node.position.y * 0.95, 0]}
          common={common}
        />
      ))}
      {/* 能量轨道标记与释/储能副标(手稿:释能亮、储能暗置) */}
      {energyNodes.map((node, index) => (
        <RailMarker key={node.id} node={node} position={energyMarkerAt(index)} common={common} />
      ))}
      {(() => {
        const at = energyOrigin.clone().addScaledVector(energyDirection, 1.9);
        return (
          <group>
            <TextSprite
              text="释能:化学能 → 电能"
              color={anyEnergyLit ? STAGE.glow.energy : STAGE.text}
              position={[at.x + 1.75, at.y - 0.55, at.z]}
              height={0.3}
              opacity={anyEnergyLit ? 1 : 0.5}
            />
            <TextSprite
              text="储能:电能 → 化学能"
              color={STAGE.text}
              position={[at.x + 1.75, at.y - 1.0, at.z]}
              height={0.26}
              opacity={0.32}
            />
          </group>
        );
      })()}
    </group>
  );
}

function CellRig({ reducedMotion }: { reducedMotion: boolean }) {
  const { camera, gl } = useThree();
  const state = useRef(createOrbitState({ yaw: 0.42, pitch: 0.22, radius: 12.2 }));

  useEffect(
    () => attachOrbitControls(gl.domElement, state.current, CELL_ORBIT_BOUNDS),
    [gl],
  );

  useFrame(({ clock }, delta) => {
    const current = state.current;
    stepOrbit(current, CELL_ORBIT_BOUNDS, delta, reducedMotion);
    const idle = performance.now() - current.idleAt > 3000;
    // 作答期常驻侧屏:不整圈自转,轻微呼吸式摆动保持立体感
    const sway = !reducedMotion && idle && !current.dragging
      ? 0.06 * Math.sin(clock.elapsedTime * 0.24)
      : 0;
    const yaw = current.yaw + sway;
    camera.position.set(
      current.radius * Math.cos(current.pitch) * Math.sin(yaw),
      2.3 + current.radius * Math.sin(current.pitch),
      current.radius * Math.cos(current.pitch) * Math.cos(yaw),
    );
    camera.lookAt(0, 2.3, 0);
  });
  return null;
}

const CELL_ORBIT_BOUNDS = {
  minPitch: -0.1,
  maxPitch: 1.1,
  minRadius: 7,
  maxRadius: 18,
} as const;

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

export interface CellSceneProps {
  state: LiveCellState;
  /** 灯态签名变化时递增,触发点亮序列重放。 */
  replayToken: number;
  reducedMotion: boolean;
  focusNodeId: string | null;
}

export function CellScene({ state, replayToken, reducedMotion, focusNodeId }: CellSceneProps) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 46, near: 0.1, far: 80 }}
      frameloop={reducedMotion ? 'demand' : 'always'}
      style={{ background: STAGE.bg }}
    >
      <fog attach="fog" args={[STAGE.fog, 14, 34]} />
      <ambientLight color="#8fa3c4" intensity={0.85} />
      <directionalLight position={[4, 7, 6]} intensity={1.0} />
      <IgnitionClock replayToken={replayToken}>
        {(ignitionStart) => {
          const common: SceneCommon = { state, ignitionStart, reducedMotion, focusNodeId };
          return (
            <group>
              <DimensionRails common={common} />
              <Electrode side="negative" common={common} />
              <Electrode side="positive" common={common} />
              <Wire common={common} />
              <Electrolyte common={common} />
            </group>
          );
        }}
      </IgnitionClock>
      <CellRig reducedMotion={reducedMotion} />
    </Canvas>
  );
}
