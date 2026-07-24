import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { FileSessionStore } from '../server/session/store';
import { createSession, sessionConfigVersions } from '../shared/session/session';
import { appendAssessmentAudit } from '../shared/workflows/assessment-audit';
import { recordChoiceAssessment } from '../shared/workflows/choice-assessment';
import { recordDirectAssessment } from '../shared/workflows/direct-assessment';
import { createTemporaryDirectory } from './helpers/content-fixture';

describe('file session store', () => {
  it('atomically restores the full teacher audit stream after a new store instance', async () => {
    const root = await createTemporaryDirectory();
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam4-material');
    if (!question || question.type !== 'choice' || !question.directAssessment) {
      throw new Error('missing direct choice question');
    }
    const now = '2026-07-24T00:00:00.000Z';
    const base = createSession({
      id: 'persistent-session',
      anonymousStudentId: 'anon-PERSIST01',
      now,
      configVersions: sessionConfigVersions(config),
    });
    const answer = 'CuO';
    const primary = recordDirectAssessment({
      session: base,
      config,
      question: { ...question, directAssessment: question.directAssessment },
      answer: {
        id: 'persistent-answer',
        occurredAt: now,
        caseId: 'pretest',
        stageId: 'assessment',
        attemptId: 'persistent-attempt',
        questionId: question.id,
        value: answer,
      },
      assessments: question.targetNodeIds.map((nodeId) => ({
        nodeId,
        verdict: 'hit' as const,
        misconceptionIds: [],
        rationale: `${nodeId} is correct`,
        confidence: 0.99,
        reviewReason: null,
        evidence: [{ quote: answer, start: 0, end: answer.length }],
        agreeingVotes: 3 as const,
      })),
      provenance: {
        promptId: 'direct-assessment',
        promptVersion: 'direct-assessment.v1',
        cacheKey: `sha256:${'a'.repeat(64)}`,
        model: 'direct-test-v1',
      },
      assessmentEventIdPrefix: 'persistent-primary',
      assessedAt: now,
    }).session;
    let auditIndex = 0;
    const auditSource = recordChoiceAssessment({
      session: base,
      config,
      question,
      optionId: 'A',
      rawAnswer: answer,
      occurredAt: now,
      attemptId: 'persistent-attempt',
      idFactory: (prefix) => `${prefix}-persistent-audit-${auditIndex++}`,
    }).session;
    const session = appendAssessmentAudit({
      session: primary,
      auditSession: auditSource,
      sourceAnswerEventId: 'persistent-answer',
      questionId: question.id,
      targetNodeIds: question.targetNodeIds,
      eventIdPrefix: 'persistent-audit',
      occurredAt: now,
    });
    const first = new FileSessionStore(path.join(root, 'sessions'));
    first.set(session);

    const restored = new FileSessionStore(path.join(root, 'sessions'))
      .get('persistent-session');

    expect(restored).toEqual(session);
    expect(restored?.events.filter((event) =>
      event.kind === 'assessment.audit.completed')).toHaveLength(2);
    expect(restored?.events.filter((event) =>
      event.kind === 'assessment.divergence.changed')).toHaveLength(2);
  });
});
