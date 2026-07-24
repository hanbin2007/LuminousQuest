import type { LoadedConfig } from '../../../shared/config/schemas';
import { buildLearnerProfile } from '../../../shared/scoring/profile';
import {
  type AssessmentCompletedEvent,
  type StudentSession,
  sessionSchema,
} from '../../../shared/session/schema';

export interface ClassSessionFile {
  name: string;
  text: string;
  batchIndex?: number;
}

export interface ClassSessionUpload {
  size: number;
  text(): Promise<string>;
}

export const MAX_CLASS_SESSION_FILES = 24;
export const MAX_CLASS_SESSION_FILE_BYTES = 512 * 1024;

export type ClassSessionRejectionCode =
  | 'invalid-json'
  | 'invalid-session'
  | 'duplicate-session'
  | 'rubric-version-mismatch'
  | 'config-version-mismatch'
  | 'too-many-files'
  | 'file-too-large'
  | 'file-read-failed';

export interface AcceptedClassSession {
  name: string;
  session: StudentSession;
}

export interface RejectedClassSession {
  name: string;
  code: ClassSessionRejectionCode;
  message: string;
}

type Profile = ReturnType<typeof buildLearnerProfile>;

function answerText(session: StudentSession, answerId: string) {
  const answer = session.events.find((event) =>
    event.kind === 'answer.submitted' && event.id === answerId);
  if (!answer || answer.kind !== 'answer.submitted') return '';
  return answer.answer.format === 'text' || answer.answer.format === 'equation'
    ? answer.answer.value
    : answer.answer.format === 'choice'
      ? answer.answer.optionId
      : JSON.stringify(answer.answer.value);
}

function assessmentOutcome(event: AssessmentCompletedEvent) {
  if (event.score.status === 'scored') {
    return event.score.outcome ?? (
      event.ruleDecision.status === 'hit-with-help'
        ? 'hit-with-help'
        : event.ruleDecision.status
    );
  }
  if (event.score.status === 'unanswered') return 'unanswered' as const;
  if (
    event.extraction.status === 'needs-review'
    || event.ruleDecision.status === 'needs-review'
    || event.following.status === 'needs-review'
    || event.score.status === 'needs-review'
  ) return 'needs-review' as const;
  return 'unassessed' as const;
}

function assessmentReviewReason(event: AssessmentCompletedEvent) {
  for (const value of [event.extraction, event.ruleDecision, event.following, event.score]) {
    if (value.status === 'needs-review' && 'reason' in value) return value.reason;
  }
  return null;
}

function selectedAssessmentForNode(
  session: StudentSession,
  node: Profile['nodes'][number],
) {
  if (!node.selectedAssessment) return undefined;
  return session.events.find((event): event is AssessmentCompletedEvent =>
    event.kind === 'assessment.completed'
    && event.nodeId === node.nodeId
    && event.id === node.selectedAssessment!.eventId
    && event.sequence === node.selectedAssessment!.sequence);
}

function referencedEventIds(value: unknown, key = ''): string[] {
  if (Array.isArray(value)) {
    return /EventIds$/u.test(key)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : value.flatMap((entry) => referencedEventIds(entry));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && /EventId$/u.test(key) ? [value] : [];
  }
  return Object.entries(value).flatMap(([entryKey, entry]) =>
    referencedEventIds(entry, entryKey));
}

export function buildTeacherStudentReport(sessionInput: unknown, config: LoadedConfig) {
  const session = sessionSchema.parse(sessionInput);
  const profile = buildLearnerProfile(session, config);
  const dimensionById = new Map<string, LoadedConfig['knowledgeModel']['dimensions'][number]>(
    config.knowledgeModel.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const nodeById = new Map(config.knowledgeModel.nodes.map((node) => [node.id, node]));
  const rubricByNode = new Map(config.rubrics.rubrics.map((rubric) => [rubric.nodeId, rubric]));
  const caseById = new Map(config.cases.map((trainingCase) => [trainingCase.id, trainingCase]));

  const evidence = profile.nodes.map((node) => {
    const rubric = rubricByNode.get(node.nodeId);
    if (!rubric) throw new Error(`Missing rubric for ${node.nodeId}`);
    const assessment = selectedAssessmentForNode(session, node);
    const matchedRule = node.trace
      ? rubric.rules.find((rule) => rule.id === node.trace?.ruleId)
      : undefined;
    return {
      nodeId: node.nodeId,
      nodeStatement: nodeById.get(node.nodeId)?.statement ?? node.nodeId,
      dimensionId: node.dimensionId,
      dimensionLabel: dimensionById.get(node.dimensionId)?.label ?? node.dimensionId,
      status: node.status,
      outcome: node.outcome ?? null,
      earned: node.earned ?? null,
      possible: node.possible ?? null,
      rubricId: rubric.id,
      rubricVersion: config.rubrics.version,
      rubricRequirements: rubric.evidenceRequirements,
      ruleId: node.trace?.ruleId ?? null,
      ruleDescription: matchedRule?.description ?? null,
      originalAnswer: node.trace?.originalAnswer ?? null,
      evidence: node.trace?.evidence ?? [],
      evidenceQuotes: node.trace?.evidence.map((item) => item.quote) ?? [],
      misconceptionIds: assessment?.misconceptionIds ?? [],
      engine: node.trace?.engine ?? null,
      assistance: node.trace?.assistance ?? node.latestAttempt?.assistance ?? null,
    };
  });

  const trainingRecords = session.events.flatMap((event) => {
    if (
      event.kind !== 'assessment.completed'
      || (event.stageId !== 'training' && event.stageId !== 'transfer')
    ) return [];
    return [{
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      caseId: event.caseId,
      caseTitle: caseById.get(event.caseId)?.title ?? event.caseId,
      stageId: event.stageId,
      attemptId: event.attemptId,
      nodeId: event.nodeId,
      outcome: assessmentOutcome(event),
      answer: answerText(session, event.sourceAnswerEventId),
      assistance: event.assistance,
      ruleReason: 'reason' in event.ruleDecision ? event.ruleDecision.reason : '',
    }];
  });

  const roundsByCycle = new Map<string, number>();
  const scaffoldTrajectory: Array<{
    sequence: number;
    occurredAt: string;
    caseId: string;
    nodeId: string;
    level: string;
    detail: string;
    source: string;
  }> = [];
  session.events.forEach((event) => {
    if (event.stageId !== 'training' && event.stageId !== 'transfer') return;
    if (event.kind === 'assessment.completed') {
      if (event.assistance.kind === 'none') return;
      const level = event.assistance.kind === 'hint'
        ? `提示脚手架 · ${event.assistance.rounds} 轮`
        : `苏格拉底脚手架 · ${event.assistance.rounds} 轮`;
      scaffoldTrajectory.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        caseId: event.caseId,
        nodeId: event.nodeId,
        level,
        detail: `判分时记录 ${event.assistance.rounds} 轮辅助`,
        source: 'assessment',
      });
      return;
    }
    if (event.kind === 'tutor.cycle.started') {
      roundsByCycle.set(event.cycleId, 0);
      scaffoldTrajectory.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        caseId: event.caseId,
        nodeId: event.nodeId,
        level: '苏格拉底启动',
        detail: '针对本次诊断开启微循环',
        source: 'tutor',
      });
      return;
    }
    if (event.kind === 'tutor.turn.completed') {
      const round = (roundsByCycle.get(event.cycleId) ?? 0) + 1;
      roundsByCycle.set(event.cycleId, round);
      scaffoldTrajectory.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        caseId: event.caseId,
        nodeId: event.nodeId,
        level: `苏格拉底第 ${round} 轮`,
        detail: event.turn.content,
        source: event.source,
      });
      return;
    }
    if (event.kind === 'tutor.cycle.terminal') {
      scaffoldTrajectory.push({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        caseId: event.caseId,
        nodeId: event.nodeId,
        level: '强制推进',
        detail: event.content,
        source: 'tutor',
      });
    }
  });

  const judgmentById = new Map(session.events.flatMap((event) =>
    event.kind === 'agent.judgment.recorded' ? [[event.id, event] as const] : []));
  const assessmentById = new Map(session.events.flatMap((event) =>
    event.kind === 'assessment.completed' ? [[event.id, event] as const] : []));
  const assessmentAuditById = new Map(session.events.flatMap((event) =>
    event.kind === 'assessment.audit.completed' ? [[event.id, event] as const] : []));
  const judgments = session.events.flatMap((event) => {
    if (event.kind !== 'agent.judgment.recorded') return [];
    return [{
      eventId: event.id,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      caseId: event.caseId,
      caseTitle: caseById.get(event.caseId)?.title ?? event.caseId,
      stageId: event.stageId,
      turnId: event.turnId,
      nodeId: event.nodeId,
      verdict: event.verdict,
      rationale: event.rationale,
      basisThroughSequence: event.basisThroughSequence,
      basisEventIds: event.basisEventIds,
      supersedesEventId: event.supersedesEventId ?? null,
    }];
  });
  type DivergenceRow = {
    eventId: string;
    sequence: number;
    occurredAt: string;
    caseId: string;
    caseTitle: string;
    stageId: string;
    attemptId: string;
    nodeId: string;
    judgmentEventId: string;
    shadowAssessmentEventId: string;
    agentVerdict: 'hit' | 'partial' | 'miss';
    shadowVerdict: 'hit' | 'partial' | 'miss';
    status: 'detected' | 'resolved' | 'matched';
    comparisonPolicyVersion: string;
    source: 'agent' | 'assessment';
    questionId: string | null;
    originalAnswer: string;
    primaryRationale: string;
    primaryConfidence: number | null;
    auditRationale: string;
    auditEvidence: Array<{ quote: string; start: number; end: number }>;
    auditEngine: { id: string; version: string } | null;
    scopeKey: string;
  };
  const divergenceRows = session.events.flatMap<DivergenceRow>((event) => {
    if (event.kind === 'agent.divergence.changed') {
      const judgment = judgmentById.get(event.judgmentEventId);
      if (!judgment) return [];
      return [{
        eventId: event.id,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        caseId: event.caseId,
        caseTitle: caseById.get(event.caseId)?.title ?? event.caseId,
        stageId: event.stageId,
        attemptId: judgment.attemptId,
        nodeId: judgment.nodeId,
        judgmentEventId: event.judgmentEventId,
        shadowAssessmentEventId: event.shadowAssessmentEventId,
        agentVerdict: event.agentVerdict,
        shadowVerdict: event.shadowVerdict,
        status: event.status,
        comparisonPolicyVersion: event.comparisonPolicyVersion,
        source: 'agent' as const,
        questionId: null,
        originalAnswer: '',
        primaryRationale: judgment.rationale,
        primaryConfidence: null,
        auditRationale: '',
        auditEvidence: [],
        auditEngine: null,
        scopeKey: `agent\u0000${judgment.nodeId}`,
      }];
    }
    if (event.kind === 'assessment.divergence.changed') {
      const primary = assessmentById.get(event.primaryAssessmentEventId);
      const audit = assessmentAuditById.get(event.auditEventId);
      if (!primary || !audit) return [];
      return [{
        eventId: event.id,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        caseId: event.caseId,
        caseTitle: caseById.get(event.caseId)?.title ?? event.caseId,
        stageId: event.stageId,
        attemptId: event.attemptId,
        nodeId: event.nodeId,
        judgmentEventId: event.primaryAssessmentEventId,
        shadowAssessmentEventId: event.auditEventId,
        agentVerdict: event.primaryVerdict,
        shadowVerdict: event.auditVerdict,
        status: event.status,
        comparisonPolicyVersion: event.comparisonPolicyVersion,
        source: 'assessment' as const,
        questionId: audit.questionId,
        originalAnswer: answerText(session, event.sourceAnswerEventId),
        primaryRationale: 'reason' in primary.ruleDecision
          ? primary.ruleDecision.reason
          : 'Direct assessment did not persist a scored rationale.',
        primaryConfidence: primary.extraction.status === 'assessed'
          ? primary.extraction.judgment?.confidence ?? null
          : null,
        auditRationale: audit.rationale,
        auditEvidence: audit.evidence,
        auditEngine: audit.engine,
        scopeKey: `assessment\u0000${event.sourceAnswerEventId}\u0000${event.nodeId}`,
      }];
    }
    return [];
  });
  const latestDivergenceByScope = new Map<string, typeof divergenceRows[number]>();
  divergenceRows.forEach((event) => latestDivergenceByScope.set(event.scopeKey, event));
  const divergences = divergenceRows.map(({ scopeKey, ...event }) => ({
    ...event,
    unresolved: event.status === 'detected'
      && latestDivergenceByScope.get(scopeKey)?.eventId === event.eventId,
  }));
  const unresolvedDivergences = divergences.filter((event) => event.unresolved);

  const eventIds = new Set(session.events.map((event) => event.id));
  const turnEventByTurnId = new Map(session.events.flatMap((event) =>
    event.kind === 'agent.turn.completed' ? [[event.turnId, event.id] as const] : []));
  const links = new Map<string, Set<string>>();
  const link = (left: string, right: string) => {
    if (left === right || !eventIds.has(left) || !eventIds.has(right)) return;
    const leftLinks = links.get(left) ?? new Set<string>();
    const rightLinks = links.get(right) ?? new Set<string>();
    leftLinks.add(right);
    rightLinks.add(left);
    links.set(left, leftLinks);
    links.set(right, rightLinks);
  };
  for (const event of session.events) {
    referencedEventIds(event).forEach((eventId) => link(event.id, eventId));
    if ('turnId' in event && typeof event.turnId === 'string') {
      const turnEventId = turnEventByTurnId.get(event.turnId);
      if (turnEventId) link(event.id, turnEventId);
    }
    if (
      event.kind === 'answer.submitted'
      && event.responseToAgentTurnId
    ) {
      const turnEventId = turnEventByTurnId.get(event.responseToAgentTurnId);
      if (turnEventId) link(event.id, turnEventId);
    }
  }
  const relatedAgentEventIds = new Set(session.events.flatMap((event) => {
    const commandName = event.command?.commandName
      ?? (event.kind === 'session.command.executed' ? event.commandName : undefined);
    return event.kind.startsWith('agent.')
      || commandName === 'agent-turn'
      || commandName === 'agent-answer'
      ? [event.id]
      : [];
  }));
  const pendingRelatedIds = [...relatedAgentEventIds];
  while (pendingRelatedIds.length > 0) {
    const eventId = pendingRelatedIds.pop()!;
    for (const linkedId of links.get(eventId) ?? []) {
      if (relatedAgentEventIds.has(linkedId)) continue;
      relatedAgentEventIds.add(linkedId);
      pendingRelatedIds.push(linkedId);
    }
  }
  const agentEventChain = session.events.flatMap((event) => {
    if (!relatedAgentEventIds.has(event.id)) return [];
    let relation = '';
    if (event.kind === 'agent.turn.completed') {
      relation = `trigger=${event.triggerEventId} · turn=${event.turnId}`;
    } else if (event.kind === 'answer.submitted' && event.responseToAgentTurnId) {
      relation = `responseTo=${event.responseToAgentTurnId}`;
    } else if (
      event.kind === 'assessment.completed'
      || event.kind === 'assessment.audit.completed'
      || event.kind === 'assessment.divergence.changed'
    ) {
      relation = `sourceAnswer=${event.sourceAnswerEventId}`;
    } else if (event.kind === 'agent.judgment.recorded') {
      relation = `turn=${event.turnId} · node=${event.nodeId}`;
    } else if (event.kind === 'agent.divergence.changed') {
      relation = `judgment=${event.judgmentEventId}`;
    } else if (event.kind === 'session.command.executed') {
      relation = `command=${event.commandName} · key=${event.idempotencyKey}`;
    } else {
      const references = referencedEventIds(event).filter((eventId) =>
        relatedAgentEventIds.has(eventId));
      relation = references.length > 0
        ? `links=${references.join(',')}`
        : 'Agent chain event';
    }
    return [{
      id: event.id,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      kind: event.kind,
      caseId: event.caseId,
      stageId: event.stageId,
      relation,
      commandName: event.command?.commandName
        ?? (event.kind === 'session.command.executed' ? event.commandName : null),
      rawEvent: event,
    }];
  });

  const assessmentNeedsReview = session.events.flatMap((event) => {
    if (event.kind !== 'assessment.completed') return [];
    const reason = assessmentReviewReason(event);
    if (!reason) return [];
    return [{
      kind: 'assessment' as const,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      caseId: event.caseId,
      caseTitle: caseById.get(event.caseId)?.title ?? event.caseId,
      stageId: event.stageId,
      attemptId: event.attemptId,
      nodeId: event.nodeId,
      rubricId: event.rubric.id,
      reason,
      originalAnswer: answerText(session, event.sourceAnswerEventId),
    }];
  });
  const divergenceNeedsReview = unresolvedDivergences.map((event) => ({
    kind: 'divergence' as const,
    source: event.source,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    caseId: event.caseId,
    caseTitle: event.caseTitle,
    stageId: event.stageId,
    attemptId: event.attemptId,
    nodeId: event.nodeId,
    judgmentEventId: event.judgmentEventId,
    shadowAssessmentEventId: event.shadowAssessmentEventId,
    agentVerdict: event.agentVerdict,
    shadowVerdict: event.shadowVerdict,
    reason: event.source === 'assessment'
      ? '直接评判与旧判分审计结果不一致。'
      : 'Agent 判断与判分引擎记录不一致。',
  }));
  const needsReview = [...assessmentNeedsReview, ...divergenceNeedsReview]
    .sort((left, right) => left.sequence - right.sequence);

  return {
    sessionId: session.id,
    anonymousStudentId: session.anonymousStudentId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    rubricVersion: session.configVersions.rubrics,
    evidence,
    trainingRecords,
    scaffoldTrajectory,
    needsReview,
    agentAudit: {
      judgments,
      divergences,
      unresolvedCount: unresolvedDivergences.length,
    },
    agentEventChain,
    profile,
  };
}

function rejection(
  name: string,
  code: ClassSessionRejectionCode,
  message: string,
): RejectedClassSession {
  return { name, code, message };
}

function batchLabel(index: number) {
  return `批次文件 ${index + 1}`;
}

export async function readClassSessionFileBatch(
  uploads: readonly ClassSessionUpload[],
) {
  const limited = uploads.slice(0, MAX_CLASS_SESSION_FILES);
  const settled = await Promise.allSettled(limited.map(async (upload, batchIndex) => {
    if (upload.size > MAX_CLASS_SESSION_FILE_BYTES) {
      throw new Error('file-too-large');
    }
    return {
      name: batchLabel(batchIndex),
      batchIndex,
      text: await upload.text(),
    } satisfies ClassSessionFile;
  }));
  const files: ClassSessionFile[] = [];
  const rejected: RejectedClassSession[] = [];
  settled.forEach((result, batchIndex) => {
    if (result.status === 'fulfilled') {
      files.push(result.value);
      return;
    }
    const tooLarge = result.reason instanceof Error && result.reason.message === 'file-too-large';
    rejected.push(rejection(
      batchLabel(batchIndex),
      tooLarge ? 'file-too-large' : 'file-read-failed',
      tooLarge
        ? `文件超过 ${Math.floor(MAX_CLASS_SESSION_FILE_BYTES / 1024)} KiB 上限，未读取。`
        : '文件读取失败，未计入汇总。',
    ));
  });
  uploads.slice(MAX_CLASS_SESSION_FILES).forEach((_upload, overflowIndex) => {
    const batchIndex = MAX_CLASS_SESSION_FILES + overflowIndex;
    rejected.push(rejection(
      batchLabel(batchIndex),
      'too-many-files',
      `单次最多导入 ${MAX_CLASS_SESSION_FILES} 份文件，该文件未读取。`,
    ));
  });
  return { files, rejected };
}

export function importClassSessionFiles(
  files: readonly ClassSessionFile[],
  config: LoadedConfig,
  existingSessions: readonly StudentSession[] = [],
) {
  const accepted: AcceptedClassSession[] = [];
  const rejected: RejectedClassSession[] = [];
  const sessionIds = new Set(existingSessions.map((session) => session.id));

  for (const [index, file] of files.entries()) {
    const name = batchLabel(file.batchIndex ?? index);
    let value: unknown;
    try {
      value = JSON.parse(file.text);
    } catch {
      rejected.push(rejection(name, 'invalid-json', '文件不是有效 JSON。'));
      continue;
    }
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success) {
      rejected.push(rejection(
        name,
        'invalid-session',
        '文件不符合 session.v2 会话结构，未导入班级数据。',
      ));
      continue;
    }
    const session = parsed.data;
    if (sessionIds.has(session.id)) {
      rejected.push(rejection(
        name,
        'duplicate-session',
        '该匿名会话已存在，重复文件未计入。',
      ));
      continue;
    }
    if (session.configVersions.rubrics !== config.rubrics.version) {
      rejected.push(rejection(
        name,
        'rubric-version-mismatch',
        `量表版本 ${session.configVersions.rubrics} 与当前 ${config.rubrics.version} 不一致。`,
      ));
      continue;
    }
    try {
      buildLearnerProfile(session, config);
    } catch {
      rejected.push(rejection(
        name,
        'config-version-mismatch',
        '会话配置版本或内容与当前课程不一致。',
      ));
      continue;
    }
    sessionIds.add(session.id);
    accepted.push({ name, session });
  }

  return { accepted, rejected };
}

function quantile(values: readonly number[], position: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function latestSessionPerStudent(sessions: readonly StudentSession[]) {
  const latest = new Map<string, StudentSession>();
  sessions.forEach((session) => {
    const current = latest.get(session.anonymousStudentId);
    if (!current || Date.parse(session.updatedAt) >= Date.parse(current.updatedAt)) {
      latest.set(session.anonymousStudentId, session);
    }
  });
  return [...latest.values()].sort((left, right) =>
    left.anonymousStudentId.localeCompare(right.anonymousStudentId));
}

function persistedMisconceptions(event: AssessmentCompletedEvent) {
  if (event.misconceptionIds?.length) return event.misconceptionIds;
  const reason = 'reason' in event.ruleDecision ? event.ruleDecision.reason : '';
  return reason.match(/[A-Z]\d+-M\d+/gu) ?? [];
}

export function buildClassSummary(
  sessionInputs: readonly unknown[],
  config: LoadedConfig,
  topN = 5,
) {
  const inputSessions = sessionInputs.map((input) => sessionSchema.parse(input));
  const sessions = latestSessionPerStudent(inputSessions);
  const studentProfiles = sessions.map((session) => ({
    session,
    profile: buildLearnerProfile(session, config),
  }));
  const profiles = studentProfiles.map((entry) => entry.profile);
  const dimensions = config.knowledgeModel.dimensions.map((dimension) => {
    const values = profiles.flatMap((profile) => {
      const ratio = profile.dimensions.find((entry) => entry.dimensionId === dimension.id)?.ratio;
      return ratio === null || ratio === undefined ? [] : [ratio];
    });
    return {
      dimensionId: dimension.id,
      label: dimension.label,
      assessedCount: values.length,
      mean: values.length === 0
        ? null
        : values.reduce((total, value) => total + value, 0) / values.length,
      minimum: quantile(values, 0),
      quartileLow: quantile(values, 0.25),
      median: quantile(values, 0.5),
      quartileHigh: quantile(values, 0.75),
      maximum: quantile(values, 1),
    };
  });

  const nodeErrorRates = config.knowledgeModel.nodes.flatMap((node) => {
    const results = profiles.flatMap((profile) => {
      const item = profile.nodes.find((entry) => entry.nodeId === node.id);
      return item?.status === 'scored' ? [item] : [];
    });
    if (results.length === 0) return [];
    const errorCount = results.filter((item) =>
      item.outcome === 'partial' || item.outcome === 'miss').length;
    return [{
      nodeId: node.id,
      statement: node.statement,
      dimensionId: node.dimensionId,
      assessedCount: results.length,
      errorCount,
      rate: errorCount / results.length,
    }];
  }).sort((left, right) =>
    right.rate - left.rate
    || right.assessedCount - left.assessedCount
    || left.nodeId.localeCompare(right.nodeId));

  const misconceptionConfig = new Map(config.knowledgeModel.nodes.flatMap((node) =>
    node.misconceptions.map((item) => [item.id, {
      id: item.id,
      nodeId: node.id,
      dimensionId: node.dimensionId,
      statement: item.statement,
    }] as const)));
  const counts = new Map<string, number>();
  studentProfiles.forEach(({ session, profile }) => {
    const seenForStudent = new Set<string>();
    profile.nodes.forEach((node) => {
      if (node.outcome !== 'partial' && node.outcome !== 'miss') return;
      const event = selectedAssessmentForNode(session, node);
      if (!event) return;
      persistedMisconceptions(event).forEach((id) => {
        const configured = misconceptionConfig.get(id);
        if (!configured || configured.nodeId !== event.nodeId || seenForStudent.has(id)) return;
        seenForStudent.add(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      });
    });
  });
  const misconceptions = [...counts]
    .map(([id, count]) => ({ ...misconceptionConfig.get(id)!, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.floor(topN)));

  return {
    sessionCount: sessions.length,
    inputSessionCount: inputSessions.length,
    anonymousStudentIds: [...new Set(sessions.map((session) => session.anonymousStudentId))].sort(),
    rubricVersion: config.rubrics.version,
    dimensions,
    nodeErrorRates,
    misconceptions,
  };
}
