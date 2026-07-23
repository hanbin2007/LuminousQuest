import type { CaseConfig, LoadedConfig } from '../../../shared/config/schemas';
import type {
  AssessmentCompletedEvent,
  StudentSession,
} from '../../../shared/session';
import type { NodeLight } from './lighting';

/**
 * 训练分屏 3D 认知模型的实时状态推导(纯函数)。
 * 只看「当前案例」的判分事件——面板呈现的是本案例的即时进展,
 * 与模块三整节课外显(全会话画像)刻意区分。
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
   * 本案例极性判定后,从会话 polarity.assessed 事件的 correctValue 解析绑定;
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

function parsePolarityValue(correctValue: string) {
  const entries = new Map<string, string>();
  for (const part of correctValue.split(';')) {
    const [key, value] = part.split('=');
    if (key && value) entries.set(key.trim(), value.trim());
  }
  return {
    negative: entries.get('negative') ?? '?',
    positive: entries.get('positive') ?? '?',
  };
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

export function buildLiveCellState(
  session: StudentSession,
  config: LoadedConfig,
  trainingCase: CaseConfig,
): LiveCellState {
  const latestByNode = new Map<string, AssessmentCompletedEvent>();
  let polarityLit = false;
  let polarityCorrectValue: string | null = null;
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
      polarityCorrectValue = event.outcome === 'hit' ? event.correctValue : null;
    }
  }

  const litEvents = [...latestByNode.values()]
    .filter((event) => {
      const light = lightOfEvent(event);
      return light === 'full-lit' || light === 'half-lit';
    })
    .sort((left, right) => left.sequence - right.sequence);
  const ignitionByNode = new Map(litEvents.map((event, index) => [event.nodeId, index]));

  const nodes: LiveCellNode[] = config.knowledgeModel.nodes.map((node) => {
    const event = latestByNode.get(node.id);
    return {
      id: node.id,
      dimensionId: node.dimensionId as LiveCellNode['dimensionId'],
      statement: node.statement,
      position: node.position,
      light: event ? lightOfEvent(event) : 'unassessed',
      ignitionIndex: ignitionByNode.get(node.id) ?? null,
    };
  });

  const polarity = polarityCorrectValue ? parsePolarityValue(polarityCorrectValue) : null;

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
    litCount: litEvents.length,
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
