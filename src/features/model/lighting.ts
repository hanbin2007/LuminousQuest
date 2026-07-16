import type { LoadedConfig } from '../../../shared/config/schemas';
import type { StudentSession } from '../../../shared/session/schema';
import { buildLearnerProfile } from '../../../shared/scoring/profile';

/** 3D 节点的点亮状态:full/half 来自判分,miss 暗置,unassessed 灰,needs-review 待复核。 */
export type NodeLight = 'full-lit' | 'half-lit' | 'dark' | 'unassessed' | 'needs-review';

export interface SceneNode {
  id: string;
  dimensionId: 'device' | 'principle' | 'energy';
  statement: string;
  position: { x: number; y: number; z: number };
  light: NodeLight;
  /** 点亮次序(仅 lit 节点):按作答事件 sequence 升序,驱动逐个点亮动画。 */
  ignitionIndex: number | null;
}

export interface SceneEdge {
  from: string;
  to: string;
  /** 跨维度边(如 D5↔P2):两端均点亮时以校青高亮,外显"维度贯通"。 */
  crossAxis: boolean;
  bothLit: boolean;
}

export interface ModelScene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  litCount: number;
  totalCount: number;
  radar: Array<{ id: 'device' | 'principle' | 'energy'; label: string; value: number | null }>;
}

function lightOf(node: ReturnType<typeof buildLearnerProfile>['nodes'][number]): NodeLight {
  if (node.status === 'needs-review') return 'needs-review';
  if (node.status !== 'scored') return 'unassessed';
  return node.visualization ?? 'dark';
}

export function buildModelScene(session: StudentSession, config: LoadedConfig): ModelScene {
  const profile = buildLearnerProfile(session, config);
  const profileByNode = new Map(profile.nodes.map((node) => [node.nodeId, node]));

  const litSequence = profile.nodes
    .filter((node) => {
      const light = lightOf(node);
      return light === 'full-lit' || light === 'half-lit';
    })
    .sort((a, b) => (a.selectedAssessment?.sequence ?? a.latestAttempt?.sequence ?? Number.MAX_SAFE_INTEGER)
      - (b.selectedAssessment?.sequence ?? b.latestAttempt?.sequence ?? Number.MAX_SAFE_INTEGER));
  const ignitionByNode = new Map(litSequence.map((node, index) => [node.nodeId, index]));

  const nodes: SceneNode[] = config.knowledgeModel.nodes.map((node) => {
    const learner = profileByNode.get(node.id);
    const light: NodeLight = learner ? lightOf(learner) : 'unassessed';
    return {
      id: node.id,
      dimensionId: (learner?.dimensionId ?? node.dimensionId) as SceneNode['dimensionId'],
      statement: node.statement,
      position: node.position,
      light,
      ignitionIndex: ignitionByNode.get(node.id) ?? null,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const isLit = (id: string) => {
    const light = nodeById.get(id)?.light;
    return light === 'full-lit' || light === 'half-lit';
  };

  const edges: SceneEdge[] = [];
  for (const edge of config.knowledgeModel.edges ?? []) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    edges.push({
      from: edge.from,
      to: edge.to,
      crossAxis: edge.kind === 'cross-axis',
      bothLit: isLit(edge.from) && isLit(edge.to),
    });
  }

  const dimensionLabels = new Map(
    config.knowledgeModel.dimensions.map((dimension) => [dimension.id, dimension.label]),
  );
  const radar = (['device', 'principle', 'energy'] as const).map((id) => {
    const dimension = profile.dimensions.find((entry) => entry.dimensionId === id);
    return {
      id,
      label: dimensionLabels.get(id) ?? id,
      value: dimension?.ratio ?? null,
    };
  });

  return {
    nodes,
    edges,
    litCount: litSequence.length,
    totalCount: nodes.length,
    radar,
  };
}
