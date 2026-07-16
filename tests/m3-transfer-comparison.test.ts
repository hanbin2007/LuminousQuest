import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
  type SessionEventInput,
} from '../shared/session';
import { buildTransferComparison } from '../src/features/training/transfer-comparison';

const occurredAt = '2026-07-15T12:00:00.000Z';

function provenance() {
  return {
    promptId: 'structured-assessment',
    promptVersion: 'sha256:prompt',
    cacheKey: 'sha256:cache',
  };
}

describe('cold-transfer pre/post comparison', () => {
  it('normalizes only common, assessed nodes with configured weights and the latest scored attempt', async () => {
    const config = await loadAllConfig(process.cwd());
    const transferCase = structuredClone(config.cases[0]);
    transferCase.id = 'methane-transfer';
    transferCase.title = '甲烷燃料电池冷迁移';
    transferCase.caseType = 'transfer';
    transferCase.sequence = 99;
    transferCase.tutoring = [];
    transferCase.targetNodeIds = ['D1', 'D2', 'P1', 'P4', 'E1'];
    config.cases = [...config.cases, transferCase];
    config.runtimeVersions.cases[transferCase.id] = transferCase.version;
    config.rubrics.policy.weighting.nodeOverrides.D1 = 1;

    let session = createSession({
      id: 'session-transfer-comparison',
      anonymousStudentId: 'anon-A1B2C3D4',
      now: occurredAt,
      configVersions: sessionConfigVersions(config),
    });
    let suffix = 0;

    const appendAnswer = (caseId: string, nodeId: string, answer: string) => {
      suffix += 1;
      const identity = `${caseId}-${nodeId}-${suffix}`;
      session = appendSessionEvent(session, {
        id: `answer-${identity}`,
        occurredAt,
        kind: 'answer.submitted',
        pipelineStage: 'answer',
        caseId,
        stageId: 'analysis',
        attemptId: `attempt-${identity}`,
        questionId: `question-${nodeId}`,
        answer: { format: 'text', value: answer },
      });
      return identity;
    };

    const appendScore = (
      caseId: string,
      nodeId: string,
      outcome: 'hit' | 'partial' | 'miss',
    ) => {
      const answer = `${nodeId}-${outcome}`;
      const identity = appendAnswer(caseId, nodeId, answer);
      const rubric = config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId)!;
      const decision = resolveRubricDecision({
        rubrics: config.rubrics,
        scaffoldPolicy: config.scaffoldPolicy,
        nodeId,
        objectiveOutcome: outcome,
        assistance: { kind: 'none', rounds: 0 },
      });
      session = appendSessionEvent(session, {
        id: `assessment-${identity}`,
        occurredAt,
        kind: 'assessment.completed',
        pipelineStage: 'score',
        caseId,
        stageId: 'analysis',
        attemptId: `attempt-${identity}`,
        sourceAnswerEventId: `answer-${identity}`,
        nodeId,
        rubric: { id: rubric.id, version: config.rubrics.version },
        extraction: {
          status: 'assessed',
          evidence: [{ quote: answer, start: 0, end: answer.length }],
          model: 'mock-v1',
          provenance: provenance(),
        },
        ...decision,
      });
    };

    const appendAbsent = (
      caseId: string,
      nodeId: string,
      status: 'unassessed' | 'needs-review' | 'unanswered',
    ) => {
      const answer = status === 'unanswered' ? '' : `${nodeId}-${status}`;
      const identity = appendAnswer(caseId, nodeId, answer);
      const rubric = config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId)!;
      const base = {
        id: `assessment-${identity}`,
        occurredAt,
        kind: 'assessment.completed' as const,
        caseId,
        stageId: 'analysis',
        attemptId: `attempt-${identity}`,
        sourceAnswerEventId: `answer-${identity}`,
        nodeId,
        rubric: { id: rubric.id, version: config.rubrics.version },
        assistance: { kind: 'none' as const, rounds: 0 },
      };
      let event: SessionEventInput;
      if (status === 'unanswered') {
        event = {
          ...base,
          pipelineStage: 'score',
          extraction: {
            status: 'assessed',
            evidence: [],
            model: 'mock-v1',
            provenance: provenance(),
          },
          ruleDecision: {
            status: 'unanswered',
            reason: 'empty answer',
            promptRetry: false,
            includeInDiagnosis: false,
          },
          following: {
            status: 'not-followed',
            anchorNodeId: null,
            anchorOutcome: null,
            policy: 'score-logical-chain',
          },
          score: {
            status: 'unanswered',
            promptRetry: false,
            includeInDiagnosis: false,
          },
        };
      } else {
        event = {
          ...base,
          pipelineStage: 'extraction',
          extraction: status === 'needs-review'
            ? {
                status: 'needs-review',
                reason: 'ambiguous evidence',
                model: 'mock-v1',
                provenance: provenance(),
              }
            : {
                status: 'unassessed',
                reason: 'provider unavailable',
                model: 'mock-v1',
                provenance: provenance(),
              },
          ruleDecision: { status: 'unassessed', reason: 'no assessed extraction' },
          following: { status: 'unassessed' },
          score: { status: 'unassessed' },
        };
      }
      session = appendSessionEvent(session, event);
    };

    appendScore('pretest', 'D1', 'hit');
    appendScore('pretest', 'D1', 'miss');
    appendScore('pretest', 'D2', 'hit');
    appendAbsent('pretest', 'D2', 'unassessed');
    appendScore('pretest', 'P4', 'partial');
    appendAbsent('pretest', 'E1', 'needs-review');

    appendScore(transferCase.id, 'D1', 'hit');
    appendAbsent(transferCase.id, 'D2', 'unanswered');
    appendScore(transferCase.id, 'P1', 'hit');
    appendAbsent(transferCase.id, 'P4', 'unassessed');
    appendAbsent(transferCase.id, 'E1', 'needs-review');

    const comparison = buildTransferComparison(session, config, transferCase.id);

    expect(comparison.commonNodeIds).toEqual(['D1', 'D2', 'P4', 'E1']);
    expect(comparison.dimensions).toEqual([
      {
        dimensionId: 'device',
        label: '装置',
        commonNodeIds: ['D1', 'D2'],
        pretest: {
          weightedEarned: 1,
          assessedWeight: 2,
          ratio: 0.5,
          assessedNodeIds: ['D1', 'D2'],
          unassessedNodeIds: [],
        },
        transfer: {
          weightedEarned: 1,
          assessedWeight: 1,
          ratio: 1,
          assessedNodeIds: ['D1'],
          unassessedNodeIds: ['D2'],
        },
      },
      {
        dimensionId: 'principle',
        label: '原理',
        commonNodeIds: ['P4'],
        pretest: {
          weightedEarned: 1,
          assessedWeight: 2,
          ratio: 0.5,
          assessedNodeIds: ['P4'],
          unassessedNodeIds: [],
        },
        transfer: {
          weightedEarned: 0,
          assessedWeight: 0,
          ratio: null,
          assessedNodeIds: [],
          unassessedNodeIds: ['P4'],
        },
      },
      {
        dimensionId: 'energy',
        label: '能量',
        commonNodeIds: ['E1'],
        pretest: {
          weightedEarned: 0,
          assessedWeight: 0,
          ratio: null,
          assessedNodeIds: [],
          unassessedNodeIds: ['E1'],
        },
        transfer: {
          weightedEarned: 0,
          assessedWeight: 0,
          ratio: null,
          assessedNodeIds: [],
          unassessedNodeIds: ['E1'],
        },
      },
    ]);
  });
});
