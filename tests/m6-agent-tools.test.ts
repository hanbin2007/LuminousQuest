import { describe, expect, it } from 'vitest';

import { buildAgentTurnContext } from '../server/agent/context-builder';
import {
  AGENT_TEACHER_FALLBACK_QUESTION,
  AgentToolHandler,
} from '../server/agent/tool-handlers';
import { ResponseContractRegistry } from '../server/agent/response-contracts';
import { AgentTurnTransaction } from '../server/agent/turn-transaction';
import { loadAllConfig } from '../server/config/loader';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../shared/session';

async function handlerFixture(turnId: string) {
  const config = await loadAllConfig(process.cwd());
  let session = createSession({
    id: `tool-handler-${turnId}`,
    anonymousStudentId: 'anon-TOOLS001',
    now: '2026-07-23T19:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  });
  session = appendSessionEvent(session, {
    id: `trigger-${turnId}`,
    occurredAt: '2026-07-23T19:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: `trigger-attempt-${turnId}`,
    questionId: 'zinc-copper:analysis',
    answer: { format: 'text', value: '我先尝试分析。' },
  });
  const builtContext = buildAgentTurnContext({
    session,
    config,
    triggerEventId: `trigger-${turnId}`,
    turnId,
    currentCaseId: 'zinc-copper',
    model: 'tool-test-model',
  });
  const transaction = new AgentTurnTransaction();
  const responseContracts = new ResponseContractRegistry();
  const handler = new AgentToolHandler({
    session,
    config,
    transaction,
    responseContracts,
    builtContext,
    turnId,
    triggerEventId: `trigger-${turnId}`,
    occurredAt: '2026-07-23T19:00:02.000Z',
    identity: {
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: `response-attempt-${turnId}`,
    },
    provenance: {
      adapter: 'openai-compatible',
      adapterVersion: 'test-adapter.v1',
    },
  });
  return {
    config,
    session,
    builtContext,
    transaction,
    responseContracts,
    handler,
  };
}

describe('M6 Phase 2 agent tool handlers', () => {
  it('executes profile, material, focus, and safe end-session handlers serially', async () => {
    const fixture = await handlerFixture('continuations');
    const profile = await fixture.handler.execute({
      callId: 'profile',
      name: 'get_profile',
      arguments: {},
    });
    const material = await fixture.handler.execute({
      callId: 'material',
      name: 'present_material',
      arguments: { materialId: 'apparatus' },
    });
    const focus = await fixture.handler.execute({
      callId: 'focus',
      name: 'focus_node',
      arguments: { nodeId: 'P4' },
    });
    const end = await fixture.handler.execute({
      callId: 'end',
      name: 'end_session',
      arguments: { summary: '本轮先到这里，请根据自己的作答继续复盘。' },
    });

    expect([profile, material, focus, end].every((entry) => entry.accepted)).toBe(true);
    expect(JSON.parse(material.content)).toMatchObject({
      value: {
        materialId: 'apparatus',
        caseId: 'zinc-copper',
      },
    });
    expect(JSON.parse(focus.content)).toMatchObject({
      value: { nodeId: 'P4', authoritative: false },
    });
    expect(fixture.transaction.state).toBe('terminal');
    expect(fixture.transaction.recordedActions.map((action) => action.name)).toEqual([
      'get_profile',
      'present_material',
      'focus_node',
      'end_session',
    ]);
  });

  it('returns one leakage category, then substitutes the teacher-approved question', async () => {
    const fixture = await handlerFixture('guard-repair');
    const free = fixture.builtContext.responseContractCandidates.find(
      (candidate) => candidate.kind === 'unassessed',
    )!;
    const hiddenEquation = fixture.config.cases
      .find((entry) => entry.id === 'zinc-copper')!
      .equationSets[0].accepted[0];
    const first = await fixture.handler.execute({
      callId: 'unsafe-1',
      name: 'ask_student',
      arguments: {
        text: hiddenEquation,
        responseContractId: free.candidateId,
      },
    });
    const second = await fixture.handler.execute({
      callId: 'unsafe-2',
      name: 'ask_student',
      arguments: {
        text: hiddenEquation,
        responseContractId: free.candidateId,
      },
    });

    expect(first).toMatchObject({
      accepted: false,
      errorCategory: expect.stringMatching(/leak/),
    });
    expect(second).toMatchObject({
      accepted: true,
      action: {
        name: 'ask_student',
        arguments: {
          text: AGENT_TEACHER_FALLBACK_QUESTION,
          responseContractId: expect.stringMatching(/^rc-/),
        },
      },
    });
    expect(fixture.transaction.state).toBe('terminal');
  });
});
