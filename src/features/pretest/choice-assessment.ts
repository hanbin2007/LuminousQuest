import type { LoadedConfig, PretestConfig } from '../../../shared/config/schemas';
import { resolveRubricDecision } from '../../../shared/scoring/rubric';
import { appendSessionEvent } from '../../../shared/session/session';
import type { StudentSession } from '../../../shared/session/schema';

type ChoiceQuestion = Extract<PretestConfig['questions'][number], { type: 'choice' }>;

function uniqueId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function recordChoiceAssessment(input: {
  session: StudentSession;
  config: LoadedConfig;
  question: ChoiceQuestion;
  optionId: string;
}) {
  const option = input.question.options.find((candidate) => candidate.id === input.optionId);
  if (!option) throw new Error(`Unknown choice option ${input.optionId}`);
  const occurredAt = new Date().toISOString();
  const answerId = uniqueId('answer-choice');
  const attemptCount = input.session.events.filter((event) =>
    event.kind === 'answer.submitted' && event.questionId === input.question.id).length;
  const attemptId = `${input.question.id}-${attemptCount + 1}`;
  let session = appendSessionEvent(input.session, {
    id: answerId,
    occurredAt,
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'pretest',
    stageId: 'assessment',
    attemptId,
    questionId: input.question.id,
    answer: { format: 'text', value: option.text },
  });

  input.question.targetNodeIds.forEach((nodeId) => {
    const rubric = input.config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId);
    if (!rubric) throw new Error(`No rubric configured for ${nodeId}`);
    const decision = resolveRubricDecision({
      rubrics: input.config.rubrics,
      scaffoldPolicy: input.config.scaffoldPolicy,
      nodeId,
      objectiveOutcome: option.correct ? 'hit' : 'miss',
      assistance: { kind: 'none', rounds: 0 },
      engine: {
        id: 'configured-choice',
        version: input.config.pretest.version,
        ruleId: option.id,
        reason: option.correct
          ? 'Selected the configured correct option'
          : `Selected a configured distractor: ${option.misconceptionIds.join(', ')}`,
      },
    });
    session = appendSessionEvent(session, {
      id: uniqueId('assessment-choice'),
      occurredAt,
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId,
      sourceAnswerEventId: answerId,
      nodeId,
      rubric: { id: rubric.id, version: input.config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: [{ quote: option.text, start: 0, end: option.text.length }],
        model: 'configured-choice',
        provenance: {
          promptId: input.question.id,
          promptVersion: input.config.pretest.version,
          cacheKey: `${answerId}:${nodeId}`,
        },
      },
      ...decision,
    });
  });
  return { session, correct: option.correct, selectedText: option.text };
}
