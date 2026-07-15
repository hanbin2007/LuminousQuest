import {
  type AssessmentCompletedEvent,
  type SessionEventInput,
  type StudentSession,
  sessionSchema,
} from './schema';
import type { LoadedConfig } from '../config/schemas';

export interface CreateSessionInput {
  id?: string;
  anonymousStudentId?: string;
  now?: string;
  configVersions: StudentSession['configVersions'];
}

export function sessionConfigVersions(config: LoadedConfig): StudentSession['configVersions'] {
  return {
    configDigest: config.configVersion,
    knowledgeModel: config.knowledgeModel.version,
    rubrics: config.rubrics.version,
    pretest: config.pretest.version,
    scaffoldPolicy: config.scaffoldPolicy.version,
    cases: config.runtimeVersions.cases,
    grammar: config.runtimeVersions.grammar,
    engines: config.runtimeVersions.engines,
  };
}

export function createAnonymousStudentId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `anon-${suffix.toUpperCase()}`;
}

export function createSession(input: CreateSessionInput): StudentSession {
  const now = input.now ?? new Date().toISOString();
  return sessionSchema.parse({
    schemaVersion: 'session.v2',
    id: input.id ?? crypto.randomUUID(),
    anonymousStudentId: input.anonymousStudentId ?? createAnonymousStudentId(),
    startedAt: now,
    updatedAt: now,
    configVersions: input.configVersions,
    events: [],
  });
}

export function appendSessionEvent(
  session: StudentSession,
  event: SessionEventInput,
): StudentSession {
  const current = sessionSchema.parse(session);
  return sessionSchema.parse({
    ...current,
    updatedAt: event.occurredAt,
    events: [
      ...current.events,
      {
        ...event,
        schemaVersion: 'event.v2',
        sequence: current.events.length,
      },
    ],
  });
}

export function exportSession(session: StudentSession) {
  return `${JSON.stringify(sessionSchema.parse(session), null, 2)}\n`;
}

export function importSession(source: string) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Session import is not valid JSON: ${(error as Error).message}`);
  }
  return sessionSchema.parse(value);
}

export interface ScoreSummary {
  earned: number;
  possible: number;
  ratio: number | null;
  assessedNodeIds: string[];
  unassessedNodeIds: string[];
  needsReviewNodeIds: string[];
  unansweredNodeIds: string[];
  latestAttemptStatusByNode: Record<
    string,
    'scored' | 'unanswered' | 'unassessed' | 'needs-review'
  >;
}

export function summarizeAssessedScores(session: unknown): ScoreSummary {
  const parsedSession = sessionSchema.parse(session);
  const latestByNode = new Map<string, AssessmentCompletedEvent>();
  const latestScoredByNode = new Map<string, AssessmentCompletedEvent & {
    score: { status: 'scored'; earned: number; possible: number };
  }>();
  for (const event of parsedSession.events) {
    if (event.kind !== 'assessment.completed') continue;
    latestByNode.set(event.nodeId, event);
    if (event.score.status === 'scored') latestScoredByNode.set(event.nodeId, event as typeof event & {
      score: { status: 'scored'; earned: number; possible: number };
    });
  }
  const latest = [...latestByNode.values()].sort((left, right) => left.sequence - right.sequence);
  const assessed = [...latestScoredByNode.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const latestStatus = (event: AssessmentCompletedEvent) => {
    if ([event.extraction.status, event.ruleDecision.status, event.following.status, event.score.status]
      .includes('needs-review')) return 'needs-review' as const;
    if (event.score.status === 'unanswered') return 'unanswered' as const;
    if (event.score.status === 'scored') return 'scored' as const;
    return 'unassessed' as const;
  };
  const latestAttemptStatusByNode = Object.fromEntries(
    latest.map((event) => [event.nodeId, latestStatus(event)]),
  );
  const earned = assessed.reduce((sum, event) => sum + event.score.earned, 0);
  const possible = assessed.reduce((sum, event) => sum + event.score.possible, 0);

  return {
    earned,
    possible,
    ratio: possible === 0 ? null : earned / possible,
    assessedNodeIds: assessed.map((event) => event.nodeId),
    unassessedNodeIds: latest
      .filter((event) => latestStatus(event) === 'unassessed' && !latestScoredByNode.has(event.nodeId))
      .map((event) => event.nodeId),
    needsReviewNodeIds: latest
      .filter((event) => latestStatus(event) === 'needs-review')
      .map((event) => event.nodeId),
    unansweredNodeIds: latest
      .filter((event) => latestStatus(event) === 'unanswered')
      .map((event) => event.nodeId),
    latestAttemptStatusByNode,
  };
}
