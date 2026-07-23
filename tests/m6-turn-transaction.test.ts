import { describe, expect, it } from 'vitest';

import {
  AgentTurnTransaction,
  AgentTurnTransactionError,
} from '../server/agent/turn-transaction';
import {
  appendSessionEvent,
  createSession,
  type SessionEventInput,
} from '../shared/session';

const configVersions = {
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

function baseline() {
  const session = createSession({
    id: 'turn-transaction-session',
    anonymousStudentId: 'anon-TURN0001',
    now: '2026-07-23T16:00:00.000Z',
    configVersions,
  });
  return appendSessionEvent(session, {
    id: 'turn-trigger-answer',
    occurredAt: '2026-07-23T16:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: 'trigger-attempt',
    questionId: 'zinc-copper:analysis',
    answer: { format: 'text', value: '触发下一轮' },
  });
}

const turnMetadata = {
  id: 'turn-transaction-event',
  occurredAt: '2026-07-23T16:00:02.000Z',
  kind: 'agent.turn.completed',
  pipelineStage: 'agent',
  caseId: 'zinc-copper',
  stageId: 'training',
  attemptId: 'agent-attempt',
  turnId: 'turn-transaction-1',
  triggerEventId: 'turn-trigger-answer',
  contextThroughSequence: 0,
  requestHash: `sha256:${'1'.repeat(64)}`,
  source: 'provider',
  model: 'frozen-model',
  provenance: {
    adapter: 'openai-compatible',
    adapterVersion: 'agent-adapter.v1',
  },
} satisfies Omit<
  Extract<SessionEventInput, { kind: 'agent.turn.completed' }>,
  'orderedActions' | 'terminalAction'
>;

describe('AgentTurnTransaction contract', () => {
  it('serially latches one terminal action and rejects every later tool call', () => {
    const transaction = new AgentTurnTransaction();
    transaction.recordAction({
      callId: 'profile',
      name: 'get_profile',
      arguments: {},
    });
    transaction.recordAction({
      callId: 'ask',
      name: 'ask_student',
      arguments: {
        text: '请回答。',
        responseContractId: 'response-contract',
      },
    });

    expect(transaction.state).toBe('terminal');
    expect(() => transaction.recordAction({
      callId: 'late-focus',
      name: 'focus_node',
      arguments: { nodeId: 'P4' },
    })).toThrow(AgentTurnTransactionError);
  });

  it('enforces continuation, total-call, and one-judgment-per-node limits', () => {
    const continuationLimit = new AgentTurnTransaction();
    for (let index = 0; index < 6; index += 1) {
      continuationLimit.recordAction({
        callId: `focus-${index}`,
        name: 'focus_node',
        arguments: { nodeId: `P${index}` },
      });
    }
    expect(() => continuationLimit.recordAction({
      callId: 'focus-overflow',
      name: 'focus_node',
      arguments: { nodeId: 'P-overflow' },
    })).toThrow(/continuation/i);

    const judgmentLimit = new AgentTurnTransaction();
    judgmentLimit.recordAction({
      callId: 'judge-1',
      name: 'conclude_node',
      arguments: { nodeId: 'P4', verdict: 'hit', rationale: 'first' },
    });
    expect(() => judgmentLimit.recordAction({
      callId: 'judge-2',
      name: 'conclude_node',
      arguments: { nodeId: 'P4', verdict: 'miss', rationale: 'second' },
    })).toThrow(/once/i);
  });

  it('commits the turn and staged writes atomically only after a terminal action', () => {
    const original = baseline();
    const transaction = new AgentTurnTransaction();
    transaction.recordAction({
      callId: 'ask',
      name: 'ask_student',
      arguments: {
        text: '继续说明。',
        responseContractId: 'response-contract',
      },
    });

    const committed = transaction.commit(original, turnMetadata);
    expect(committed.events).toHaveLength(original.events.length + 1);
    expect(committed.events.at(-1)).toMatchObject({
      kind: 'agent.turn.completed',
      orderedActions: [{ callId: 'ask', name: 'ask_student' }],
      terminalAction: { callId: 'ask', name: 'ask_student' },
    });
    expect(transaction.state).toBe('committed');
    expect(original.events).toHaveLength(1);

    const failing = new AgentTurnTransaction();
    failing.stageWrite({
      id: 'invalid-judgment',
      occurredAt: '2026-07-23T16:00:03.000Z',
      kind: 'agent.judgment.recorded',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'agent-attempt',
      turnId: 'different-turn',
      nodeId: 'P4',
      verdict: 'hit',
      rationale: 'invalid source turn',
      basisThroughSequence: 0,
      basisEventIds: ['turn-trigger-answer'],
      provenance: {
        adapter: 'openai-compatible',
        adapterVersion: 'agent-adapter.v1',
      },
    });
    failing.recordAction({
      callId: 'end',
      name: 'end_session',
      arguments: { summary: '结束。' },
    });

    expect(() => failing.commit(original, turnMetadata)).toThrow();
    expect(failing.state).toBe('aborted');
    expect(original.events).toHaveLength(1);
  });
});
