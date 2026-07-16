import type { CaseConfig, LoadedConfig, ScaffoldPolicyConfig } from '../../../shared/config/schemas';
import {
  evaluateCasePass,
  nextScaffoldLevel,
  type CaseScoreInput,
  type ScaffoldScoreInput,
  type ScaffoldTransition,
} from '../../../shared/scoring/scaffold';
import type { AssessmentCompletedEvent, SessionEvent } from '../../../shared/session';

type ScoredAssessmentEvent = AssessmentCompletedEvent & {
  score: Extract<AssessmentCompletedEvent['score'], { status: 'scored' }>;
};

export interface ScaffoldViewState extends ScaffoldTransition {
  currentLabel: string;
  changeReason: string;
}

export interface AttemptScores {
  caseScores: CaseScoreInput[];
  scaffoldScores: ScaffoldScoreInput[];
  summary: {
    earned: number;
    possible: number;
    ratio: number | null;
  };
}

export interface ScaffoldHistoryEntry {
  caseId: string;
  attemptKey: string;
  score: ScaffoldScoreInput;
}

function configuredLevel(policy: ScaffoldPolicyConfig, level: number) {
  const configured = policy.levels.find((entry) => entry.level === level);
  if (!configured) throw new Error(`Unknown scaffold level ${level}`);
  return configured;
}

function currentLabel(level: number, policy: ScaffoldPolicyConfig) {
  return `当前脚手架：第 ${level} 级（${configuredLevel(policy, level).label}）`;
}

function transferState(policy: ScaffoldPolicyConfig): ScaffoldViewState {
  return {
    level: 3,
    action: 'stay',
    streak: 0,
    reason: 'Transfer cases are fixed at scaffold level 3',
    currentLabel: currentLabel(3, policy),
    changeReason: '冷迁移后测固定使用第 3 级独立作答。',
  };
}

export function initialScaffold(
  caseType: CaseConfig['caseType'],
  policy: ScaffoldPolicyConfig,
): ScaffoldViewState {
  if (caseType === 'transfer') return transferState(policy);
  const level = Math.min(...policy.levels.map((entry) => entry.level));
  return {
    level,
    action: 'stay',
    streak: 0,
    reason: 'Initial scaffold level',
    currentLabel: currentLabel(level, policy),
    changeReason: '训练从配置中的最低脚手架等级开始。',
  };
}

function isAssistedHit(score: ScaffoldScoreInput | undefined) {
  return score !== undefined
    && (score.outcome === 'hit' || score.outcome === 'hit-with-help')
    && (score.outcome === 'hit-with-help' || score.assistance.kind !== 'none');
}

function changeReason(
  transition: ScaffoldTransition,
  scores: readonly ScaffoldScoreInput[],
  policy: ScaffoldPolicyConfig,
) {
  if (transition.action === 'promote') {
    return `连续 ${transition.streak} 次独立答对，减少引导，调整为第 ${transition.level} 级。`;
  }
  if (transition.action === 'demote') {
    return `连续 ${transition.streak} 次未答对，增加引导，调整为第 ${transition.level} 级。`;
  }

  const latest = scores.at(-1);
  const streakBreaker = scores[scores.length - transition.streak - 1];
  if (isAssistedHit(latest) || isAssistedHit(streakBreaker)) {
    return `帮助后答对不计入升级；当前连续独立答对 ${transition.streak} 次，保持第 ${transition.level} 级。`;
  }
  if (latest?.outcome === 'miss' && transition.streak >= policy.demotion.consecutiveMisses) {
    return `已是最充分引导；连续 ${transition.streak} 次未答对，保持第 ${transition.level} 级。`;
  }
  if (transition.streak >= policy.promotion.consecutiveHits) {
    return `已是独立作答；连续 ${transition.streak} 次独立答对，保持第 ${transition.level} 级。`;
  }
  return `尚未达到调整条件；当前连续独立答对 ${transition.streak} 次，保持第 ${transition.level} 级。`;
}

export function advanceScaffold(
  caseType: CaseConfig['caseType'],
  currentLevel: number,
  scores: readonly ScaffoldScoreInput[],
  policy: ScaffoldPolicyConfig,
): ScaffoldViewState {
  if (caseType === 'transfer') return transferState(policy);
  const transition = nextScaffoldLevel(currentLevel, scores, policy);
  return {
    ...transition,
    currentLabel: currentLabel(transition.level, policy),
    changeReason: changeReason(transition, scores, policy),
  };
}

function isScoredAssessment(event: SessionEvent): event is ScoredAssessmentEvent {
  return event.kind === 'assessment.completed' && event.score.status === 'scored';
}

function latestUniqueScoredNodes(
  events: readonly SessionEvent[],
  includes: (event: ScoredAssessmentEvent) => boolean,
) {
  const latestByNodeId = new Map<string, ScoredAssessmentEvent>();
  for (const event of events) {
    if (!isScoredAssessment(event) || !includes(event)) continue;
    const current = latestByNodeId.get(event.nodeId);
    if (!current || event.sequence > current.sequence) latestByNodeId.set(event.nodeId, event);
  }
  return [...latestByNodeId.values()].sort((left, right) => left.sequence - right.sequence);
}

function outcomeOf(event: ScoredAssessmentEvent): ScaffoldScoreInput['outcome'] {
  if (event.score.outcome) return event.score.outcome;
  const outcome = event.ruleDecision.status;
  if (outcome === 'hit' || outcome === 'hit-with-help' || outcome === 'partial' || outcome === 'miss') {
    return outcome;
  }
  throw new Error(`Scored assessment ${event.id} has no scored outcome`);
}

function caseScoreOf(event: ScoredAssessmentEvent): CaseScoreInput {
  return {
    nodeId: event.nodeId,
    outcome: outcomeOf(event),
    earned: event.score.earned,
    possible: event.score.possible,
    assistance: event.assistance,
  };
}

function scaffoldScoreOf(event: ScoredAssessmentEvent): ScaffoldScoreInput {
  return {
    outcome: outcomeOf(event),
    earned: event.score.earned,
    possible: event.score.possible,
    assistance: event.assistance,
  };
}

function normalizedAttemptKey(attemptIds: readonly string[]) {
  return [...new Set(attemptIds)].sort().join('\0');
}

export function upsertScaffoldHistory(
  history: readonly ScaffoldHistoryEntry[],
  input: {
    caseId: string;
    attemptIds: readonly string[];
    score: ScaffoldScoreInput;
  },
): ScaffoldHistoryEntry[] {
  const attemptKey = normalizedAttemptKey(input.attemptIds);
  if (history.some((entry) => entry.caseId === input.caseId && entry.attemptKey === attemptKey)) {
    return [...history];
  }
  return [...history, { caseId: input.caseId, attemptKey, score: input.score }];
}

export function deriveCasePassEvaluation(
  events: readonly SessionEvent[],
  trainingCase: CaseConfig,
  attemptIds: readonly string[],
  config: LoadedConfig,
) {
  const includedAttemptIds = new Set(attemptIds);
  const latestByNodeId = new Map<string, AssessmentCompletedEvent>();
  for (const event of events) {
    if (
      event.kind !== 'assessment.completed'
      || event.caseId !== trainingCase.id
      || !includedAttemptIds.has(event.attemptId)
      || !trainingCase.targetNodeIds.includes(event.nodeId)
    ) continue;
    const current = latestByNodeId.get(event.nodeId);
    if (!current || event.sequence > current.sequence) latestByNodeId.set(event.nodeId, event);
  }

  const scores: CaseScoreInput[] = trainingCase.targetNodeIds.map((nodeId) => {
    const event = latestByNodeId.get(nodeId);
    if (!event) {
      return { nodeId, outcome: 'unassessed', assistance: { kind: 'none', rounds: 0 } };
    }
    if (event.score.status === 'scored') return caseScoreOf(event as ScoredAssessmentEvent);
    const outcome = event.score.status === 'unanswered'
      ? 'unanswered'
      : event.score.status === 'needs-review' ? 'needs-review' : 'unassessed';
    return { nodeId, outcome, assistance: event.assistance };
  });

  return evaluateCasePass(
    scores,
    trainingCase,
    config.knowledgeModel,
    config.rubrics,
    config.scaffoldPolicy,
  );
}

export function deriveAttemptScores(
  events: readonly SessionEvent[],
  attemptId: string,
): AttemptScores {
  const selected = latestUniqueScoredNodes(events, (event) => event.attemptId === attemptId);
  const caseScores = selected.map(caseScoreOf);
  const scaffoldScores = selected.map(scaffoldScoreOf);
  const earned = scaffoldScores.reduce((sum, score) => sum + score.earned, 0);
  const possible = scaffoldScores.reduce((sum, score) => sum + score.possible, 0);
  return {
    caseScores,
    scaffoldScores,
    summary: {
      earned,
      possible,
      ratio: possible === 0 ? null : earned / possible,
    },
  };
}

export function deriveCaseScaffoldScore(
  events: readonly SessionEvent[],
  caseId: string,
  attemptIds: readonly string[],
): ScaffoldScoreInput | null {
  const includedAttemptIds = new Set(attemptIds);
  const selected = latestUniqueScoredNodes(
    events,
    (event) => event.caseId === caseId && includedAttemptIds.has(event.attemptId),
  );
  if (selected.length === 0) return null;

  const scores = selected.map(scaffoldScoreOf);
  const earned = scores.reduce((sum, score) => sum + score.earned, 0);
  const possible = scores.reduce((sum, score) => sum + score.possible, 0);
  const outcome = scores.some((score) => score.outcome === 'miss')
    ? 'miss'
    : scores.every((score) => score.outcome === 'hit')
      ? 'hit'
      : 'partial';
  const assistance = selected.reduce<ScoredAssessmentEvent['assistance']>(
    (most, event) => event.assistance.rounds >= most.rounds ? event.assistance : most,
    { kind: 'none', rounds: 0 },
  );

  return { outcome, earned, possible, assistance };
}
