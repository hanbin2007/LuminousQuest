import { describe, expect, it } from 'vitest';

import {
  ResponseContractRegistry,
  ResponseContractBindingError,
} from '../server/agent/response-contracts';
import {
  AGENT_SHADOW_COMPARISON_POLICY_VERSION,
  selectShadowAssessmentAtBasis,
} from '../server/agent/shadow-comparison';
import { loadAllConfig } from '../server/config/loader';
import {
  AGENT_CONTEXT_BUILDER_VERSION,
  AGENT_CONTRACT_REVISION,
  AGENT_TOOLSET_DIGEST,
  responseContractSchema,
} from '../shared/agent/contracts';
import { buildLearnerProfile } from '../shared/scoring/profile';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import {
  appendSessionEvent,
  agentAnswerSubmissionSchema,
  createSession,
  exportSession,
  importSession,
  sessionConfigVersions,
  sessionSchema,
  type AssessmentCompletedEvent,
  type SessionEventInput,
  type StudentSession,
} from '../shared/session';
import {
  projectStudentSession,
  projectTeacherAuditSession,
} from '../shared/session/projections';
import { buildTeacherStudentReport, importClassSessionFiles } from '../src/features/teacher/teacher-data';
import { buildLiveCellState } from '../src/features/model/live-cell';
import { buildModelScene } from '../src/features/model/lighting';

const staticConfigVersions = {
  configDigest: 'sha256:test',
  knowledgeModel: 'knowledge-model.v1',
  rubrics: 'rubrics.v1',
  pretest: 'pretest.v1',
  scaffoldPolicy: 'scaffold-policy.v1',
  cases: { 'zinc-copper': 'case.v1' },
  grammar: 'equation-grammar.v1',
  engines: {
    rubric: 'rubric-policy.v2',
    topology: 'builder-topology.v1',
    equation: 'equation-scoring.v1',
  },
};

function staticSession() {
  return createSession({
    id: 'm6-contract-session',
    anonymousStudentId: 'anon-M6TEST01',
    now: '2026-07-23T12:00:00.000Z',
    configVersions: staticConfigVersions,
  });
}

function answerEvent(
  id = 'answer-1',
  attemptId = 'attempt-1',
): Extract<SessionEventInput, { kind: 'answer.submitted' }> {
  return {
    id,
    occurredAt: '2026-07-23T12:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId,
    questionId: 'zinc-copper:analysis',
    answer: { format: 'text', value: '电子从锌极流向铜极。' },
  };
}

function assessmentEvent(
  overrides: Partial<Extract<SessionEventInput, { kind: 'assessment.completed' }>> = {},
): Extract<SessionEventInput, { kind: 'assessment.completed' }> {
  const answer = '电子从锌极流向铜极。';
  return {
    id: 'assessment-1',
    occurredAt: '2026-07-23T12:00:02.000Z',
    kind: 'assessment.completed',
    pipelineStage: 'score',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: 'attempt-1',
    sourceAnswerEventId: 'answer-1',
    nodeId: 'P4',
    rubric: { id: 'rubric-p4', version: 'rubrics.v1' },
    assistance: { kind: 'none', rounds: 0 },
    extraction: {
      status: 'assessed',
      evidence: [{ quote: answer, start: 0, end: answer.length }],
      model: 'fixture',
      provenance: {
        promptId: 'fixture',
        promptVersion: 'fixture.v1',
        cacheKey: 'fixture:P4',
      },
    },
    ruleDecision: {
      status: 'hit',
      ruleId: 'p4-hit',
      reason: 'direction is correct',
      engine: { id: 'fixture', version: 'fixture.v1' },
    },
    following: {
      status: 'not-followed',
      anchorNodeId: null,
      anchorOutcome: null,
      policy: 'score-logical-chain',
    },
    score: { status: 'scored', earned: 2, possible: 2, annotations: [] },
    ...overrides,
  };
}

function appendAgentAuditEvents(
  baseline: StudentSession,
  assessment: AssessmentCompletedEvent,
) {
  const contractId = 'response-contract-1';
  let session = appendSessionEvent(baseline, {
    id: 'agent-turn-event-1',
    occurredAt: '2026-07-23T12:00:03.000Z',
    kind: 'agent.turn.completed',
    pipelineStage: 'agent',
    caseId: assessment.caseId,
    stageId: assessment.stageId,
    attemptId: 'agent-attempt-1',
    turnId: 'agent-turn-1',
    triggerEventId: assessment.id,
    contextThroughSequence: assessment.sequence,
    requestHash: `sha256:${'a'.repeat(64)}`,
    source: 'provider',
    model: 'frozen-provider-model',
    orderedActions: [
      { callId: 'call-1', name: 'get_profile', arguments: {} },
      {
        callId: 'call-2',
        name: 'conclude_node',
        arguments: {
          nodeId: assessment.nodeId,
          verdict: 'miss',
          rationale: 'The explanation reverses the causal direction.',
        },
      },
      {
        callId: 'call-3',
        name: 'ask_student',
        arguments: {
          text: '请再说明电子为什么沿这个方向移动。',
          responseContractId: contractId,
        },
      },
    ],
    terminalAction: { callId: 'call-3', name: 'ask_student' },
    provenance: {
      adapter: 'openai-compatible',
      adapterVersion: 'agent-adapter.v1',
    },
  });
  session = appendSessionEvent(session, {
    ...answerEvent('answer-agent-1', 'agent-attempt-1'),
    occurredAt: '2026-07-23T12:00:04.000Z',
    responseToAgentTurnId: 'agent-turn-1',
    responseContractId: contractId,
  });
  const answer = session.events.at(-1)!;
  session = appendSessionEvent(session, {
    id: 'agent-judgment-1',
    occurredAt: '2026-07-23T12:00:05.000Z',
    kind: 'agent.judgment.recorded',
    pipelineStage: 'agent',
    caseId: assessment.caseId,
    stageId: assessment.stageId,
    attemptId: 'agent-attempt-1',
    turnId: 'agent-turn-1',
    nodeId: assessment.nodeId,
    verdict: 'miss',
    rationale: 'The explanation reverses the causal direction.',
    basisThroughSequence: answer.sequence,
    basisEventIds: [assessment.id, answer.id],
    provenance: {
      adapter: 'openai-compatible',
      adapterVersion: 'agent-adapter.v1',
    },
  });
  session = appendSessionEvent(session, {
    id: 'agent-divergence-1',
    occurredAt: '2026-07-23T12:00:06.000Z',
    kind: 'agent.divergence.changed',
    pipelineStage: 'agent',
    caseId: assessment.caseId,
    stageId: assessment.stageId,
    attemptId: 'agent-attempt-1',
    judgmentEventId: 'agent-judgment-1',
    shadowAssessmentEventId: assessment.id,
    agentVerdict: 'miss',
    shadowVerdict: 'hit',
    status: 'detected',
    comparisonPolicyVersion: 'agent-shadow-comparison.v1',
  });
  return session;
}

describe('M6 session.v2 frozen event contracts', () => {
  it('round-trips all three agent events and the bound answer fields through the audit export', () => {
    let baseline = appendSessionEvent(staticSession(), answerEvent());
    baseline = appendSessionEvent(baseline, assessmentEvent());
    const assessment = baseline.events[1] as AssessmentCompletedEvent;
    const session = appendAgentAuditEvents(baseline, assessment);

    const restored = importSession(exportSession(session, { projection: 'teacher-audit' }));

    expect(restored).toEqual(session);
    expect(restored).toMatchObject({
      agentContractRevision: AGENT_CONTRACT_REVISION,
      toolsetDigest: AGENT_TOOLSET_DIGEST,
      contextBuilderVersion: AGENT_CONTEXT_BUILDER_VERSION,
    });
    expect(restored.events.map((event) => event.kind)).toEqual([
      'answer.submitted',
      'assessment.completed',
      'agent.turn.completed',
      'answer.submitted',
      'agent.judgment.recorded',
      'agent.divergence.changed',
    ]);
    expect(restored.events[3]).toMatchObject({
      responseToAgentTurnId: 'agent-turn-1',
      responseContractId: 'response-contract-1',
    });
  });

  it('validates by kind instead of treating every non-answer event as an assessment', () => {
    let session = appendSessionEvent(staticSession(), answerEvent());
    session = appendSessionEvent(session, assessmentEvent());

    expect(() => appendSessionEvent(session, {
      id: 'agent-turn-without-source-answer',
      occurredAt: '2026-07-23T12:00:03.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'agent-attempt',
      turnId: 'turn-without-source-answer',
      triggerEventId: 'assessment-1',
      contextThroughSequence: 1,
      requestHash: `sha256:${'b'.repeat(64)}`,
      source: 'provider',
      model: 'model',
      orderedActions: [{
        callId: 'end-1',
        name: 'end_session',
        arguments: { summary: '本次训练结束。' },
      }],
      terminalAction: { callId: 'end-1', name: 'end_session' },
      provenance: { adapter: 'claude-agent', adapterVersion: 'agent-adapter.v1' },
    })).not.toThrow();

    const invalidAssessment = {
      ...assessmentEvent({ id: 'orphan-assessment' }),
      schemaVersion: 'event.v2',
      sequence: 0,
    };
    expect(sessionSchema.safeParse({
      ...staticSession(),
      events: [invalidAssessment],
    }).success).toBe(false);
  });

  it('rejects hidden prompt, thinking, raw profile, and timing payloads from agent events', () => {
    let session = appendSessionEvent(staticSession(), answerEvent());
    session = appendSessionEvent(session, assessmentEvent());
    const validTurn = {
      id: 'agent-turn-event',
      schemaVersion: 'event.v2',
      sequence: 2,
      occurredAt: '2026-07-23T12:00:03.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'agent-attempt',
      turnId: 'agent-turn',
      triggerEventId: 'assessment-1',
      contextThroughSequence: 1,
      requestHash: `sha256:${'c'.repeat(64)}`,
      source: 'provider',
      model: 'model',
      orderedActions: [{
        callId: 'end-1',
        name: 'end_session',
        arguments: { summary: '结束。' },
      }],
      terminalAction: { callId: 'end-1', name: 'end_session' },
      provenance: { adapter: 'openai-compatible', adapterVersion: 'agent-adapter.v1' },
    };

    for (const leaked of [
      { systemPrompt: 'secret' },
      { thinking: 'private chain of thought' },
      { getProfileResult: { raw: true } },
      { activeElapsedMs: 123 },
      { providerStartedAt: '2026-07-23T12:00:02.000Z' },
    ]) {
      expect(sessionSchema.safeParse({
        ...session,
        events: [...session.events, { ...validTurn, ...leaked }],
      }).success).toBe(false);
    }
  });

  it('excludes agent events from assessment pipeline monotonicity while preserving regressions', () => {
    let session = appendSessionEvent(staticSession(), answerEvent());
    session = appendSessionEvent(session, assessmentEvent({
      id: 'assessment-extraction',
      pipelineStage: 'extraction',
      ruleDecision: { status: 'unassessed', reason: 'pending rule' },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    }));
    session = appendSessionEvent(session, {
      id: 'agent-turn-between-stages',
      occurredAt: '2026-07-23T12:00:03.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'attempt-1',
      turnId: 'turn-between-stages',
      triggerEventId: 'assessment-extraction',
      contextThroughSequence: 1,
      requestHash: `sha256:${'d'.repeat(64)}`,
      source: 'provider',
      model: 'model',
      orderedActions: [{
        callId: 'ask-1',
        name: 'ask_student',
        arguments: { text: '继续。', responseContractId: 'contract-between-stages' },
      }],
      terminalAction: { callId: 'ask-1', name: 'ask_student' },
      provenance: { adapter: 'openai-compatible', adapterVersion: 'agent-adapter.v1' },
    });
    session = appendSessionEvent(session, assessmentEvent({
      id: 'assessment-score',
      occurredAt: '2026-07-23T12:00:04.000Z',
    }));

    expect(session.events).toHaveLength(4);
    expect(() => appendSessionEvent(session, assessmentEvent({
      id: 'assessment-regression',
      occurredAt: '2026-07-23T12:00:05.000Z',
      pipelineStage: 'rule',
      ruleDecision: {
        status: 'hit',
        ruleId: 'p4-hit',
        reason: 'late rule snapshot',
        engine: { id: 'fixture', version: 'fixture.v1' },
      },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    }))).toThrow(/progress/i);
  });
});

describe('M6 ResponseContract registry', () => {
  it('derives every grading entrypoint from server-owned configuration', async () => {
    const config = await loadAllConfig(process.cwd());
    let id = 0;
    const registry = new ResponseContractRegistry({
      idFactory: () => `derived-contract-${++id}`,
    });
    const choice = config.pretest.questions.find((entry) => entry.type === 'choice')!;
    const text = config.pretest.questions.find((entry) => entry.type === 'text')!;
    const trainingCase = config.cases[0]!;
    const equationSet = trainingCase.equationSets[0]!;
    const common = {
      sessionId: 'derived-contract-session',
      createdThroughSequence: 0,
    };

    expect(registry.issueQuestion({
      ...common,
      agentTurnId: 'derived-contract-choice',
      questionId: choice.id,
      caseId: 'pretest',
    }, config).assessmentEntrypoint).toEqual({
      kind: 'choice',
      route: '/api/assessment/choice',
    });
    expect(registry.issueQuestion({
      ...common,
      agentTurnId: 'derived-contract-text',
      questionId: text.id,
      caseId: 'pretest',
    }, config).assessmentEntrypoint).toEqual({
      kind: 'text-extraction',
      route: '/api/assessment/extract',
    });
    expect(registry.issueQuestion({
      ...common,
      agentTurnId: 'derived-contract-builder',
      questionId: 'pretest-builder',
      caseId: 'pretest',
    }, config).assessmentEntrypoint).toEqual({
      kind: 'builder',
      handler: 'recordBuilderAssessment',
    });
    expect(registry.issueQuestion({
      ...common,
      agentTurnId: 'derived-contract-analysis',
      questionId: `${trainingCase.id}:analysis`,
      caseId: trainingCase.id,
    }, config).assessmentEntrypoint).toEqual({
      kind: 'text-extraction',
      route: '/api/assessment/extract',
    });
    expect(registry.issueQuestion({
      ...common,
      agentTurnId: 'derived-contract-equation',
      questionId: `${trainingCase.id}:${equationSet.id}`,
      caseId: trainingCase.id,
    }, config).assessmentEntrypoint).toEqual({
      kind: 'equation',
      route: '/api/assessment/equation',
      equationSetId: equationSet.id,
    });
  });

  it('server-generates, stores, and validates a configured assessed response binding', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) => entry.type === 'choice')!;
    const registry = new ResponseContractRegistry({
      idFactory: () => 'server-response-contract-1',
    });
    let session = createSession({
      id: 'response-contract-session',
      anonymousStudentId: 'anon-CONTRACT1',
      now: '2026-07-23T13:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    session = appendSessionEvent(session, {
      ...answerEvent('response-trigger', 'response-trigger-attempt'),
      caseId: 'pretest',
      stageId: 'assessment',
      questionId: question.id,
    });
    const contract = registry.issueQuestion({
      sessionId: session.id,
      agentTurnId: 'response-turn-1',
      questionId: question.id,
      caseId: 'pretest',
      createdThroughSequence: 0,
    }, config);
    session = appendSessionEvent(session, {
      id: 'response-turn-event',
      occurredAt: '2026-07-23T13:00:01.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'response-attempt',
      turnId: 'response-turn-1',
      triggerEventId: 'response-trigger',
      contextThroughSequence: 0,
      requestHash: `sha256:${'e'.repeat(64)}`,
      source: 'provider',
      model: 'model',
      orderedActions: [{
        callId: 'present-question-1',
        name: 'present_question',
        arguments: {
          questionId: question.id,
          responseContractId: contract.responseContractId,
        },
      }],
      terminalAction: { callId: 'present-question-1', name: 'present_question' },
      provenance: { adapter: 'openai-compatible', adapterVersion: 'agent-adapter.v1' },
    });

    expect(contract).toMatchObject({
      responseContractId: 'server-response-contract-1',
      sessionId: session.id,
      agentTurnId: 'response-turn-1',
      questionId: question.id,
      caseId: 'pretest',
      targetNodeIds: question.targetNodeIds,
      assessmentEntrypoint: {
        kind: 'choice',
        route: '/api/assessment/choice',
      },
    });
    expect(registry.get(session.id, contract.responseContractId)).toEqual(contract);
    expect(() => registry.issueUnassessed({
      sessionId: session.id,
      agentTurnId: 'response-turn-1',
      caseId: 'pretest',
      createdThroughSequence: 0,
      reason: 'conversation-only',
    })).toThrow(ResponseContractBindingError);
    expect(registry.resolveSubmission({
      session,
      agentTurnId: 'response-turn-1',
    })).toEqual({ status: 'assessed', contract });
    expect(() => registry.resolveSubmission({
      session,
      agentTurnId: 'different-turn',
    })).toThrow(ResponseContractBindingError);
    expect(agentAnswerSubmissionSchema.safeParse({
      turnId: 'response-turn-1',
      answer: { format: 'text', value: '学生作答' },
    }).success).toBe(true);
    expect(agentAnswerSubmissionSchema.safeParse({
      turnId: 'response-turn-1',
      responseContractId: contract.responseContractId,
      questionId: question.id,
      answer: { format: 'text', value: '学生作答' },
    }).success).toBe(false);
  });

  it('models conversation-only replies as explicitly unassessed', () => {
    const registry = new ResponseContractRegistry({
      idFactory: () => 'server-response-contract-unassessed',
    });
    const contract = registry.issueUnassessed({
      sessionId: 'unassessed-session',
      agentTurnId: 'unassessed-turn',
      caseId: null,
      createdThroughSequence: 0,
      reason: 'conversation-only',
    });

    expect(contract).toMatchObject({
      questionId: null,
      caseId: null,
      targetNodeIds: [],
      assessmentEntrypoint: {
        kind: 'unassessed',
        reason: 'conversation-only',
      },
    });
    expect(responseContractSchema.safeParse({
      ...contract,
      targetNodeIds: ['P4'],
    }).success).toBe(false);
  });
});

describe('M6 projection and scoring immunity boundaries', () => {
  it('keeps audit events for teachers while filtering them and internal actions for students', () => {
    let baseline = appendSessionEvent(staticSession(), answerEvent());
    baseline = appendSessionEvent(baseline, assessmentEvent());
    const full = appendAgentAuditEvents(baseline, baseline.events[1] as AssessmentCompletedEvent);

    const student = projectStudentSession(full);
    const audit = projectTeacherAuditSession(full);

    expect(student.events.map((event) => event.kind)).toEqual([
      'answer.submitted',
      'assessment.completed',
      'agent.turn.completed',
      'answer.submitted',
    ]);
    const studentTurn = student.events.find((event) => event.kind === 'agent.turn.completed');
    expect(studentTurn?.orderedActions.map((action) => action.name)).toEqual(['ask_student']);
    expect(audit).toEqual(full);
    expect(projectStudentSession(importSession(exportSession(full))).events)
      .toEqual(student.events);
    expect(importSession(exportSession(full, { projection: 'teacher-audit' }))).toEqual(full);
  });

  it('uses event-specific student DTO allowlists and reveals polarity only after a hit', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    const answer = '锌极为负极，铜极为正极。';
    let session = createSession({
      id: 'm6-student-whitelist',
      anonymousStudentId: 'anon-WHITELST',
      now: '2026-07-23T13:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    session = appendSessionEvent(session, {
      id: 'polarity-answer',
      occurredAt: '2026-07-23T13:00:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'polarity-attempt',
      questionId: `${trainingCase.id}:analysis`,
      answer: { format: 'text', value: answer },
    });
    session = appendSessionEvent(session, assessmentEvent({
      id: 'public-assessment',
      occurredAt: '2026-07-23T13:00:02.000Z',
      sourceAnswerEventId: 'polarity-answer',
      attemptId: 'polarity-attempt',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      objectiveOutcome: 'hit',
      extraction: {
        status: 'assessed',
        evidence: [{ quote: answer, start: 0, end: answer.length }],
        model: 'private-model',
        provenance: {
          promptId: 'private-prompt',
          promptVersion: 'private-prompt.v1',
          cacheKey: 'private-cache-key',
        },
      },
      ruleDecision: {
        status: 'hit',
        ruleId: 'p4-hit',
        reason: 'private rule explanation',
        engine: { id: 'private-engine', version: 'private-engine.v1' },
      },
    }));
    session = appendSessionEvent(session, {
      id: 'polarity-assessment',
      occurredAt: '2026-07-23T13:00:02.000Z',
      kind: 'polarity.assessed',
      pipelineStage: 'rule',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'polarity-attempt',
      sourceAnswerEventId: 'polarity-answer',
      anchorId: 'case-polarity',
      facts: [
        {
          id: 'negative',
          value: 'Zn',
          evidence: { quote: '锌', start: 0, end: 1 },
        },
        {
          id: 'positive',
          value: 'Cu',
          evidence: { quote: '铜', start: 6, end: 7 },
        },
      ],
      extractedValue: 'negative=Zn;positive=Cu',
      correctValue: 'negative=Zn;positive=Cu',
      outcome: 'hit',
      evidence: [{ quote: answer, start: 0, end: answer.length }],
      engine: { id: 'fixture', version: 'fixture.v1' },
    });
    // Red-before-green: correctValue used to be the UI reveal channel and leaked in projection.
    session = appendSessionEvent(session, {
      id: 'polarity-reveal',
      occurredAt: '2026-07-23T13:00:02.000Z',
      kind: 'polarity.revealed',
      pipelineStage: 'reveal',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'polarity-attempt',
      sourcePolarityAssessmentEventId: 'polarity-assessment',
      anchorId: 'case-polarity',
      values: { negative: 'Zn', positive: 'Cu' },
    });

    const student = projectStudentSession(session);
    const leakedPaths: string[] = [];
    const walk = (value: unknown, path: string[] = []) => {
      if (!value || typeof value !== 'object') return;
      Object.entries(value).forEach(([key, entry]) => {
        if (['correctValue', 'engine', 'provenance'].includes(key)) {
          leakedPaths.push([...path, key].join('.'));
        }
        walk(entry, [...path, key]);
      });
    };
    walk(student);
    walk(JSON.parse(exportSession(session)));

    expect(leakedPaths).toEqual([]);
    const publicAssessment = student.events.find((event) =>
      event.kind === 'assessment.completed');
    expect(publicAssessment).toMatchObject({
      extraction: {
        status: 'assessed',
        evidence: [{ quote: answer, start: 0, end: answer.length }],
      },
      ruleDecision: { status: 'hit' },
      score: { status: 'scored', earned: 2, possible: 2 },
    });
    expect(publicAssessment?.ruleDecision).not.toHaveProperty('reason');
    expect(student.events.find((event) => event.kind === 'polarity.assessed'))
      .not.toHaveProperty('correctValue');
    expect(student.events.find((event) => event.kind === 'polarity.revealed'))
      .toMatchObject({ values: { negative: 'Zn', positive: 'Cu' } });
    expect(buildLiveCellState(session, config, trainingCase)).toMatchObject({
      polarityLit: true,
      electrodes: {
        negative: { token: 'Zn', label: '锌' },
        positive: { token: 'Cu', label: '铜' },
      },
    });
  });

  it('makes agent events inert for learner profiles, model lights, live lights, dimensions, and teacher scoring', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    let baseline = createSession({
      id: 'm6-immunity-session',
      anonymousStudentId: 'anon-IMMUNITY1',
      now: '2026-07-23T14:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const answer = '电子从负极流向正极。';
    baseline = appendSessionEvent(baseline, {
      id: 'immunity-answer',
      occurredAt: '2026-07-23T14:00:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'immunity-attempt',
      questionId: `${trainingCase.id}:analysis`,
      answer: { format: 'text', value: answer },
    });
    const rubric = config.rubrics.rubrics.find((entry) => entry.nodeId === 'P4')!;
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      scaffoldPolicy: config.scaffoldPolicy,
      nodeId: 'P4',
      objectiveOutcome: 'hit',
      assistance: { kind: 'none', rounds: 0 },
      engine: {
        id: 'm6-immunity',
        version: 'm6-immunity.v1',
        ruleId: 'm6-immunity-hit',
        reason: 'fixture hit',
      },
    });
    baseline = appendSessionEvent(baseline, {
      id: 'immunity-assessment',
      occurredAt: '2026-07-23T14:00:02.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'immunity-attempt',
      sourceAnswerEventId: 'immunity-answer',
      nodeId: 'P4',
      rubric: { id: rubric.id, version: config.rubrics.version },
      objectiveOutcome: 'hit',
      extraction: {
        status: 'assessed',
        evidence: [{ quote: answer, start: 0, end: answer.length }],
        model: 'm6-immunity',
        provenance: {
          promptId: 'm6-immunity',
          promptVersion: 'm6-immunity.v1',
          cacheKey: 'm6-immunity:P4',
        },
      },
      ...decision,
    });
    const full = appendAgentAuditEvents(
      baseline,
      baseline.events[1] as AssessmentCompletedEvent,
    );

    expect(buildLearnerProfile(full, config)).toEqual(buildLearnerProfile(baseline, config));
    expect(buildModelScene(full, config)).toEqual(buildModelScene(baseline, config));
    expect(buildLiveCellState(full, config, trainingCase))
      .toEqual(buildLiveCellState(baseline, config, trainingCase));
    expect(buildTeacherStudentReport(full, config).profile)
      .toEqual(buildTeacherStudentReport(baseline, config).profile);

    const imported = importClassSessionFiles([{
      name: 'm6-audit.json',
      text: exportSession(full, { projection: 'teacher-audit' }),
    }], config);
    expect(imported.rejected).toEqual([]);
    expect(imported.accepted[0]?.session).toEqual(full);
  });

  it('selects the record-track shadow assessment at the judgment basis and normalizes help', async () => {
    const config = await loadAllConfig(process.cwd());
    let session = createSession({
      id: 'm6-shadow-selection',
      anonymousStudentId: 'anon-SHADOW01',
      now: '2026-07-23T14:30:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const answer = '电子从负极流向正极。';
    session = appendSessionEvent(session, {
      id: 'shadow-answer',
      occurredAt: '2026-07-23T14:30:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'shadow-attempt',
      questionId: 'zinc-copper:analysis',
      answer: { format: 'text', value: answer },
    });
    const rubric = config.rubrics.rubrics.find((entry) => entry.nodeId === 'P4')!;
    const helped = resolveRubricDecision({
      rubrics: config.rubrics,
      scaffoldPolicy: config.scaffoldPolicy,
      nodeId: 'P4',
      objectiveOutcome: 'hit',
      assistance: { kind: 'socratic', rounds: 1 },
      engine: {
        id: 'shadow-fixture',
        version: 'shadow-fixture.v1',
        ruleId: 'shadow-hit',
        reason: 'hit with help',
      },
    });
    session = appendSessionEvent(session, {
      id: 'shadow-assessment',
      occurredAt: '2026-07-23T14:30:02.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'shadow-attempt',
      sourceAnswerEventId: 'shadow-answer',
      nodeId: 'P4',
      rubric: { id: rubric.id, version: config.rubrics.version },
      objectiveOutcome: 'hit',
      extraction: {
        status: 'assessed',
        evidence: [{ quote: answer, start: 0, end: answer.length }],
        model: 'shadow-fixture',
        provenance: {
          promptId: 'shadow-fixture',
          promptVersion: 'shadow-fixture.v1',
          cacheKey: 'shadow-fixture:P4',
        },
      },
      ...helped,
    });

    expect(selectShadowAssessmentAtBasis(session, config, 'P4', 1)).toEqual({
      status: 'comparable',
      assessmentEventId: 'shadow-assessment',
      verdict: 'hit',
      comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
    });
    expect(selectShadowAssessmentAtBasis(session, config, 'E1', 1)).toEqual({
      status: 'incomparable',
      reason: 'unassessed',
      comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
    });
  });

  it('does not fall back to an old score when the latest basis attempt needs review', async () => {
    const config = await loadAllConfig(process.cwd());
    let session = createSession({
      id: 'm6-shadow-latest-status',
      anonymousStudentId: 'anon-SHADOW02',
      now: '2026-07-23T14:40:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    session = appendSessionEvent(session, answerEvent('shadow-old-answer', 'shadow-old'));
    session = appendSessionEvent(session, assessmentEvent({
      id: 'shadow-old-hit',
      sourceAnswerEventId: 'shadow-old-answer',
      attemptId: 'shadow-old',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
    }));
    session = appendSessionEvent(session, {
      ...answerEvent('shadow-review-answer', 'shadow-review'),
      occurredAt: '2026-07-23T14:40:03.000Z',
    });
    session = appendSessionEvent(session, assessmentEvent({
      id: 'shadow-latest-review',
      occurredAt: '2026-07-23T14:40:04.000Z',
      sourceAnswerEventId: 'shadow-review-answer',
      attemptId: 'shadow-review',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      pipelineStage: 'extraction',
      extraction: {
        status: 'needs-review',
        reason: 'ambiguous evidence',
        model: 'fixture',
        provenance: {
          promptId: 'fixture',
          promptVersion: 'fixture.v1',
          cacheKey: 'fixture:review',
        },
      },
      ruleDecision: { status: 'unassessed', reason: 'awaiting review' },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    }));

    // Red-before-green: record-track selection used to fall back to shadow-old-hit.
    expect(selectShadowAssessmentAtBasis(session, config, 'P4', 3)).toEqual({
      status: 'incomparable',
      reason: 'needs-review',
      comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
    });

    session = appendSessionEvent(session, {
      id: 'latest-status-turn-event',
      occurredAt: '2026-07-23T14:40:05.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'latest-status-agent',
      turnId: 'latest-status-turn',
      triggerEventId: 'shadow-latest-review',
      contextThroughSequence: 3,
      requestHash: `sha256:${'9'.repeat(64)}`,
      source: 'provider',
      model: 'fixture',
      orderedActions: [
        {
          callId: 'latest-status-judge',
          name: 'conclude_node',
          arguments: {
            nodeId: 'P4',
            verdict: 'miss',
            rationale: 'Current evidence is not sufficient.',
          },
        },
        {
          callId: 'latest-status-end',
          name: 'end_session',
          arguments: { summary: '本轮结束。' },
        },
      ],
      terminalAction: { callId: 'latest-status-end', name: 'end_session' },
      provenance: {
        adapter: 'openai-compatible',
        adapterVersion: 'fixture.v1',
      },
    });
    session = appendSessionEvent(session, {
      id: 'latest-status-judgment',
      occurredAt: '2026-07-23T14:40:06.000Z',
      kind: 'agent.judgment.recorded',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'latest-status-agent',
      turnId: 'latest-status-turn',
      nodeId: 'P4',
      verdict: 'miss',
      rationale: 'Current evidence is not sufficient.',
      basisThroughSequence: 3,
      basisEventIds: ['shadow-latest-review'],
      provenance: {
        adapter: 'openai-compatible',
        adapterVersion: 'fixture.v1',
      },
    });
    expect(() => appendSessionEvent(session, {
      id: 'stale-shadow-divergence',
      occurredAt: '2026-07-23T14:40:07.000Z',
      kind: 'agent.divergence.changed',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'latest-status-agent',
      judgmentEventId: 'latest-status-judgment',
      shadowAssessmentEventId: 'shadow-old-hit',
      agentVerdict: 'miss',
      shadowVerdict: 'hit',
      status: 'detected',
      comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
    })).toThrow(/basis-selected|latest attempt/i);
  });
});
