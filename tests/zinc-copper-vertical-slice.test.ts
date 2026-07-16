import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { buildLearnerProfile } from '../shared/scoring/profile';
import {
  recordStructuredTextAssessment,
  structuredAssessmentResponseSchema,
} from '../shared/workflows/assessment';
import {
  recordBuilderAssessment,
  recordEquationAssessment,
} from '../shared/workflows/engine-assessment';
import {
  LocalSessionStore,
  createSession,
  sessionConfigVersions,
  type StudentSession,
} from '../shared/session';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

type LoadedConfig = Awaited<ReturnType<typeof loadAllConfig>>;
type BuilderAnswer = Parameters<typeof recordBuilderAssessment>[0]['answer']['value'];

interface SliceAnswers {
  builder: BuilderAnswer;
  negative: string;
  positive: string;
  overall: string;
}

function rawSliceAnswers(): SliceAnswers {
  return {
    builder: {
      components: [
        { instanceId: 'negative', componentId: 'site-a', x: 0, y: 0, assignedRole: 'oxidation-site' },
        { instanceId: 'wire', componentId: 'electron-link', x: 1, y: 0, assignedRole: 'electron-conductor' },
        { instanceId: 'ions', componentId: 'ion-medium', x: 1, y: 1, assignedRole: 'ion-conductor' },
        { instanceId: 'positive', componentId: 'site-b', x: 2, y: 0, assignedRole: 'reduction-site' },
        { instanceId: 'electron-arrow', componentId: 'electron-arrow', x: 1, y: -1 },
        { instanceId: 'cation-arrow', componentId: 'cation-arrow', x: 2, y: 1 },
        { instanceId: 'anion-arrow', componentId: 'anion-arrow', x: 0, y: 1 },
      ],
      connections: [
        { id: '', from: 'negative', to: 'wire', kind: 'electron-path', carrier: 'electron' },
        { id: '', from: 'wire', to: 'positive', kind: 'electron-path', carrier: 'electron' },
        { id: '', from: 'ions', to: 'positive', kind: 'ion-path', carrier: 'cation' },
        { id: '', from: 'ions', to: 'negative', kind: 'ion-path', carrier: 'anion' },
      ],
    },
    negative: 'Zn - 2e⁻ = Zn²⁺',
    positive: 'Cu²⁺ + 2e⁻ = Cu',
    overall: 'Zn + Cu²⁺ = Zn²⁺ + Cu',
  };
}

function runDeterministicSlice(
  session: StudentSession,
  config: LoadedConfig,
  answers: SliceAnswers,
) {
  const builder = recordBuilderAssessment({
    session,
    config,
    answer: {
      id: 'answer-builder',
      occurredAt: '2026-07-15T12:01:00.000Z',
      caseId: 'zinc-copper',
      stageId: 'builder',
      attemptId: 'attempt-builder',
      questionId: 'generic-cell',
      value: answers.builder,
    },
    assistance: { kind: 'none', rounds: 0 },
    assessmentEventIdPrefix: 'builder-score',
    assessedAt: '2026-07-15T12:01:01.000Z',
  });
  const negative = recordEquationAssessment({
    session: builder.session,
    config,
    equationSetId: 'zinc-negative',
    answer: {
      id: 'answer-negative',
      occurredAt: '2026-07-15T12:02:00.000Z',
      caseId: 'zinc-copper',
      stageId: 'equations',
      attemptId: 'attempt-negative',
      questionId: 'negative-half-reaction',
      value: answers.negative,
    },
    assistance: { kind: 'none', rounds: 0 },
    assessmentEventIdPrefix: 'negative-score',
    assessedAt: '2026-07-15T12:02:01.000Z',
  });
  const positive = recordEquationAssessment({
    session: negative.session,
    config,
    equationSetId: 'copper-positive',
    answer: {
      id: 'answer-positive',
      occurredAt: '2026-07-15T12:03:00.000Z',
      caseId: 'zinc-copper',
      stageId: 'equations',
      attemptId: 'attempt-positive',
      questionId: 'positive-half-reaction',
      value: answers.positive,
    },
    assistance: { kind: 'none', rounds: 0 },
    assessmentEventIdPrefix: 'positive-score',
    assessedAt: '2026-07-15T12:03:01.000Z',
  });
  const overall = recordEquationAssessment({
    session: positive.session,
    config,
    equationSetId: 'zinc-copper-overall',
    answer: {
      id: 'answer-overall',
      occurredAt: '2026-07-15T12:04:00.000Z',
      caseId: 'zinc-copper',
      stageId: 'equations',
      attemptId: 'attempt-overall',
      questionId: 'overall-reaction',
      value: answers.overall,
    },
    assistance: { kind: 'none', rounds: 0 },
    assessmentEventIdPrefix: 'overall-score',
    assessedAt: '2026-07-15T12:04:01.000Z',
  });
  return { builder, negative, positive, overall };
}

function persistedAnswers(session: StudentSession): SliceAnswers {
  const byQuestionId = new Map(session.events.flatMap((event) =>
    event.kind === 'answer.submitted' ? [[event.questionId, event.answer] as const] : []));
  const builder = byQuestionId.get('generic-cell');
  const negative = byQuestionId.get('negative-half-reaction');
  const positive = byQuestionId.get('positive-half-reaction');
  const overall = byQuestionId.get('overall-reaction');
  if (
    builder?.format !== 'builder'
    || negative?.format !== 'text'
    || positive?.format !== 'text'
    || overall?.format !== 'text'
  ) {
    throw new Error('Persisted deterministic slice answers are incomplete');
  }
  return {
    builder: {
      components: builder.value.components,
      connections: builder.value.connections.map((connection) => ({
        ...connection,
        id: connection.id ?? '',
      })),
    },
    negative: negative.value,
    positive: positive.value,
    overall: overall.value,
  };
}

describe('zinc-copper M1a vertical slice', () => {
  it('runs real topology and three equation answers through save, process restore, and offline replay', async () => {
    const config = await loadAllConfig(process.cwd());
    const initial = createSession({
      id: 'session-zinc-slice',
      anonymousStudentId: 'anon-A1B2C3D4',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const firstRun = runDeterministicSlice(initial, config, rawSliceAnswers());

    expect(firstRun.builder.assessment).toMatchObject({
      overall: 'hit',
      checks: {
        fourElements: { status: 'hit' },
        closedCircuit: {
          status: 'hit',
          witness: {
            oxidationSiteId: 'negative',
            reductionSiteId: 'positive',
          },
        },
        directionConsistency: { status: 'hit' },
        abstraction: { status: 'hit' },
      },
    });
    expect(firstRun.negative.assessment.outcome).toBe('hit');
    expect(firstRun.positive.assessment.outcome).toBe('hit');
    expect(firstRun.overall.assessment.outcome).toBe('hit');

    const finalSession = firstRun.overall.session;
    const builderAnswerEvent = finalSession.events.find((event) =>
      event.kind === 'answer.submitted' && event.questionId === 'generic-cell');
    expect(builderAnswerEvent?.kind === 'answer.submitted' && builderAnswerEvent.answer.format === 'builder'
      ? builderAnswerEvent.answer.value.connections.map((connection) => connection.id)
      : []).toEqual(['connection-1', 'connection-2', 'connection-3', 'connection-4']);
    const scores = finalSession.events.filter((event) =>
      event.kind === 'assessment.completed' && event.score.status === 'scored');
    expect(scores).toHaveLength(12);
    expect(scores.every((event) =>
      event.kind === 'assessment.completed'
      && event.score.status === 'scored'
      && 'ruleId' in event.ruleDecision
      && event.ruleDecision.engine.sourceRuleId !== undefined)).toBe(true);
    for (const nodeId of ['D1', 'D2', 'D3', 'D4', 'D5', 'P3', 'P4', 'P6', 'P7']) {
      expect(firstRun.overall.profile.nodes.find((node) => node.nodeId === nodeId)?.outcome,
        nodeId).toBe('hit');
    }

    const storage = new MemoryStorage();
    new LocalSessionStore(storage).save(finalSession);

    // A fresh config/store pair models a new process with no model provider or network dependency.
    const reloadedConfig = await loadAllConfig(process.cwd());
    const restored = new LocalSessionStore(storage).restoreLatest(
      sessionConfigVersions(reloadedConfig),
    );
    expect(restored).toEqual(finalSession);
    if (!restored) throw new Error('Expected the saved session to restore');
    expect(buildLearnerProfile(restored, reloadedConfig)).toEqual(firstRun.overall.profile);

    const replayInitial = createSession({
      id: restored.id,
      anonymousStudentId: restored.anonymousStudentId,
      now: restored.startedAt,
      configVersions: sessionConfigVersions(reloadedConfig),
    });
    const replay = runDeterministicSlice(
      replayInitial,
      reloadedConfig,
      persistedAnswers(restored),
    );
    expect(replay.overall.session).toEqual(restored);
    expect(replay.overall.profile).toEqual(firstRun.overall.profile);
  });

  it('rejects duplicate or unconfigured node assessments before persisting them', async () => {
    const assessment = {
      nodeId: 'P2',
      errorIds: [],
      facts: {
        response: 'substantive' as const,
        terminology: 'model' as const,
        syllabus: 'within' as const,
        contradiction: false,
        typo: 'none' as const,
        slots: [{
          id: 'reducing-agent',
          value: 'Zn',
          evidence: { quote: 'Zn', start: 0, end: 2 },
        }],
      },
      evidence: [{ quote: 'Zn', start: 0, end: 2 }],
      assistance: { kind: 'none' as const, rounds: 0 },
    };
    expect(structuredAssessmentResponseSchema.safeParse({
      anchors: [],
      assessments: [assessment, assessment],
    }).success).toBe(false);

    const config = await loadAllConfig(process.cwd());
    const session = createSession({
      id: 'session-invalid-extraction',
      anonymousStudentId: 'anon-A1B2C3D4',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    expect(() => recordStructuredTextAssessment({
      session,
      config,
      answer: {
        id: 'answer-invalid',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-invalid',
        questionId: 'zinc-analysis',
        value: 'Zn',
      },
      extraction: {
        anchors: [],
        assessments: [{ ...assessment, nodeId: 'UNKNOWN' }],
      },
      provenance: {
        promptId: 'assessment',
        promptVersion: 'prompt.v1',
        cacheKey: 'cache-key',
        model: 'mock-v1',
      },
      assessmentEventIdPrefix: 'invalid',
      assessedAt: '2026-07-15T12:01:01.000Z',
    })).toThrow(/No rubric configured/);
  });
});
