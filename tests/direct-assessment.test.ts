import { readdir } from 'node:fs/promises';
import path from 'node:path';

import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import { ResponseContractRegistry } from '../server/agent/response-contracts';
import {
  ExistingDirectPrimaryAssessment,
  submitAgentAnswer,
} from '../server/agent/shadow-assessment';
import { loadAllConfig } from '../server/config/loader';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMProvider } from '../server/llm/types';
import { loadPrompt } from '../server/prompts/loader';
import {
  assembleDirectAssessmentInput,
  runDirectAssessment,
} from '../server/workflows/direct-assessment';
import { projectStudentSession } from '../shared/session/projections';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../shared/session/session';
import { appendAssessmentAudit } from '../shared/workflows/assessment-audit';
import { recordChoiceAssessment } from '../shared/workflows/choice-assessment';
import {
  createClosedDirectAssessmentSchema,
  type DirectAssessmentResponse,
  recordDirectAssessment,
} from '../shared/workflows/direct-assessment';
import { buildTeacherStudentReport } from '../src/features/teacher/teacher-data';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

function directResponse(
  answer: string,
  nodeIds: readonly string[],
  verdicts: readonly ('hit' | 'partial' | 'miss' | 'needs-review')[],
  confidence = 0.95,
): DirectAssessmentResponse {
  return {
    assessments: nodeIds.map((nodeId, index) => ({
      nodeId,
      verdict: verdicts[index] ?? verdicts[0],
      misconceptionIds: [],
      rationale: `${nodeId} direct rationale`,
      confidence,
      reviewReason: verdicts[index] === 'needs-review' ? 'rubric-boundary' : null,
      evidence: [{ quote: answer, start: 0, end: answer.length }],
    })),
  };
}

describe('direct pretest assessment', () => {
  it('assembles server-owned question context, rubrics, scope, and examples', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam4-material');
    if (!question?.directAssessment) throw new Error('missing direct question');
    const scopedQuestion = {
      ...question,
      directAssessment: question.directAssessment,
    };

    const input = assembleDirectAssessmentInput({
      config,
      question: scopedQuestion,
      answer: '纳米CuO',
      selectedOptionId: 'A',
      voteIndex: 2,
      assistance: { kind: 'none', rounds: 0 },
    });

    expect(input).toMatchObject({
      voteIndex: 2,
      answer: '纳米CuO',
      question: {
        id: question.id,
        selectedOptionId: 'A',
      },
      scope: {
        version: question.directAssessment.version,
        lowConfidenceThreshold: 0.75,
      },
      scoringSource: {
        correctOptions: [{ id: 'A', text: expect.stringContaining('CuO') }],
      },
    });
    expect(input.nodes.map((node) => node.id)).toEqual(question.targetNodeIds);
    expect(input.rubrics.map((rubric) => rubric.nodeId)).toEqual(question.targetNodeIds);
    expect(input.scope.examples).toHaveLength(2);
    expect(input.assistance).toEqual({ kind: 'none', rounds: 0 });

    const ajv = new Ajv({ strict: false });
    for (const directQuestion of config.pretest.questions) {
      if (!directQuestion.directAssessment) continue;
      const directAssessment = directQuestion.directAssessment;
      expect(() => ajv.compile(createClosedDirectAssessmentSchema({
        config,
        question: {
          ...directQuestion,
          directAssessment,
        },
      }))).not.toThrow();
    }
  });

  it('runs three independent cached votes and records a two-vote majority', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const prompt = await loadPrompt(root, 'direct-assessment');
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam4-material');
    if (!prompt || !question?.directAssessment) throw new Error('missing direct fixture');
    const scopedQuestion = {
      ...question,
      directAssessment: question.directAssessment,
    };
    const answer = '纳米CuO';
    const provider: LLMProvider = {
      id: 'direct-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const voteIndex = (request.input as { voteIndex: number }).voteIndex;
        const value = directResponse(
          answer,
          question.targetNodeIds,
          [voteIndex === 3 ? 'miss' : 'hit'],
        );
        return {
          content: JSON.stringify(value),
          structured: value,
          model: 'direct-v1',
        };
      },
    };
    const recordings = new RecordingStore(root);
    const service = new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    const result = await runDirectAssessment({
      service,
      config,
      prompt,
      question: scopedQuestion,
      answer,
      selectedOptionId: 'A',
      assistance: { kind: 'none', rounds: 0 },
      executionMode: 'development',
      provider: provider.id,
      model: 'direct-v1',
    });

    expect(result.assessments).toEqual([
      expect.objectContaining({ nodeId: 'D5', verdict: 'hit', agreeingVotes: 2 }),
      expect.objectContaining({ nodeId: 'D1', verdict: 'hit', agreeingVotes: 2 }),
    ]);
    expect(result.cacheKeys).toHaveLength(3);
    expect(new Set(result.cacheKeys).size).toBe(3);
    await expect(readdir(path.join(root, 'recordings', 'cache')))
      .resolves.toHaveLength(3);

    const published = await recordings.publishDirectAssessmentDemoRecordings(result.cacheKeys);
    expect(published.cacheKeys).toEqual(result.cacheKeys);
    await recordings.validateDemoAssets({
      configVersion: config.configVersion,
      prompts: { [prompt.id]: prompt },
    });
    const replay = await runDirectAssessment({
      service: new LLMService({
        providers: new Map(),
        recordings,
        logger: { error: vi.fn(), warn: vi.fn() },
      }),
      config,
      prompt,
      question: scopedQuestion,
      answer,
      selectedOptionId: 'A',
      assistance: { kind: 'none', rounds: 0 },
      executionMode: 'demo',
      provider: provider.id,
      model: 'direct-v1',
    });
    expect(replay.assessments).toEqual(result.assessments);
    expect(replay.source).toBe('demo-recording');
  });

  it('turns a three-way verdict split into teacher review instead of forcing a score', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const prompt = await loadPrompt(root, 'direct-assessment');
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam4-cathode-equation');
    if (!prompt || !question?.directAssessment) throw new Error('missing direct fixture');
    const scopedQuestion = {
      ...question,
      directAssessment: question.directAssessment,
    };
    const answer = 'O₂+H₂O+2e⁻=OH⁻';
    const verdicts = ['hit', 'partial', 'miss'] as const;
    const provider: LLMProvider = {
      id: 'split-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const voteIndex = (request.input as { voteIndex: number }).voteIndex;
        const value = directResponse(
          answer,
          question.targetNodeIds,
          [verdicts[voteIndex - 1]!],
        );
        return { content: JSON.stringify(value), structured: value, model: 'split-v1' };
      },
    };
    const result = await runDirectAssessment({
      service: new LLMService({
        providers: new Map([[provider.id, provider]]),
        recordings: new RecordingStore(root),
        logger: { error: vi.fn(), warn: vi.fn() },
      }),
      config,
      prompt,
      question: scopedQuestion,
      answer,
      assistance: { kind: 'none', rounds: 0 },
      executionMode: 'live',
      provider: provider.id,
      model: 'split-v1',
    });

    expect(result.assessments[0]).toMatchObject({
      verdict: 'needs-review',
      reviewReason: 'no-majority',
      agreeingVotes: 1,
    });
  });

  it('rejects oversized answers before any direct provider vote', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const prompt = await loadPrompt(root, 'direct-assessment');
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam4-process');
    if (!prompt || !question?.directAssessment) throw new Error('missing direct fixture');
    const provider = {
      id: 'unused-direct-provider',
      chat: vi.fn(),
      vision: vi.fn(),
      structured: vi.fn(),
    } satisfies LLMProvider;

    await expect(runDirectAssessment({
      service: new LLMService({
        providers: new Map([[provider.id, provider]]),
        recordings: new RecordingStore(root),
      }),
      config,
      prompt,
      question: { ...question, directAssessment: question.directAssessment },
      answer: 'x'.repeat(
        config.scaffoldPolicy.extraction.maximumAnswerCharacters + 1,
      ),
      assistance: { kind: 'none', rounds: 0 },
      executionMode: 'live',
      provider: provider.id,
      model: 'unused-v1',
    })).rejects.toMatchObject({
      category: 'answer-too-long',
      retryable: false,
    });
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it('keeps direct judgment on the record track and hides audit/divergence from students', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam4-material');
    if (!question || question.type !== 'choice' || !question.directAssessment) {
      throw new Error('missing direct question');
    }
    const scopedQuestion = {
      ...question,
      directAssessment: question.directAssessment,
    };
    const now = '2026-07-24T00:00:00.000Z';
    const base = createSession({
      id: 'direct-audit-session',
      anonymousStudentId: 'anon-DIRECT01',
      now,
      configVersions: sessionConfigVersions(config),
    });
    const answer = '纳米CuO';
    const direct = recordDirectAssessment({
      session: base,
      config,
      question: scopedQuestion,
      answer: {
        id: 'direct-answer',
        occurredAt: now,
        caseId: 'pretest',
        stageId: 'assessment',
        attemptId: 'direct-attempt',
        questionId: question.id,
        value: answer,
      },
      assessments: question.targetNodeIds.map((nodeId) => ({
        ...directResponse(answer, [nodeId], ['hit']).assessments[0]!,
        agreeingVotes: 3 as const,
      })),
      provenance: {
        promptId: 'direct-assessment',
        promptVersion: 'direct-assessment.v1',
        cacheKey: `sha256:${'a'.repeat(64)}`,
        model: 'direct-v1',
      },
      assessmentEventIdPrefix: 'direct-assessment',
      assessedAt: now,
    }).session;
    let auditId = 0;
    const auditSource = recordChoiceAssessment({
      session: createSession({
        id: base.id,
        anonymousStudentId: base.anonymousStudentId,
        now,
        configVersions: base.configVersions,
      }),
      config,
      question,
      optionId: 'B',
      rawAnswer: answer,
      occurredAt: now,
      attemptId: 'direct-attempt',
      idFactory: (prefix) => `${prefix}-audit-${auditId++}`,
    }).session;
    const audited = appendAssessmentAudit({
      session: direct,
      auditSession: auditSource,
      sourceAnswerEventId: 'direct-answer',
      questionId: question.id,
      targetNodeIds: question.targetNodeIds,
      eventIdPrefix: 'audit',
      occurredAt: now,
    });
    const student = projectStudentSession(audited);
    const teacher = buildTeacherStudentReport(audited, config);

    expect(audited.events.filter((event) =>
      event.kind === 'assessment.audit.completed')).toHaveLength(2);
    expect(audited.events.filter((event) =>
      event.kind === 'assessment.divergence.changed')).toHaveLength(2);
    expect(audited.events.slice(-4).map((event) => event.kind)).toEqual([
      'assessment.audit.completed',
      'assessment.audit.completed',
      'assessment.divergence.changed',
      'assessment.divergence.changed',
    ]);
    expect(student.events.map((event) => event.kind))
      .not.toContain('assessment.audit.completed');
    expect(student.events.map((event) => event.kind))
      .not.toContain('assessment.divergence.changed');
    expect(student.events.filter((event) => event.kind === 'assessment.completed'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleDecision: expect.objectContaining({ status: 'hit' }) }),
      ]));
    expect(teacher.agentAudit.divergences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'assessment',
        questionId: question.id,
        originalAnswer: answer,
        primaryConfidence: 0.95,
        auditEngine: expect.objectContaining({ id: 'configured-choice' }),
      }),
    ]));
    expect(teacher.needsReview).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'divergence',
        source: 'assessment',
        nodeId: 'D5',
      }),
    ]));

    const duplicateSource = auditSource.events.find((event) =>
      event.kind === 'assessment.completed' && event.nodeId === 'D5');
    if (!duplicateSource || duplicateSource.kind !== 'assessment.completed') {
      throw new Error('missing duplicate audit fixture');
    }
    const {
      schemaVersion: _schemaVersion,
      sequence: _sequence,
      ...duplicateInput
    } = duplicateSource;
    const conflictingAuditSource = appendSessionEvent(auditSource, {
      ...duplicateInput,
      id: 'duplicate-audit-D5',
    });
    const conflicted = appendAssessmentAudit({
      session: direct,
      auditSession: conflictingAuditSource,
      sourceAnswerEventId: 'direct-answer',
      questionId: question.id,
      targetNodeIds: question.targetNodeIds,
      eventIdPrefix: 'conflicted-audit',
      occurredAt: now,
    });
    expect(conflicted.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'assessment.audit.completed',
        nodeId: 'D5',
        verdict: 'needs-review',
        rationale: expect.stringContaining('2 results'),
      }),
    ]));
    expect(conflicted.events.some((event) =>
      event.kind === 'assessment.divergence.changed'
      && event.nodeId === 'D5')).toBe(false);
  });

  it('keeps agent response contracts on the same direct-primary and hidden-audit pipeline', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const prompt = await loadPrompt(root, 'direct-assessment');
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam4-material');
    if (!prompt || !question || question.type !== 'choice' || !question.directAssessment) {
      throw new Error('missing direct agent fixture');
    }
    const provider: LLMProvider = {
      id: 'direct-agent-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const input = request.input as {
          answer: string;
          nodes: Array<{ id: string }>;
        };
        const value = directResponse(
          input.answer,
          input.nodes.map((node) => node.id),
          input.nodes.map(() => 'hit'),
        );
        return { content: JSON.stringify(value), structured: value, model: 'direct-agent-v1' };
      },
    };
    const service = new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const registry = new ResponseContractRegistry({
      idFactory: () => 'direct-agent-contract',
    });
    let session = createSession({
      id: 'direct-agent-session',
      anonymousStudentId: 'anon-DIRECT02',
      now: '2026-07-24T00:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    session = appendSessionEvent(session, {
      id: 'direct-agent-trigger',
      occurredAt: '2026-07-24T00:00:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'direct-agent-seed',
      questionId: 'agent-seed',
      answer: { format: 'text', value: 'seed' },
    });
    const contract = registry.issueQuestion({
      sessionId: session.id,
      agentTurnId: 'direct-agent-turn',
      questionId: question.id,
      caseId: 'pretest',
      createdThroughSequence: 0,
    }, config);
    session = appendSessionEvent(session, {
      id: 'direct-agent-turn-event',
      occurredAt: '2026-07-24T00:00:02.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'direct-agent-turn-attempt',
      turnId: 'direct-agent-turn',
      triggerEventId: 'direct-agent-trigger',
      contextThroughSequence: 0,
      requestHash: `sha256:${'b'.repeat(64)}`,
      source: 'provider',
      model: 'direct-agent-v1',
      orderedActions: [{
        callId: 'direct-agent-question',
        name: 'present_question',
        arguments: {
          questionId: question.id,
          responseContractId: contract.responseContractId,
        },
      }],
      terminalAction: { callId: 'direct-agent-question', name: 'present_question' },
      provenance: { adapter: 'openai-compatible', adapterVersion: 'agent-adapter.v1' },
    });
    const directAssessment = new ExistingDirectPrimaryAssessment({
      service,
      directPrompt: prompt,
      textAudit: {
        async assess() {
          throw new Error('choice audit must not use text extraction');
        },
      },
      executionMode: 'live',
      provider: provider.id,
      model: 'direct-agent-v1',
    });

    const submitted = await submitAgentAnswer({
      session,
      config,
      responseContracts: registry,
      submission: {
        turnId: 'direct-agent-turn',
        answer: { format: 'text', value: 'A' },
      },
      occurredAt: '2026-07-24T00:00:03.000Z',
      directAssessment,
    });

    expect(contract.assessmentEntrypoint).toEqual({
      kind: 'direct-choice',
      route: '/api/assessment/choice',
    });
    const linkedAnswer = submitted.session.events.find((event) =>
      event.kind === 'answer.submitted'
      && event.responseToAgentTurnId === 'direct-agent-turn');
    expect(linkedAnswer).toMatchObject({
      answer: { format: 'text', value: 'A' },
      responseContractId: contract.responseContractId,
    });
    expect(submitted.session.events.filter((event) =>
      event.kind === 'assessment.completed'
      && event.sourceAnswerEventId === linkedAnswer?.id)).toHaveLength(2);
    expect(submitted.session.events.filter((event) =>
      event.kind === 'assessment.audit.completed')).toHaveLength(2);
    expect(submitted.session.events.filter((event) =>
      event.kind === 'assessment.divergence.changed')).toHaveLength(2);
    expect(projectStudentSession(submitted.session).events.map((event) => event.kind))
      .not.toContain('assessment.audit.completed');

    const retried = await submitAgentAnswer({
      session: submitted.session,
      config,
      responseContracts: registry,
      submission: {
        turnId: 'direct-agent-turn',
        answer: { format: 'text', value: 'A' },
      },
      occurredAt: '2026-07-24T00:00:04.000Z',
    });
    expect(retried.session.events).toEqual(submitted.session.events);
  });
});
