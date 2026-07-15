import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createServerApp } from '../server/app';
import type { LLMProvider, LLMRequest, LLMResponse } from '../server/llm/types';
import type { StudentSession } from '../shared/session';
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

function post(app: ReturnType<typeof createServerApp>, route: string, body: unknown, token = apiToken) {
  return app.request(route, {
    method: 'POST',
    headers: { ...headers, 'x-lq-api-token': token },
    body: JSON.stringify(body),
  });
}

describe('server-owned assessment and tutor routes', () => {
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
      caseId: 'zinc-copper',
      nodeId: 'P4',
      studentAnswer: answer,
    }, 'wrong-token');
    const invalid = await post(app, '/api/assessment/extract', {
      sessionId: 'route-session',
      caseId: 'zinc-copper',
      nodeId: 'P4',
      studentAnswer: answer,
      prompt: { text: 'client-controlled' },
    });
    const extracted = await post(app, '/api/assessment/extract', {
      sessionId: 'route-session',
      caseId: 'zinc-copper',
      nodeId: 'P4',
      studentAnswer: answer,
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
            objectiveOutcome: 'hit',
          }),
        ],
      },
    });
    expect(sessions.get('route-session')?.events).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      prompt: { id: 'structured-assessment' },
      schemaVersion: 'structured-assessment.v4',
      input: {
        answer,
        caseId: 'zinc-copper',
        targetNodeIds: ['P4'],
      },
    });
    expect(bypass.status).toBe(403);
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
      nodeId: 'P4',
      studentAnswer: '电子由Cu极流向Zn极。',
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
      nodeId: 'P4',
      studentAnswer: '电子由Zn极流向Cu极。',
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
    expect(sessions.get(sessionId)).toEqual(payload.session);
  });
});
