import { describe, expect, it } from 'vitest';

import { projectStudentSession } from '../shared/session/projections';
import {
  appendSessionEvent,
  createSession,
} from '../shared/session/session';
import type { SessionEventInput } from '../shared/session/schema';
import { mergeServerSession } from '../src/features/pretest/session-merge';

const configVersions = {
  configDigest: 'sha256:test',
  knowledgeModel: 'knowledge-model.v1',
  rubrics: 'rubrics.v1',
  pretest: 'pretest.v1',
  scaffoldPolicy: 'scaffold-policy.v1',
  cases: { 'zinc-copper': 'case.v1' },
  grammar: 'grammar.v1',
  engines: {
    rubric: 'rubric.v1',
    topology: 'topology.v1',
    equation: 'equation.v1',
  },
};

function answerEvent(
  id: string,
  attemptId: string,
  occurredAt: string,
): Extract<SessionEventInput, { kind: 'answer.submitted' }> {
  return {
    id,
    occurredAt,
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId,
    questionId: 'zinc-copper:analysis',
    answer: { format: 'text', value: '电子从锌极流向铜极。' },
  };
}

describe('M6 projected session merge', () => {
  it('rebases agent context through the matching event id when local sequence numbers differ', () => {
    let local = createSession({
      id: 'm6-merge-session',
      anonymousStudentId: 'anon-M6MERGE1',
      now: '2026-07-23T12:00:00.000Z',
      configVersions,
    });
    local = appendSessionEvent(
      local,
      answerEvent('local-only-answer', 'local-only-attempt', '2026-07-23T12:00:01.000Z'),
    );
    local = appendSessionEvent(
      local,
      answerEvent('shared-trigger', 'shared-attempt', '2026-07-23T12:00:02.000Z'),
    );

    let server = createSession({
      id: local.id,
      anonymousStudentId: local.anonymousStudentId,
      now: local.startedAt,
      configVersions,
    });
    server = appendSessionEvent(
      server,
      answerEvent('shared-trigger', 'shared-attempt', '2026-07-23T12:00:02.000Z'),
    );
    server = appendSessionEvent(server, {
      id: 'agent-turn-event',
      occurredAt: '2026-07-23T12:00:03.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'zinc-copper',
      stageId: 'training',
      attemptId: 'agent-attempt',
      turnId: 'agent-turn',
      triggerEventId: 'shared-trigger',
      contextThroughSequence: 0,
      requestHash: `sha256:${'a'.repeat(64)}`,
      source: 'fallback',
      model: 'deterministic-fallback',
      orderedActions: [{
        callId: 'ask-student',
        name: 'ask_student',
        arguments: {
          text: '请继续说明。',
          responseContractId: 'response-contract',
        },
      }],
      terminalAction: { callId: 'ask-student', name: 'ask_student' },
      provenance: {
        adapter: 'openai-compatible',
        adapterVersion: 'agent-adapter.v1',
      },
    });

    const merged = mergeServerSession(local, projectStudentSession(server));
    const turn = merged.events.find((event) => event.kind === 'agent.turn.completed');

    expect(turn).toMatchObject({
      triggerEventId: 'shared-trigger',
      contextThroughSequence: 1,
      sequence: 2,
    });
  });
});
