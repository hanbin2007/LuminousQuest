import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { buildLearnerProfile } from '../shared/scoring/profile';
import {
  LocalSessionStore,
  createSession,
  sessionConfigVersions,
} from '../shared/session';
import {
  recordBuilderAssessment,
  recordEquationAssessment,
} from '../shared/workflows/engine-assessment';
import {
  recordStructuredTextAssessment,
  structuredAssessmentResponseSchema,
} from '../shared/workflows/assessment';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

async function fixture() {
  const config = await loadAllConfig(process.cwd());
  const session = createSession({
    id: 'session-deterministic',
    anonymousStudentId: 'anon-A1B2C3D4',
    now: '2026-07-15T12:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  });
  return { config, session };
}

describe('deterministic workflow and persistence contracts', () => {
  it('rejects inconsistent assistance metadata and duplicate anchor ids at extraction', () => {
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
    const anchor = {
      anchorId: 'case-polarity',
      facts: [{
        id: 'negative',
        value: 'Zn',
        evidence: { quote: 'Zn', start: 0, end: 2 },
      }],
      evidence: [{ quote: 'Zn', start: 0, end: 2 }],
    };

    expect(structuredAssessmentResponseSchema.safeParse({
      anchors: [],
      assessments: [{ ...assessment, assistance: { kind: 'none', rounds: 1 } }],
    }).success).toBe(false);
    expect(structuredAssessmentResponseSchema.safeParse({
      anchors: [],
      assessments: [{ ...assessment, assistance: { kind: 'hint', rounds: 0 } }],
    }).success).toBe(false);
    expect(structuredAssessmentResponseSchema.safeParse({
      anchors: [anchor, anchor],
      assessments: [assessment],
    }).success).toBe(false);
  });

  it('records polarity as an independent event and computes following from facts', async () => {
    const { config, session } = await fixture();
    const answer = '铜是负极，锌是正极；电子从铜流向锌。';
    const quote = (value: string) => ({
      quote: value,
      start: answer.indexOf(value),
      end: answer.indexOf(value) + value.length,
    });
    const result = recordStructuredTextAssessment({
      session,
      config,
      answer: {
        id: 'answer-text',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-text',
        questionId: 'process',
        value: answer,
      },
      extraction: {
        anchors: [{
          anchorId: 'case-polarity',
          facts: [
            { id: 'negative', value: 'Cu', evidence: quote('铜') },
            { id: 'positive', value: 'Zn', evidence: quote('锌') },
          ],
          evidence: [quote('铜是负极，锌是正极')],
        }],
        assessments: [{
          nodeId: 'P4',
          errorIds: ['P4-M1'],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: [
              { id: 'electron-from', value: 'Cu', evidence: quote('铜') },
              { id: 'electron-to', value: 'Zn', evidence: quote('锌') },
            ],
          },
          evidence: [quote('电子从铜流向锌')],
          assistance: { kind: 'none', rounds: 0 },
        }],
      },
      provenance: {
        promptId: 'structured-assessment',
        promptVersion: 'prompt.v2',
        cacheKey: 'cache-text',
        model: 'mock-v2',
      },
      assessmentEventIdPrefix: 'text-assessment',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });

    expect(result.session.events.map((event) => event.kind)).toEqual([
      'answer.submitted',
      'polarity.assessed',
      'assessment.completed',
    ]);
    expect(result.session.events[1]).toMatchObject({
      kind: 'polarity.assessed',
      anchorId: 'case-polarity',
      outcome: 'miss',
    });
    expect(result.profile.nodes.find((node) => node.nodeId === 'P4')).toMatchObject({
      outcome: 'hit',
      annotations: ['following'],
    });
  });

  it('normalizes polarity anchor fact values with the shared fact normalizer', async () => {
    const { config, session } = await fixture();
    const answer = 'Ｚｎ是负极，Ｃｕ是正极。';
    const result = recordStructuredTextAssessment({
      session,
      config,
      answer: {
        id: 'answer-normalized-anchor',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-normalized-anchor',
        questionId: 'polarity',
        value: answer,
      },
      extraction: {
        anchors: [{
          anchorId: 'case-polarity',
          facts: [
            { id: 'negative', value: 'ｚｎ', evidence: { quote: 'Ｚｎ', start: 0, end: 2 } },
            { id: 'positive', value: 'ｃｕ', evidence: { quote: 'Ｃｕ', start: 6, end: 8 } },
          ],
          evidence: [{ quote: answer, start: 0, end: answer.length }],
        }],
        assessments: [{
          nodeId: 'P2',
          errorIds: [],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: [
              {
                id: 'reducing-agent',
                value: 'ｚｎ',
                evidence: { quote: 'Ｚｎ', start: 0, end: 2 },
              },
              {
                id: 'oxidizing-agent',
                value: 'Cu^2+',
                evidence: { quote: answer, start: 0, end: answer.length },
              },
            ],
          },
          evidence: [{ quote: answer, start: 0, end: answer.length }],
          assistance: { kind: 'none', rounds: 0 },
        }],
      },
      provenance: {
        promptId: 'structured-assessment',
        promptVersion: 'prompt.v2',
        cacheKey: 'cache-normalized-anchor',
        model: 'mock-v2',
      },
      assessmentEventIdPrefix: 'normalized-anchor',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });

    expect(result.session.events.find((event) => event.kind === 'polarity.assessed')).toMatchObject({
      outcome: 'hit',
    });
  });

  it('bridges real builder and equation engine decisions through rubric rule ids and scores', async () => {
    const { config, session } = await fixture();
    const built = recordBuilderAssessment({
      session,
      config,
      answer: {
        id: 'answer-builder',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'builder',
        attemptId: 'attempt-builder',
        questionId: 'generic-cell',
        value: {
          components: [
            { instanceId: 'negative', componentId: 'site-a', x: 0, y: 0 },
            { instanceId: 'wire', componentId: 'electron-link', x: 1, y: 0 },
            { instanceId: 'ions', componentId: 'ion-medium', x: 1, y: 1 },
            { instanceId: 'positive', componentId: 'site-b', x: 2, y: 0 },
          ],
          connections: [
            { id: 'e1', from: 'negative', to: 'wire', kind: 'electron-path', carrier: 'electron' },
            { id: 'e2', from: 'wire', to: 'positive', kind: 'electron-path', carrier: 'electron' },
            { id: 'i1', from: 'ions', to: 'positive', kind: 'ion-path', carrier: 'cation' },
            { id: 'i2', from: 'ions', to: 'negative', kind: 'ion-path', carrier: 'anion' },
          ],
        },
      },
      assistance: { kind: 'none', rounds: 0 },
      assessmentEventIdPrefix: 'builder-score',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });
    const equation = recordEquationAssessment({
      session: built.session,
      config,
      equationSetId: 'zinc-negative',
      answer: {
        id: 'answer-equation',
        occurredAt: '2026-07-15T12:02:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'equation',
        attemptId: 'attempt-equation',
        questionId: 'negative-half-reaction',
        value: 'Zn -> Zn²⁺ + 2e⁻',
      },
      assistance: { kind: 'none', rounds: 0 },
      assessmentEventIdPrefix: 'equation-score',
      assessedAt: '2026-07-15T12:02:01.000Z',
    });

    const scored = equation.session.events.filter((event) =>
      event.kind === 'assessment.completed' && event.score.status === 'scored');
    expect(scored.length).toBeGreaterThanOrEqual(8);
    expect(scored.every((event) => {
      if (event.kind !== 'assessment.completed' || event.score.status !== 'scored') return false;
      return 'ruleId' in event.ruleDecision
        && event.ruleDecision.ruleId.length > 0
        && event.score.earned >= 0;
    })).toBe(true);
    expect(equation.profile.nodes.find((node) => node.nodeId === 'P6')?.outcome).toBe('hit');
  });

  it('persists a blank structured response as unanswered without scoring it', async () => {
    const { config, session } = await fixture();
    const result = recordStructuredTextAssessment({
      session,
      config,
      answer: {
        id: 'answer-blank',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-blank',
        questionId: 'process',
        value: '',
      },
      extraction: {
        anchors: [],
        assessments: [{
          nodeId: 'P4',
          errorIds: [],
          facts: {
            response: 'blank',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: [],
          },
          evidence: [],
          assistance: { kind: 'none', rounds: 0 },
        }],
      },
      provenance: {
        promptId: 'structured-assessment',
        promptVersion: 'prompt.v2',
        cacheKey: 'cache-blank',
        model: 'mock-v2',
      },
      assessmentEventIdPrefix: 'blank-assessment',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });

    expect(result.session.events.at(-1)).toMatchObject({
      kind: 'assessment.completed',
      ruleDecision: {
        status: 'unanswered',
        promptRetry: config.rubrics.policy.nonResponse.promptRetry,
        includeInDiagnosis: config.rubrics.policy.nonResponse.includeInDiagnosis,
      },
      score: {
        status: 'unanswered',
        promptRetry: config.rubrics.policy.nonResponse.promptRetry,
        includeInDiagnosis: config.rubrics.policy.nonResponse.includeInDiagnosis,
      },
    });
    expect(result.profile.nodes.find((node) => node.nodeId === 'P4')).toMatchObject({
      status: 'unassessed',
      latestAttempt: { status: 'unanswered' },
    });
  });

  it('persists an ambiguous extraction as needs-review without running scoring', async () => {
    const { config, session } = await fixture();
    const answer = 'Zn 被氧化，Cu^2+ 被还原。';
    const result = recordStructuredTextAssessment({
      session,
      config,
      answer: {
        id: 'answer-ambiguous',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-ambiguous',
        questionId: 'reactants',
        value: answer,
      },
      extraction: {
        anchors: [],
        assessments: [{
          nodeId: 'P2',
          errorIds: [],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'ambiguous',
            slots: [
              {
                id: 'reducing-agent',
                value: 'Zn',
                evidence: { quote: 'Zn', start: 0, end: 2 },
              },
              {
                id: 'oxidizing-agent',
                value: 'Cu^2+',
                evidence: { quote: 'Cu^2+', start: 8, end: 13 },
              },
            ],
          },
          evidence: [{ quote: answer, start: 0, end: answer.length }],
          assistance: { kind: 'none', rounds: 0 },
        }],
      },
      provenance: {
        promptId: 'structured-assessment',
        promptVersion: 'prompt.v2',
        cacheKey: 'cache-ambiguous',
        model: 'mock-v2',
      },
      assessmentEventIdPrefix: 'ambiguous-assessment',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });

    expect(result.session.events.at(-1)).toMatchObject({
      pipelineStage: 'extraction',
      extraction: { status: 'needs-review' },
      ruleDecision: { status: 'unassessed' },
      score: { status: 'unassessed' },
    });
    expect(result.profile.nodes.find((node) => node.nodeId === 'P2')).toMatchObject({
      status: 'needs-review',
      latestAttempt: { status: 'needs-review' },
    });
  });

  it('keeps a valid equation mastery score when the latest equation attempt is unanswered', async () => {
    const { config, session } = await fixture();
    const first = recordEquationAssessment({
      session,
      config,
      equationSetId: 'zinc-negative',
      answer: {
        id: 'answer-equation-hit',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'equation',
        attemptId: 'attempt-equation-hit',
        questionId: 'negative-half-reaction',
        value: 'Zn - 2e^- = Zn^2+',
      },
      assistance: { kind: 'none', rounds: 0 },
      assessmentEventIdPrefix: 'equation-hit',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });
    const second = recordEquationAssessment({
      session: first.session,
      config,
      equationSetId: 'zinc-negative',
      answer: {
        id: 'answer-equation-blank',
        occurredAt: '2026-07-15T12:02:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'equation',
        attemptId: 'attempt-equation-blank',
        questionId: 'negative-half-reaction',
        value: '不会',
      },
      assistance: { kind: 'none', rounds: 0 },
      assessmentEventIdPrefix: 'equation-blank',
      assessedAt: '2026-07-15T12:02:01.000Z',
    });

    expect(second.profile.nodes.find((node) => node.nodeId === 'P6')).toMatchObject({
      status: 'scored',
      outcome: 'hit',
      latestAttempt: { status: 'unanswered' },
    });
  });

  it('persists the loader digest plus case, grammar, and engine versions and rejects drift', async () => {
    const { config, session } = await fixture();
    expect(session.configVersions).toMatchObject({
      configDigest: config.configVersion,
      cases: Object.fromEntries(config.cases.map((entry) => [entry.id, entry.version])),
      grammar: expect.stringMatching(/^equation-grammar\.v\d+$/),
      engines: {
        rubric: expect.stringMatching(/\.v\d+$/),
        topology: expect.stringMatching(/\.v\d+$/),
        equation: expect.stringMatching(/\.v\d+$/),
      },
    });

    const store = new LocalSessionStore(new MemoryStorage());
    store.save(session);
    expect(store.restoreLatest(session.configVersions)).toEqual(session);
    expect(store.restoreLatest({ ...session.configVersions, configDigest: 'sha256:changed' })).toBeNull();

    const changed = structuredClone(config);
    changed.configVersion = 'sha256:changed';
    expect(() => buildLearnerProfile(session, changed)).toThrow(/config digest/i);
  });
});
