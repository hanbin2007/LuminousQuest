import type { CaseConfig, LoadedConfig } from '../../../shared/config/schemas';
import type {
  AssessmentCompletedEvent,
  StudentSession,
} from '../../../shared/session';
import type { NodeLight } from './lighting';
import type { StudentUnderstandingState } from '../../../shared/agent/memory';

/**
 * 训练分屏 3D 认知模型的实时状态推导(纯函数)。
 * v3 训练页显示 Agent 的学生模型：完整记忆快照是已提交灯态，
 * 当前题 working update 是临时预览。正式成绩仍由 assessment 记录轨负责。
 */

export interface LiveCellNode {
  id: string;
  dimensionId: 'device' | 'principle' | 'energy';
  statement: string;
  position: { x: number; y: number; z: number };
  light: NodeLight;
  /** 点亮次序(仅 lit 节点),按判分事件 sequence 升序。 */
  ignitionIndex: number | null;
}

export interface LiveCellState {
  caseId: string;
  nodes: LiveCellNode[];
  /**
   * 电极显示信息。防泄题:公开配置不含极性锚点,材料名只在学生**答对**
   * 本案例极性判定后,从服务端追加的 polarity.revealed 事件解析绑定;
   * 判定前 label 为 null(界面显示「?」),把揭示做成答对的奖励时刻。
   */
  electrodes: {
    negative: { token: string | null; label: string | null };
    positive: { token: string | null; label: string | null };
  };
  /** 本案例最新极性锚点判定是否命中(点亮 +/− 徽章并绑定材料名)。 */
  polarityLit: boolean;
  medium: CaseConfig['medium'];
  litCount: number;
  totalCount: number;
  /** 灯态签名:变化即触发一次点亮序列重放。 */
  litSignature: string;
}

/** 锚点 token → 电极显示名。纯表现层查表;未收录 token 回退原文。 */
const ELECTRODE_LABELS: Record<string, string> = {
  Zn: '锌',
  Cu: '铜',
  Al: '铝',
  'porous-carbon': '多孔碳',
  'hydrogen-Pt': 'H₂ · Pt',
  'oxygen-Pt': 'O₂ · Pt',
  'methane-side': 'CH₄ 侧',
  'oxygen-side': 'O₂ 侧',
};

export function electrodeLabel(token: string) {
  return ELECTRODE_LABELS[token] ?? token;
}

/** 与训练反馈卡(annotationStatus)同一套判分→灯态语义。 */
function lightOfEvent(event: AssessmentCompletedEvent): NodeLight {
  if (event.score.status === 'unassessed') {
    return event.extraction.status === 'needs-review' ? 'needs-review' : 'unassessed';
  }
  if (event.score.status === 'unanswered') return 'unassessed';
  if (event.score.status === 'needs-review') return 'needs-review';
  const outcome = event.score.outcome ?? event.ruleDecision.status;
  if (outcome === 'hit' || outcome === 'hit-with-help') return 'full-lit';
  if (outcome === 'partial') return 'half-lit';
  if (outcome === 'miss') return 'dark';
  return 'unassessed';
}

function lightOfUnderstanding(state: StudentUnderstandingState): NodeLight {
  if (state === 'mastered') return 'full-lit';
  if (state === 'developing') return 'half-lit';
  if (state === 'not-yet') return 'dark';
  if (state === 'uncertain') return 'needs-review';
  return 'unassessed';
}

export function buildLiveCellState(
  session: StudentSession,
  config: LoadedConfig,
  trainingCase: CaseConfig,
): LiveCellState {
  const latestByNode = new Map<string, AssessmentCompletedEvent>();
  const agentStateByNode = new Map<string, StudentUnderstandingState>();
  const agentSequenceByNode = new Map<string, number>();
  const latestMemory = [...session.events].reverse().find((event) =>
    event.kind === 'agent.memory.snapshot.committed');
  if (latestMemory?.kind === 'agent.memory.snapshot.committed') {
    for (const node of latestMemory.snapshot.nodes) {
      agentStateByNode.set(node.nodeId, node.state);
      agentSequenceByNode.set(node.nodeId, latestMemory.sequence);
    }
    for (const event of session.events) {
      if (
        event.kind !== 'agent.understanding.updated'
        || event.caseId !== trainingCase.id
        || event.sequence <= latestMemory.sequence
      ) continue;
      for (const update of event.updates) {
        agentStateByNode.set(update.nodeId, update.state);
        agentSequenceByNode.set(update.nodeId, event.sequence);
      }
    }
  }
  let polarityLit = false;
  let polarity: { negative: string; positive: string } | null = null;
  let latestPolarityAssessmentId: string | null = null;
  let polaritySequence = -1;
  for (const event of session.events) {
    if (event.caseId !== trainingCase.id) continue;
    if (event.kind === 'assessment.completed') {
      const previous = latestByNode.get(event.nodeId);
      if (!previous || event.sequence > previous.sequence) latestByNode.set(event.nodeId, event);
    }
    if (event.kind === 'polarity.assessed' && event.sequence > polaritySequence) {
      polaritySequence = event.sequence;
      polarityLit = event.outcome === 'hit';
      latestPolarityAssessmentId = event.id;
      polarity = null;
    }
    if (
      event.kind === 'polarity.revealed'
      && polarityLit
      && event.sourcePolarityAssessmentEventId === latestPolarityAssessmentId
    ) {
      polarity = event.values;
    }
    if (event.kind === 'agent.anchor.revealed') {
      polarityLit = true;
      polarity = event.values;
    }
  }

  const agentProjectionActive = Boolean(latestMemory);
  const litNodes = agentProjectionActive
    ? [...agentStateByNode.entries()]
        .filter(([, state]) => state === 'mastered' || state === 'developing')
        .sort(([left], [right]) =>
          (agentSequenceByNode.get(left) ?? 0) - (agentSequenceByNode.get(right) ?? 0))
        .map(([nodeId]) => nodeId)
    : [...latestByNode.values()]
        .filter((event) => {
          const light = lightOfEvent(event);
          return light === 'full-lit' || light === 'half-lit';
        })
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => event.nodeId);
  const ignitionByNode = new Map(litNodes.map((nodeId, index) => [nodeId, index]));

  const nodes: LiveCellNode[] = config.knowledgeModel.nodes.map((node) => {
    const event = latestByNode.get(node.id);
    const agentState = agentStateByNode.get(node.id);
    return {
      id: node.id,
      dimensionId: node.dimensionId as LiveCellNode['dimensionId'],
      statement: node.statement,
      position: node.position,
      light: agentProjectionActive
        ? lightOfUnderstanding(agentState ?? 'unseen')
        : event
          ? lightOfEvent(event)
          : 'unassessed',
      ignitionIndex: ignitionByNode.get(node.id) ?? null,
    };
  });

  return {
    caseId: trainingCase.id,
    nodes,
    electrodes: {
      negative: {
        token: polarity?.negative ?? null,
        label: polarity ? electrodeLabel(polarity.negative) : null,
      },
      positive: {
        token: polarity?.positive ?? null,
        label: polarity ? electrodeLabel(polarity.positive) : null,
      },
    },
    polarityLit,
    medium: trainingCase.medium,
    litCount: litNodes.length,
    totalCount: nodes.length,
    litSignature: [
      trainingCase.id,
      polarityLit ? 'A' : 'a',
      ...nodes.map((node) => `${node.id}:${node.light}`),
    ].join('|'),
  };
}

export function liveNodeById(state: LiveCellState, id: string | null) {
  if (!id) return null;
  return state.nodes.find((node) => node.id === id) ?? null;
}

export interface DimensionProgress {
  dimensionId: LiveCellNode['dimensionId'];
  /** 全亮节点数(hit/hit-with-help)。 */
  litCount: number;
  /** 半亮节点数(partial),进度条以半权重计。 */
  halfCount: number;
  totalCount: number;
  /** 0..1,half 计 0.5;维度进度条的填充比例。 */
  ratio: number;
  /** 全部节点全亮 → 维度点亮时刻。 */
  complete: boolean;
}

/** 量表维度进度:与灯态同源(只从判分事件派生),agent 无法影响。 */
export function buildDimensionProgress(state: LiveCellState): DimensionProgress[] {
  const order: LiveCellNode['dimensionId'][] = ['device', 'principle', 'energy'];
  return order.map((dimensionId) => {
    const nodes = state.nodes.filter((node) => node.dimensionId === dimensionId);
    const litCount = nodes.filter((node) => node.light === 'full-lit').length;
    const halfCount = nodes.filter((node) => node.light === 'half-lit').length;
    const totalCount = nodes.length;
    const ratio = totalCount === 0 ? 0 : (litCount + halfCount * 0.5) / totalCount;
    return {
      dimensionId,
      litCount,
      halfCount,
      totalCount,
      ratio,
      complete: totalCount > 0 && litCount === totalCount,
    };
  });
}
