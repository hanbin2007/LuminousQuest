import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import type { LLMProvider, LLMRequest, LLMResponse } from '../server/llm/types';
import type { AssessmentCompletedEvent, StudentSession } from '../shared/session';
import { projectStudentSession } from '../shared/session/projections';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const apiToken = 'workflow-token';
const headers = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

class TestSessionStore {
  readonly values = new Map<string, StudentSession>();
  get(id: string) { return this.values.get(id); }
  set(session: StudentSession) { this.values.set(session.id, session); }
}

function assessmentResponse(
  answer: string,
  from: 'Zn' | 'Cu',
  to: 'Zn' | 'Cu',
  assistance: { kind: 'none' | 'hint' | 'socratic'; rounds: number } = { kind: 'none', rounds: 0 },
): LLMResponse {
  const evidence = (value: string) => ({
    quote: value,
    start: answer.indexOf(value),
    end: answer.indexOf(value) + value.length,
  });
  const value = {
    anchors: [],
    assessments: [{
      nodeId: 'P4',
      errorIds: from === 'Zn' && to === 'Cu' ? [] : ['P4-M1'],
      facts: {
        response: 'substantive',
        terminology: 'model',
        syllabus: 'within',
        contradiction: false,
        typo: 'none',
        slots: [
          { id: 'electron-from', value: from, evidence: evidence(from) },
          { id: 'electron-to', value: to, evidence: evidence(to) },
          { id: 'anion-toward', value: from, evidence: evidence(from) },
          { id: 'cation-toward', value: to, evidence: evidence(to) },
        ],
      },
      evidence: [{ quote: answer, start: 0, end: answer.length }],
      assistance,
    }],
  };
  return { content: JSON.stringify(value), structured: value, model: 'workflow-v1' };
}

function membraneAssessmentResponse(answer: string): LLMResponse {
  const evidence = (quote: string) => ({
    quote,
    start: answer.indexOf(quote),
    end: answer.indexOf(quote) + quote.length,
  });
  const d3Slots = answer.includes('不能')
    ? [{ id: 'o2-passes', value: 'false', evidence: evidence('不能') }]
    : answer.includes('能')
      ? [{ id: 'o2-passes', value: 'true', evidence: evidence('能') }]
      : [];
  const p1Slots = answer.includes('直接反应')
    ? [{
        id: 'separation-purpose',
        value: 'prevent-direct-reaction',
        evidence: evidence('直接反应'),
      }]
    : [];
  const assessment = (nodeId: 'D3' | 'P1', slots: typeof d3Slots | typeof p1Slots) => ({
    nodeId,
    errorIds: [],
    facts: {
      response: answer.length === 0 ? 'blank' : 'substantive',
      terminology: 'model',
      syllabus: 'within',
      contradiction: false,
      typo: 'none',
      slots,
    },
    evidence: slots.length > 0 ? [evidence(answer)] : [],
    assistance: { kind: 'none', rounds: 0 },
  });
  const value = {
    anchors: [],
    assessments: [assessment('D3', d3Slots), assessment('P1', p1Slots)],
  };
  return { content: JSON.stringify(value), structured: value, model: 'membrane-v1' };
}

function directAssessmentResponse(
  answer: string,
  assessments: Array<{
    nodeId: string;
    verdict: 'hit' | 'partial' | 'miss' | 'needs-review';
    misconceptionIds?: string[];
    reviewReason?: 'rubric-boundary';
  }>,
): LLMResponse {
  const value = {
    assessments: assessments.map((assessment) => ({
      nodeId: assessment.nodeId,
      verdict: assessment.verdict,
      misconceptionIds: assessment.misconceptionIds ?? [],
      rationale: `Test judgment for ${assessment.nodeId}`,
      confidence: 0.99,
      reviewReason: assessment.reviewReason ?? null,
      evidence: [{ quote: answer, start: 0, end: answer.length }],
    })),
  };
  return { content: JSON.stringify(value), structured: value, model: 'direct-test-v1' };
}

function post(app: ReturnType<typeof createServerApp>, route: string, body: unknown, token = apiToken) {
  return app.request(route, {
    method: 'POST',
    headers: { ...headers, 'x-lq-api-token': token },
    body: JSON.stringify(body),
  });
}

describe('server-owned assessment and tutor routes', () => {
  it('assesses training answers and applies question-level evidence to pretest text answers', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const answer = 'Zn 是发生氧化反应并失去电子的电极场所。';
    const provider: LLMProvider = {
      id: 'training-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const requestInput = request.input as { answer?: string };
        if (request.prompt.id === 'direct-assessment') {
          const membraneAnswer = requestInput.answer ?? '';
          return directAssessmentResponse(membraneAnswer, [
            {
              nodeId: 'D3',
              verdict: membraneAnswer.includes('不能') ? 'hit' : 'miss',
            },
            {
              nodeId: 'P1',
              verdict: membraneAnswer.includes('直接反应') ? 'hit' : 'miss',
            },
          ]);
        }
        if (requestInput.answer !== answer) {
          return membraneAssessmentResponse(requestInput.answer ?? '');
        }
        const quote = 'Zn';
        const value = {
          anchors: [],
          assessments: [{
            nodeId: 'D1',
            errorIds: [],
            facts: {
              response: 'substantive',
              terminology: 'model',
              syllabus: 'within',
              contradiction: false,
              typo: 'none',
              slots: [{
                id: 'oxidation-site',
                value: 'Zn',
                evidence: { quote, start: answer.indexOf(quote), end: answer.indexOf(quote) + quote.length },
              }],
            },
            evidence: [{ quote: answer, start: 0, end: answer.length }],
            assistance: { kind: 'none', rounds: 0 },
          }],
        };
        return { content: JSON.stringify(value), structured: value, model: 'training-v1' };
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      sessions,
      workflow: { executionMode: 'live', provider: provider.id, model: 'training-v1' },
    });

    const response = await post(app, '/api/assessment/extract', {
      sessionId: 'training-session',
      caseId: 'zinc-copper',
      questionId: 'zinc-copper:analysis',
      targetNodeIds: ['D1'],
      studentAnswer: answer,
      submissionId: 'zinc-analysis-1',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'extracted',
      session: {
        events: [
          expect.objectContaining({
            kind: 'answer.submitted',
            caseId: 'zinc-copper',
            stageId: 'training',
          }),
          expect.objectContaining({
            kind: 'assessment.completed',
            caseId: 'zinc-copper',
            nodeId: 'D1',
            objectiveOutcome: 'hit',
          }),
        ],
      },
    });

    const membraneCases = [
      {
        answer: '不能，防止 O₂ 与 K 直接反应',
        expected: { D3: 'hit', P1: 'hit' },
      },
      {
        answer: '不能，只允许 K⁺ 通过',
        expected: { D3: 'hit', P1: 'miss' },
      },
      {
        answer: '能通过',
        expected: { D3: 'miss', P1: 'miss' },
      },
      {
        answer: '',
        expected: { D3: 'unanswered', P1: 'unanswered' },
      },
    ] as const;
    for (const [index, membraneCase] of membraneCases.entries()) {
      const membraneResponse = await post(app, '/api/assessment/extract', {
        sessionId: `membrane-session-${index + 1}`,
        questionId: 'pretest-exam1-membrane',
        targetNodeIds: ['D3', 'P1'],
        studentAnswer: membraneCase.answer,
        submissionId: `membrane-submission-${index + 1}`,
      });
      const payload = await membraneResponse.json() as { session: StudentSession };
      const assessments = payload.session.events.filter((event): event is AssessmentCompletedEvent =>
        event.kind === 'assessment.completed');

      expect(membraneResponse.status).toBe(200);
      expect(assessments.find((event) => event.nodeId === 'D3')?.ruleDecision.status)
        .toBe(membraneCase.expected.D3);
      expect(assessments.find((event) => event.nodeId === 'P1')?.ruleDecision.status)
        .toBe(membraneCase.expected.P1);
    }
  });

  it('records a mixed extraction as scored nodes plus node-local teacher review', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const answer = 'Zn在负极失电子，Cu极发生还原反应。';
    const evidence = (quote: string) => {
      const start = answer.indexOf(quote);
      if (start < 0) throw new Error(`Missing test quote ${quote}`);
      return { quote, start, end: start + quote.length };
    };
    const facts = (id: string, value: string, quote: string) => ({
      response: 'substantive',
      terminology: 'model',
      syllabus: 'within',
      contradiction: false,
      typo: 'none',
      slots: [{ id, value, evidence: evidence(quote) }],
    });
    const value = {
      anchors: [],
      assessments: [
        {
          nodeId: 'D1',
          errorIds: [],
          facts: facts('oxidation-site', 'Zn', '负极'),
          evidence: [evidence(answer)],
          assistance: { kind: 'none', rounds: 0 },
        },
        {
          nodeId: 'D4',
          errorIds: [],
          facts: facts('reduction-site', 'Cu', 'Cu极'),
          evidence: [evidence(answer)],
          assistance: { kind: 'none', rounds: 0 },
        },
      ],
    };
    let attempts = 0;
    const provider: LLMProvider = {
      id: 'mixed-node-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        attempts += 1;
        return { content: JSON.stringify(value), structured: structuredClone(value), model: 'mixed-v1' };
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      sessions,
      workflow: { executionMode: 'live', provider: provider.id, model: 'mixed-v1' },
    });

    const response = await post(app, '/api/assessment/extract', {
      sessionId: 'mixed-node-session',
      caseId: 'zinc-copper',
      questionId: 'zinc-copper:analysis',
      targetNodeIds: ['D1', 'D4'],
      studentAnswer: answer,
      submissionId: 'mixed-node-submission',
    });
    const payload = await response.json() as {
      status: string;
      assessmentSummary: { scoredCount: number; needsReviewCount: number };
      session: StudentSession;
    };
    const assessments = payload.session.events.filter(
      (event): event is AssessmentCompletedEvent => event.kind === 'assessment.completed',
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
    expect(payload.status).toBe('extracted');
    expect(payload.assessmentSummary).toEqual({ scoredCount: 1, needsReviewCount: 1 });
    expect(payload.session.events.filter((event) => event.kind === 'answer.submitted')).toHaveLength(1);
    expect(assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'D4',
        ruleDecision: { status: 'hit', ruleId: expect.any(String) },
        score: expect.objectContaining({ status: 'scored', outcome: 'hit' }),
      }),
      expect.objectContaining({
        nodeId: 'D1',
        extraction: { status: 'needs-review' },
        score: { status: 'unassessed' },
      }),
    ]));
    expect(sessions.get('mixed-node-session')?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'D1',
        extraction: expect.objectContaining({ status: 'needs-review', reason: 'fact-grounding' }),
      }),
    ]));
  });

  it('uses direct judgment for the Q4 pure cathode equation and keeps legacy scoring as hidden audit', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const provider: LLMProvider = {
      id: 'q4-equation-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const input = request.input as { answer: string };
        return directAssessmentResponse(input.answer, [{ nodeId: 'P6', verdict: 'hit' }]);
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      providers: new Map([[provider.id, provider]]),
      workflow: { executionMode: 'live', provider: provider.id, model: 'q4-equation-v1' },
    });

    const response = await post(app, '/api/assessment/extract', {
      sessionId: 'q4-cathode-equation-session',
      questionId: 'pretest-exam4-cathode-equation',
      targetNodeIds: ['P6'],
      studentAnswer: 'O₂ + 2H₂O + 4e⁻ = 4OH⁻',
      submissionId: 'q4-cathode-equation-1',
    });
    const payload = await response.json() as {
      status: string;
      session: StudentSession;
    };
    const assessment = payload.session.events.find((event): event is AssessmentCompletedEvent =>
      event.kind === 'assessment.completed' && event.nodeId === 'P6');

    expect(response.status).toBe(200);
    expect(payload.status).toBe('direct-assessed');
    expect(assessment).toMatchObject({
      ruleDecision: { status: 'hit' },
      score: { status: 'scored', outcome: 'hit' },
    });
    expect(assessment?.extraction).not.toHaveProperty('judgment');
    expect(payload.session.events.some((event) => event.kind === 'assessment.audit.completed'))
      .toBe(false);
    expect(sessions.get('q4-cathode-equation-session')?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assessment.completed',
          nodeId: 'P6',
          extraction: expect.objectContaining({
            judgment: expect.objectContaining({
              voteCount: 3,
              agreeingVotes: 3,
              scopeVersion: expect.any(String),
            }),
          }),
        }),
        expect.objectContaining({
          kind: 'assessment.audit.completed',
          nodeId: 'P6',
          verdict: 'hit',
        }),
        expect.objectContaining({
          kind: 'assessment.divergence.changed',
          nodeId: 'P6',
          status: 'matched',
        }),
      ]),
    );
  });

  it('does not let a failed legacy audit overturn or block a direct primary score', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const provider: LLMProvider = {
      id: 'audit-failure-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const input = request.input as {
          answer: string;
          nodes?: Array<{ id: string }>;
        };
        if (request.prompt.id !== 'direct-assessment') {
          throw new Error('legacy audit unavailable');
        }
        return directAssessmentResponse(
          input.answer,
          input.nodes!.map((node) => ({ nodeId: node.id, verdict: 'hit' as const })),
        );
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      providers: new Map([[provider.id, provider]]),
      workflow: { executionMode: 'live', provider: provider.id, model: 'audit-failure-v1' },
    });

    const response = await post(app, '/api/assessment/extract', {
      sessionId: 'audit-failure-session',
      questionId: 'pretest-exam1-membrane',
      targetNodeIds: ['D3', 'P1'],
      studentAnswer: '不能，防止 K 与 O₂ 直接反应。',
      submissionId: 'audit-failure-1',
    });
    const payload = await response.json() as { status: string; session: StudentSession };

    expect(response.status).toBe(200);
    expect(payload.status).toBe('direct-assessed');
    expect(payload.session.events.filter((event) =>
      event.kind === 'assessment.completed')).toEqual([
      expect.objectContaining({ ruleDecision: expect.objectContaining({ status: 'hit' }) }),
      expect.objectContaining({ ruleDecision: expect.objectContaining({ status: 'hit' }) }),
    ]);
    expect(sessions.get('audit-failure-session')?.events.filter((event) =>
      event.kind === 'assessment.audit.completed')).toEqual([
      expect.objectContaining({ verdict: 'needs-review' }),
      expect.objectContaining({ verdict: 'needs-review' }),
    ]);
    expect(sessions.get('audit-failure-session')?.events.some((event) =>
      event.kind === 'assessment.divergence.changed')).toBe(false);
  });

  it('scores the Q4 CuO process from its question-level catalyst, regeneration, and oxidation slots', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const provider: LLMProvider = {
      id: 'q4-process-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const input = request.input as {
          answer: string;
          targetNodeIds?: Array<'D5' | 'P2'>;
          assistance?: { kind: 'none'; rounds: 0 };
        };
        const slot = (id: string, value: string, quote: string) => ({
          id,
          value,
          evidence: {
            quote,
            start: input.answer.indexOf(quote),
            end: input.answer.indexOf(quote) + quote.length,
          },
        });
        const role = input.answer.includes('催化作用')
          ? [slot('cuo-role', 'catalyst', '催化作用')]
          : input.answer.includes('中间产物')
            ? [slot('cuo-role', 'intermediate', '中间产物')]
            : [];
        const regenerated = input.answer.includes('又生成')
          ? [slot('cuo-regenerated', 'cuo-regenerated', '又生成')]
          : [];
        const oxidized = input.answer.includes('将葡萄糖氧化')
          ? [slot('glucose-oxidized', 'glucose-oxidized', '将葡萄糖氧化')]
          : [];
        if (request.prompt.id === 'direct-assessment') {
          return directAssessmentResponse(input.answer, [
            {
              nodeId: 'D5',
              verdict: role.some((entry) => entry.value === 'intermediate')
                ? 'miss'
                : role.length > 0 && regenerated.length > 0
                  ? 'hit'
                  : role.length > 0
                    ? 'partial'
                    : 'miss',
            },
            {
              nodeId: 'P2',
              verdict: oxidized.length > 0 ? 'hit' : 'miss',
            },
          ]);
        }
        const slotsByNode = { D5: [...role, ...regenerated], P2: oxidized };
        const assessments = input.targetNodeIds!.map((nodeId) => ({
          nodeId,
          errorIds: [],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: slotsByNode[nodeId],
          },
          evidence: slotsByNode[nodeId].map((entry) => entry.evidence),
          assistance: input.assistance!,
        }));
        const value = { anchors: [], assessments };
        return { content: JSON.stringify(value), structured: value, model: 'q4-process.v1' };
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      sessions,
      workflow: { executionMode: 'live', provider: provider.id, model: 'q4-process.v1' },
    });
    const cases = [
      {
        name: 'complete',
        answer: 'CuO 将葡萄糖氧化为葡萄糖酸；Cu₂O 失电子又生成 CuO；CuO 起催化作用。',
        expectedD5: 'hit',
        expectedP2: 'hit',
      },
      {
        name: 'catalyst-only',
        answer: 'CuO 起催化作用。',
        expectedD5: 'partial',
        expectedP2: 'miss',
      },
      {
        name: 'intermediate',
        answer: 'CuO 是中间产物。',
        expectedD5: 'miss',
        expectedP2: 'miss',
      },
    ] as const;

    for (const processCase of cases) {
      const response = await post(app, '/api/assessment/extract', {
        sessionId: `q4-process-${processCase.name}`,
        questionId: 'pretest-exam4-process',
        targetNodeIds: ['D5', 'P2'],
        studentAnswer: processCase.answer,
        submissionId: `q4-process-submission-${processCase.name}`,
      });
      const payload = await response.json() as {
        session: StudentSession;
      };
      const assessments = payload.session.events.filter(
        (event): event is AssessmentCompletedEvent => event.kind === 'assessment.completed',
      );

      expect(response.status).toBe(200);
      expect(assessments.find((event) => event.nodeId === 'D5')?.ruleDecision.status)
        .toBe(processCase.expectedD5);
      expect(assessments.find((event) => event.nodeId === 'P2')?.ruleDecision.status)
        .toBe(processCase.expectedP2);
      if (processCase.name === 'intermediate') {
        expect(sessions.get(`q4-process-${processCase.name}`)?.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'assessment.audit.completed',
              nodeId: 'D5',
              verdict: 'miss',
            }),
          ]),
        );
      }
    }
  });

  it('scores a training equation through the server route and keeps retries idempotent', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      workflow: { now: () => Date.parse('2026-07-15T12:00:00.000Z') },
    });
    const body = {
      sessionId: 'equation-session',
      caseId: 'zinc-copper',
      equationSetId: 'zinc-negative',
      equation: 'Zn -> Zn^2+ + 2e^-',
      submissionId: 'zinc-negative-1',
    };

    const first = await post(app, '/api/assessment/equation', body);
    const retry = await post(app, '/api/assessment/equation', body);

    expect(first.status).toBe(200);
    const payload = await first.json() as { status: string; session: StudentSession };
    expect(payload.status).toBe('recorded');
    expect(payload.session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'answer.submitted',
        caseId: 'zinc-copper',
        stageId: 'training',
        questionId: 'zinc-copper:zinc-negative',
      }),
      expect.objectContaining({ kind: 'assessment.completed', nodeId: 'P3' }),
      expect.objectContaining({ kind: 'assessment.completed', nodeId: 'P6' }),
      expect.objectContaining({ kind: 'assessment.completed', nodeId: 'P7' }),
    ]));
    expect(await retry.json()).toMatchObject({ status: 'already-recorded' });
    expect(sessions.get('equation-session')?.events).toHaveLength(6);
  });

  it('keeps each equation attempt and prevents later hits from replacing an earlier half-reaction miss', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      workflow: { now: () => Date.parse('2026-07-15T12:00:00.000Z') },
    });
    const sessionId = 'equation-composite-session';
    const submissions = [
      {
        equationSetId: 'zinc-negative',
        equation: 'Cu -> Cu^2+ + 2e^-',
        submissionId: 'negative-miss',
      },
      {
        equationSetId: 'copper-positive',
        equation: 'Cu^2+ + 2e^- -> Cu',
        submissionId: 'positive-hit',
      },
      {
        equationSetId: 'zinc-copper-overall',
        equation: 'Zn + Cu^2+ -> Zn^2+ + Cu',
        submissionId: 'overall-hit',
      },
    ];

    for (const submission of submissions) {
      const response = await post(app, '/api/assessment/equation', {
        sessionId,
        caseId: 'zinc-copper',
        ...submission,
      });
      expect(response.status).toBe(200);
    }

    const session = sessions.get(sessionId)!;
    const answers = session.events.filter((event) => event.kind === 'answer.submitted');
    expect(answers.map((event) => ({ questionId: event.questionId, attemptId: event.attemptId })))
      .toEqual([
        { questionId: 'zinc-copper:zinc-negative', attemptId: 'negative-miss' },
        { questionId: 'zinc-copper:copper-positive', attemptId: 'positive-hit' },
        { questionId: 'zinc-copper:zinc-copper-overall', attemptId: 'overall-hit' },
      ]);

    const composite = session.events.filter((event): event is AssessmentCompletedEvent =>
      event.kind === 'assessment.completed'
      && event.ruleDecision.status !== 'unanswered'
      && 'engine' in event.ruleDecision
      && event.ruleDecision.engine.id === 'equation-case-composite');
    const latestByNode = new Map<string, typeof composite[number]>();
    for (const event of composite) {
      const previous = latestByNode.get(event.nodeId);
      if (!previous || event.sequence > previous.sequence) latestByNode.set(event.nodeId, event);
    }

    expect(latestByNode.get('P3')).toMatchObject({
      attemptId: 'overall-hit',
      ruleDecision: { status: 'miss' },
    });
    expect(latestByNode.get('P6')).toMatchObject({
      attemptId: 'overall-hit',
      ruleDecision: { status: 'miss' },
    });
    expect(latestByNode.get('P7')).toMatchObject({
      attemptId: 'overall-hit',
      ruleDecision: { status: 'hit' },
    });
    const latestAssessment = [...session.events].reverse().find((event) =>
      event.kind === 'assessment.completed' && event.nodeId === 'P6');
    expect(latestAssessment).toMatchObject({
      ruleDecision: { status: 'miss', engine: { id: 'equation-case-composite' } },
    });
  });

  it('downgrades composite P6 to partial when individually valid half reactions do not cancel electrons', async () => {
    const sessions = new TestSessionStore();
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist'),
      apiToken,
      sessions,
      workflow: { now: () => Date.parse('2026-07-15T12:00:00.000Z') },
    });
    const sessionId = 'equation-electron-cancellation-session';

    for (const submission of [
      {
        equationSetId: 'hydrogen-negative',
        equation: 'H2 -> 2H^+ + 2e^-',
        submissionId: 'hydrogen-half-hit',
      },
      {
        equationSetId: 'oxygen-positive',
        equation: 'O2 + 4H^+ + 4e^- -> 2H2O',
        submissionId: 'oxygen-half-hit',
      },
    ]) {
      const response = await post(app, '/api/assessment/equation', {
        sessionId,
        caseId: 'hydrogen-oxygen',
        ...submission,
      });
      expect(response.status).toBe(200);
    }

    const latestCompositeP6 = [...sessions.get(sessionId)!.events].reverse().find((event) =>
      event.kind === 'assessment.completed'
      && event.nodeId === 'P6'
      && event.ruleDecision.status !== 'unanswered'
      && 'engine' in event.ruleDecision
      && event.ruleDecision.engine.id === 'equation-case-composite');
    expect(latestCompositeP6).toMatchObject({
      ruleDecision: {
        status: 'partial',
        reason: expect.stringContaining('multipliers 2:1'),
      },
      score: { status: 'scored', outcome: 'partial' },
    });
  });

  it('accepts only minimal workflow input and blocks the raw protected-prompt bypass', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const requests: LLMRequest[] = [];
    const answer = '电子由Zn极流向Cu极。';
    const provider: LLMProvider = {
      id: 'workflow-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        requests.push(request);
        return assessmentResponse(answer, 'Zn', 'Cu');
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      sessions,
      workflow: {
        executionMode: 'live',
        provider: provider.id,
        model: 'workflow-v1',
      },
    });

    const unauthorized = await post(app, '/api/assessment/extract', {
      sessionId: 'route-session',
      questionId: 'pretest-principle-process',
      targetNodeIds: ['P4'],
      studentAnswer: answer,
      submissionId: 'route-submission',
    }, 'wrong-token');
    const invalid = await post(app, '/api/assessment/extract', {
      sessionId: 'route-session',
      questionId: 'pretest-principle-process',
      targetNodeIds: ['P4'],
      studentAnswer: answer,
      submissionId: 'route-submission',
      prompt: { text: 'client-controlled' },
    });
    const extracted = await post(app, '/api/assessment/extract', {
      sessionId: 'route-session',
      questionId: 'pretest-principle-process',
      targetNodeIds: ['P4'],
      studentAnswer: answer,
      submissionId: 'route-submission',
    });
    const retry = await post(app, '/api/assessment/extract', {
      sessionId: 'route-session',
      questionId: 'pretest-principle-process',
      targetNodeIds: ['P4'],
      studentAnswer: answer,
      submissionId: 'route-submission',
    });
    const bypass = await post(app, '/api/llm', {
      executionMode: 'live',
      capability: 'structured',
      provider: provider.id,
      model: 'workflow-v1',
      prompt: { id: 'structured-assessment' },
      schemaVersion: 'client-schema',
      configVersion: 'client-config',
      input: {},
      images: [],
      schema: {},
    });

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(extracted.status).toBe(200);
    expect(await extracted.json()).toMatchObject({
      status: 'extracted',
      session: {
        id: 'route-session',
        events: [
          expect.objectContaining({ kind: 'answer.submitted' }),
          expect.objectContaining({
            kind: 'assessment.completed',
            caseId: 'pretest',
            objectiveOutcome: 'hit',
          }),
        ],
      },
    });
    expect(sessions.get('route-session')?.events).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(await retry.json()).toMatchObject({ status: 'already-recorded' });
    expect(requests[0]).toMatchObject({
      prompt: { id: 'structured-assessment' },
      schemaVersion: 'structured-assessment.v5',
      temperature: 0.1,
      input: {
        answer,
        caseId: 'zinc-copper',
        targetNodeIds: ['P4'],
      },
    });
    expect(bypass.status).toBe(403);
  });

  it('scores choice answers on the server and returns the stored session idempotently', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      workflow: { now: () => Date.parse('2026-07-15T12:00:00.000Z') },
    });
    const body = {
      sessionId: 'choice-session',
      questionId: 'pretest-energy',
      optionId: 'B',
      submissionId: 'choice-submission-1',
    };

    const first = await post(app, '/api/assessment/choice', body);
    const retry = await post(app, '/api/assessment/choice', body);
    const payload = await first.json() as { session: StudentSession; status: string };

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(payload.status).toBe('recorded');
    expect(payload.session.events.filter((event) => event.kind === 'answer.submitted')).toHaveLength(1);
    expect(payload.session.events.filter((event) => event.kind === 'assessment.completed')).toHaveLength(3);
    expect(await retry.json()).toMatchObject({ status: 'already-recorded', session: payload.session });
    expect(projectStudentSession(sessions.get('choice-session'))).toEqual(payload.session);
  });

  it('maps original fill answers server-side and records direct choice skips as unanswered', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: 'direct-choice-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        providerCalls += 1;
        const input = request.input as {
          answer: string;
          nodes: Array<{ id: string }>;
        };
        return directAssessmentResponse(
          input.answer,
          input.nodes.map((node) => ({ nodeId: node.id, verdict: 'hit' as const })),
        );
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      providers: new Map([[provider.id, provider]]),
      workflow: { executionMode: 'live', provider: provider.id, model: 'direct-choice-v1' },
    });

    const answeredBody = {
      sessionId: 'direct-choice-answer',
      questionId: 'pretest-exam4-material',
      rawAnswer: '纳米CuO',
      submissionKind: 'answer',
      submissionId: 'direct-choice-answer-1',
    };
    const answered = await post(app, '/api/assessment/choice', answeredBody);
    const answeredRetry = await post(app, '/api/assessment/choice', answeredBody);
    const answeredPayload = await answered.json() as { session: StudentSession };
    expect(answered.status).toBe(200);
    expect(await answeredRetry.json()).toMatchObject({ status: 'already-recorded' });
    expect(providerCalls).toBe(3);
    expect(answeredPayload.session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'answer.submitted',
        answer: { format: 'text', value: '纳米CuO' },
      }),
      expect.objectContaining({
        kind: 'assessment.completed',
        nodeId: 'D5',
        ruleDecision: expect.objectContaining({ status: 'hit' }),
      }),
    ]));
    expect(sessions.get('direct-choice-answer')?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'assessment.audit.completed',
        nodeId: 'D5',
        verdict: 'hit',
      }),
      expect.objectContaining({
        kind: 'assessment.divergence.changed',
        nodeId: 'D5',
        status: 'matched',
      }),
    ]));

    const skipped = await post(app, '/api/assessment/choice', {
      sessionId: 'direct-choice-skip',
      questionId: 'pretest-exam4-material',
      rawAnswer: '',
      submissionKind: 'skip',
      submissionId: 'direct-choice-skip-1',
    });
    const skippedPayload = await skipped.json() as { session: StudentSession };
    expect(skipped.status).toBe(200);
    expect(providerCalls).toBe(3);
    expect(skippedPayload.session.events.filter((event) =>
      event.kind === 'assessment.completed')).toEqual([
      expect.objectContaining({ ruleDecision: expect.objectContaining({ status: 'unanswered' }) }),
      expect.objectContaining({ ruleDecision: expect.objectContaining({ status: 'unanswered' }) }),
    ]);

    const incomplete = await post(app, '/api/assessment/choice', {
      sessionId: 'direct-choice-incomplete',
      questionId: 'pretest-exam4-polarity',
      rawAnswer: '正|',
      submissionKind: 'answer',
      submissionId: 'direct-choice-incomplete-1',
    });
    expect(incomplete.status).toBe(400);
    expect(providerCalls).toBe(3);
    expect(sessions.get('direct-choice-incomplete')).toBeUndefined();
  });

  it('records one answer attempt for a multi-node extraction submission', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const sessions = new TestSessionStore();
    const provider: LLMProvider = {
      id: 'multi-node-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const answer = (request.input as { answer: string }).answer;
        return directAssessmentResponse(
          answer,
          ['P3', 'P4', 'P5', 'P6', 'P7'].map((nodeId) => ({
            nodeId,
            verdict: 'hit' as const,
          })),
        );
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      providers: new Map([[provider.id, provider]]),
      workflow: {
        executionMode: 'live',
        provider: provider.id,
        model: 'multi-node-v1',
        now: () => Date.parse('2026-07-15T12:00:00.000Z'),
      },
    });

    const response = await post(app, '/api/assessment/extract', {
      sessionId: 'multi-node-session',
      questionId: 'pretest-principle-process',
      targetNodeIds: ['P3', 'P4', 'P5', 'P6', 'P7'],
      studentAnswer: '负极：Zn - 2e⁻ = Zn²⁺；正极：Cu²⁺ + 2e⁻ = Cu；总反应：Zn + Cu²⁺ = Zn²⁺ + Cu。电子和离子按闭合回路移动。',
      submissionId: 'multi-node-submission',
    });
    const payload = await response.json() as { session: StudentSession };

    expect(response.status).toBe(200);
    expect(payload.session.events.filter((event) => event.kind === 'answer.submitted')).toHaveLength(1);
    const assessments = payload.session.events.filter((event) => event.kind === 'assessment.completed');
    expect(assessments).toHaveLength(5);
    for (const nodeId of ['P3', 'P6', 'P7']) {
      expect(assessments.find((event) => event.nodeId === nodeId)).toMatchObject({
        ruleDecision: { status: 'hit' },
        score: { status: 'scored', outcome: 'hit' },
      });
    }
    expect(payload.session.events.every((event) => event.caseId === 'pretest')).toBe(true);
  });

  it('runs miss, three server-derived tutor turns, revised extraction, and assisted scoring end to end', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const policyFile = path.join(root, 'config', 'scaffold-policy.json');
    const policy = JSON.parse(await readFile(policyFile, 'utf8'));
    policy.assistance.correctOutcome = 'hit';
    policy.socratic.correctedOutcome = 'hit-with-help';
    await writeFile(policyFile, JSON.stringify(policy));
    const sessions = new TestSessionStore();
    const tutorTurns = [
      { action: 'probe', content: '先说明哪一处发生失电子反应。' },
      { action: 'hint', content: '再把氧化位置和电子起点联系起来。' },
      { action: 'check', content: '现在逐项核对起点和终点。' },
    ];
    let tutorCall = 0;
    const provider: LLMProvider = {
      id: 'e2e-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        const input = request.input as {
          answer?: string;
          assistance?: { kind: 'none' | 'hint' | 'socratic'; rounds: number };
        };
        if (request.prompt.id === 'structured-assessment') {
          const answer = input.answer!;
          return answer.includes('Cu极流向Zn极')
            ? assessmentResponse(answer, 'Cu', 'Zn', input.assistance)
            : assessmentResponse(answer, 'Zn', 'Cu', input.assistance);
        }
        const value = tutorTurns[tutorCall++];
        return { content: JSON.stringify(value), structured: value, model: 'e2e-v1' };
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      sessions,
      workflow: { executionMode: 'live', provider: provider.id, model: 'e2e-v1' },
    });
    const sessionId = 'e2e-session';

    const initial = await post(app, '/api/assessment/extract', {
      sessionId,
      caseId: 'zinc-copper',
      questionId: 'zinc-copper:analysis',
      targetNodeIds: ['P4'],
      studentAnswer: '电子由Cu极流向Zn极。',
      submissionId: 'initial-p4',
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      session: { events: [expect.anything(), expect.objectContaining({ objectiveOutcome: 'miss' })] },
    });

    for (let round = 1; round <= 3; round += 1) {
      const response = await post(app, '/api/tutor/turn', {
        sessionId,
        nodeId: 'P4',
        studentAnswer: `第${round}轮仍在思考。`,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 'respond',
        assistance: { kind: 'socratic', rounds: round },
      });
    }

    const revised = await post(app, '/api/assessment/extract', {
      sessionId,
      caseId: 'zinc-copper',
      questionId: 'zinc-copper:analysis',
      targetNodeIds: ['P4'],
      studentAnswer: '电子由Zn极流向Cu极。',
      submissionId: 'revised-p4',
    });
    const payload = await revised.json() as { session: StudentSession };
    const assessments = payload.session.events.filter((event) => event.kind === 'assessment.completed');

    expect(revised.status).toBe(200);
    expect(tutorCall).toBe(3);
    expect(assessments).toHaveLength(2);
    expect(assessments[0]).toMatchObject({ objectiveOutcome: 'miss' });
    expect(assessments[1]).toMatchObject({
      objectiveOutcome: 'hit',
      assistance: { kind: 'socratic', rounds: 3 },
      ruleDecision: { status: 'hit-with-help' },
      score: { outcome: 'hit-with-help' },
    });
    expect(payload.session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tutor.cycle.terminal', reason: 'max-rounds' }),
    ]));
    expect(projectStudentSession(sessions.get(sessionId))).toEqual(payload.session);
  });

  it('rejects tutor turns for both pretest and transfer assessments', async () => {
    const config = await loadAllConfig(process.cwd());
    const sessions = new TestSessionStore();
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist'),
      apiToken,
      sessions,
      workflow: { now: () => Date.parse('2026-07-15T12:00:00.000Z') },
    });

    const pretest = await post(app, '/api/assessment/choice', {
      sessionId: 'pretest-tutor-rejected',
      questionId: 'pretest-energy',
      optionId: 'B',
      submissionId: 'pretest-energy-miss',
    });
    expect(pretest.status).toBe(200);
    const pretestTutor = await post(app, '/api/tutor/turn', {
      sessionId: 'pretest-tutor-rejected',
      nodeId: 'E1',
      studentAnswer: '请提示。',
    });

    const transferCase = config.cases.find((entry) => entry.caseType === 'transfer')!;
    const overall = transferCase.equationSets.find((entry) => entry.electrode === 'overall')!;
    const transfer = await post(app, '/api/assessment/equation', {
      sessionId: 'transfer-tutor-rejected',
      caseId: transferCase.id,
      equationSetId: overall.id,
      equation: 'CH4 + O2 -> CO2',
      submissionId: 'transfer-overall-miss',
    });
    expect(transfer.status).toBe(200);
    const transferTutor = await post(app, '/api/tutor/turn', {
      sessionId: 'transfer-tutor-rejected',
      nodeId: 'P7',
      studentAnswer: '请提示。',
    });
    const unassessedTutor = await post(app, '/api/tutor/turn', {
      sessionId: 'pretest-tutor-rejected',
      nodeId: 'D1',
      studentAnswer: '请提示。',
    });

    expect(pretestTutor.status).toBe(409);
    expect(await pretestTutor.json()).toEqual({ error: 'Tutor is only available for training-stage answers' });
    expect(transferTutor.status).toBe(409);
    expect(await transferTutor.json()).toEqual({ error: 'Tutor is only available for training-stage answers' });
    expect(unassessedTutor.status).toBe(409);
    expect(await unassessedTutor.json()).toEqual({ error: 'Tutor requires an assessed training-stage answer' });
  });
});
