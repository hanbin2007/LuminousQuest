import type { PretestConfig } from '../../../shared/config/schemas';
import type { BuilderGraph } from '../../../shared/scoring/topology';
import { benchGeometryFor } from './presentation';

/**
 * 物理装配 → 判分拓扑图的确定性推导(工作台 v2:装配即答案)。
 *
 * 现实语义:
 * - 导线两端鳄鱼夹自动吸附最近的两个电极顶端(SNAP_WIRE 内)→ 外电路边;
 * - 电极底端浸入烧杯液面矩形 → 内电路接触边(from=池, to=电极,与旧 UI 同序);
 * - 方向箭头是组件(判分必需):电子箭头绑最近已接导线,离子箭头绑所在池;
 *   flipped 决定指向,由此给对应边打 carrier 并定 from/to——判分器语义原封不动。
 * 全部关系由坐标推导,零手工连线;刷新/恢复后重算即得同一张图。
 */

export const SNAP_WIRE = 96;
export const SNAP_ARROW_WIRE = 80;

type BuilderComponentDefinition = PretestConfig['builder']['components'][number];

export interface AssemblyComponent {
  instanceId: string;
  componentId: string;
  x: number;
  y: number;
  flipped?: boolean;
}

export interface WireAttachment {
  wireId: string;
  /** 端点按电极 x 升序:a=左,b=右。 */
  a: { electrodeId: string; x: number; y: number };
  b: { electrodeId: string; x: number; y: number };
}

export interface ArrowBinding {
  arrowId: string;
  kind: 'electron' | 'cation' | 'anion';
  target: { type: 'wire'; wireId: string } | { type: 'beaker'; beakerId: string };
  /** 实际指向(已含 flipped):'right' = x 增大方向。 */
  direction: 'left' | 'right';
}

export interface AssemblyState {
  connections: BuilderGraph['connections'];
  wireAttachments: WireAttachment[];
  /** beakerId → 池内电极(按 x 升序)。 */
  containment: Map<string, string[]>;
  arrowBindings: Map<string, ArrowBinding>;
}

function isWire(definition: BuilderComponentDefinition) {
  return definition.kind === 'electron-conductor'
    || (definition.kind === 'distractor' && !definition.allowedRoles?.includes('ion-conductor'));
}

function isBeaker(definition: BuilderComponentDefinition) {
  return definition.kind === 'ion-conductor'
    || definition.kind === 'container'
    || (definition.kind === 'distractor' && Boolean(definition.allowedRoles?.includes('ion-conductor')));
}

const arrowKinds: Record<string, ArrowBinding['kind']> = {
  'electron-arrow': 'electron',
  'cation-arrow': 'cation',
  'anion-arrow': 'anion',
};

function terminalOf(component: AssemblyComponent) {
  const geometry = benchGeometryFor(component.componentId);
  return {
    x: component.x + geometry.width * geometry.anchorX,
    y: component.y + geometry.height * geometry.anchorY,
  };
}

function centerOf(component: AssemblyComponent) {
  const geometry = benchGeometryFor(component.componentId);
  return { x: component.x + geometry.width / 2, y: component.y + geometry.height / 2 };
}

function bottomOf(component: AssemblyComponent) {
  const geometry = benchGeometryFor(component.componentId);
  return { x: component.x + geometry.width / 2, y: component.y + geometry.height * 0.96 };
}

/** 池的液面矩形(与烧杯位图的液体区域同源:上沿约 32%,左右沿 12%)。 */
export function liquidRectOf(component: AssemblyComponent) {
  const geometry = benchGeometryFor(component.componentId);
  return {
    left: component.x + geometry.width * 0.12,
    right: component.x + geometry.width * 0.88,
    top: component.y + geometry.height * 0.32,
    bottom: component.y + geometry.height * 0.98,
  };
}

function inRect(point: { x: number; y: number }, rect: ReturnType<typeof liquidRectOf>) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function byInstanceId<T extends { instanceId: string }>(left: T, right: T) {
  return left.instanceId < right.instanceId ? -1 : 1;
}

export function deriveAssembly(
  components: readonly AssemblyComponent[],
  definitionById: ReadonlyMap<string, BuilderComponentDefinition>,
): AssemblyState {
  const sorted = [...components].sort(byInstanceId);
  const electrodes = sorted.filter((entry) => definitionById.get(entry.componentId)?.kind === 'electrode');
  const wires = sorted.filter((entry) => {
    const definition = definitionById.get(entry.componentId);
    return definition ? isWire(definition) : false;
  });
  const beakers = sorted.filter((entry) => {
    const definition = definitionById.get(entry.componentId);
    return definition ? isBeaker(definition) : false;
  });
  const arrows = sorted.filter((entry) => arrowKinds[entry.componentId] !== undefined);

  // 导线吸附:两端各找最近电极(两端不得同一电极)
  const wireAttachments: WireAttachment[] = [];
  for (const wire of wires) {
    const center = centerOf(wire);
    const ranked = electrodes
      .map((electrode) => ({ electrode, point: terminalOf(electrode) }))
      .map((entry) => ({ ...entry, d: distance(center, entry.point) }))
      .filter((entry) => entry.d <= SNAP_WIRE * 2)
      .sort((left, right) => left.d - right.d);
    if (ranked.length < 2) continue;
    const nearest = ranked[0]!;
    const second = ranked.find((entry) => entry.electrode.instanceId !== nearest.electrode.instanceId);
    if (!second || nearest.d > SNAP_WIRE * 2 || second.d > SNAP_WIRE * 2) continue;
    const pair = [nearest, second].sort((l, r) => l.point.x - r.point.x);
    wireAttachments.push({
      wireId: wire.instanceId,
      a: { electrodeId: pair[0]!.electrode.instanceId, ...pair[0]!.point },
      b: { electrodeId: pair[1]!.electrode.instanceId, ...pair[1]!.point },
    });
  }

  // 池内容物:电极底端浸入液面矩形
  const containment = new Map<string, string[]>();
  for (const beaker of beakers) {
    const rect = liquidRectOf(beaker);
    const inside = electrodes
      .filter((electrode) => inRect(bottomOf(electrode), rect))
      .sort((l, r) => centerOf(l).x - centerOf(r).x)
      .map((electrode) => electrode.instanceId);
    if (inside.length > 0) containment.set(beaker.instanceId, inside);
  }

  // 箭头绑定
  const arrowBindings = new Map<string, ArrowBinding>();
  for (const arrow of arrows) {
    const kind = arrowKinds[arrow.componentId]!;
    const point = centerOf(arrow);
    const direction: ArrowBinding['direction'] = arrow.flipped ? 'left' : 'right';
    if (kind === 'electron') {
      const candidates = wireAttachments
        .map((attachment) => {
          const mid = { x: (attachment.a.x + attachment.b.x) / 2, y: (attachment.a.y + attachment.b.y) / 2 + 24 };
          return { attachment, d: distance(point, mid) };
        })
        .filter((entry) => entry.d <= SNAP_ARROW_WIRE * 1.6)
        .sort((l, r) => l.d - r.d);
      if (candidates.length === 0) continue;
      arrowBindings.set(arrow.instanceId, {
        arrowId: arrow.instanceId,
        kind,
        target: { type: 'wire', wireId: candidates[0]!.attachment.wireId },
        direction,
      });
    } else {
      const host = beakers.find((beaker) => inRect(point, liquidRectOf(beaker)));
      if (!host) continue;
      arrowBindings.set(arrow.instanceId, {
        arrowId: arrow.instanceId,
        kind,
        target: { type: 'beaker', beakerId: host.instanceId },
        direction,
      });
    }
  }

  // 推导判分边
  const connections: BuilderGraph['connections'] = [];
  const electrodeX = new Map(electrodes.map((entry) => [entry.instanceId, centerOf(entry).x]));

  for (const attachment of wireAttachments) {
    const marked = [...arrowBindings.values()].find(
      (binding) => binding.kind === 'electron'
        && binding.target.type === 'wire'
        && binding.target.wireId === attachment.wireId,
    );
    const source = marked?.direction === 'left' ? attachment.b.electrodeId : attachment.a.electrodeId;
    const sink = marked?.direction === 'left' ? attachment.a.electrodeId : attachment.b.electrodeId;
    const carrier = marked ? { carrier: 'electron' as const } : {};
    connections.push(
      {
        id: `wire:${attachment.wireId}:in`,
        from: source,
        to: attachment.wireId,
        kind: 'electron-path',
        ...carrier,
      },
      {
        id: `wire:${attachment.wireId}:out`,
        from: attachment.wireId,
        to: sink,
        kind: 'electron-path',
        ...carrier,
      },
    );
  }

  for (const [beakerId, inside] of containment) {
    for (const electrodeId of inside) {
      connections.push({
        id: `dip:${beakerId}:${electrodeId}`,
        from: beakerId,
        to: electrodeId,
        kind: 'ion-path',
      });
    }
    const ionArrows = [...arrowBindings.values()].filter(
      (binding) => binding.target.type === 'beaker'
        && binding.target.beakerId === beakerId
        && (binding.kind === 'cation' || binding.kind === 'anion'),
    );
    if (inside.length >= 2 && ionArrows.length > 0) {
      const ordered = [...inside].sort((l, r) => (electrodeX.get(l) ?? 0) - (electrodeX.get(r) ?? 0));
      const leftMost = ordered[0]!;
      const rightMost = ordered[ordered.length - 1]!;
      for (const binding of ionArrows) {
        const target = binding.direction === 'right' ? rightMost : leftMost;
        connections.push({
          id: `ion:${binding.arrowId}`,
          from: beakerId,
          to: target,
          kind: 'ion-path',
          carrier: binding.kind as 'cation' | 'anion',
        });
      }
    }
  }

  return { connections, wireAttachments, containment, arrowBindings };
}
