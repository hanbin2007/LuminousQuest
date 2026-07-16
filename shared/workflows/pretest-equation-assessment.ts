import type { LoadedConfig } from '../config/schemas';
import { equationScoringEngineVersion, scoreEquation } from '../chemistry/equation';
import { buildLearnerProfile } from '../scoring/profile';
import { resolveRubricDecision } from '../scoring/rubric';
import { appendSessionEvent } from '../session/session';
import type { StudentSession } from '../session/schema';

interface EquationCandidate {
  source: string;
  quote: string;
  start: number;
  end: number;
}

function equationCandidates(answer: string) {
  const candidates: EquationCandidate[] = [];
  for (const match of answer.matchAll(/[^；;。.!！?？\n]+/gu)) {
    const segment = match[0];
    const segmentStart = match.index;
    let leading = segment.length - segment.trimStart().length;
    let source = segment.trim();
    const colon = Math.max(source.lastIndexOf('：'), source.lastIndexOf(':'));
    if (colon >= 0) {
      const afterColon = source.slice(colon + 1);
      leading += colon + 1 + (afterColon.length - afterColon.trimStart().length);
      source = afterColon.trim();
    }
    if (!/(?:->|→|=|⇌)/u.test(source)) continue;
    candidates.push({
      source,
      quote: source,
      start: segmentStart + leading,
      end: segmentStart + leading + source.length,
    });
  }
  return candidates;
}

const outcomeRank = { hit: 3, partial: 2, miss: 1, unanswered: 0 } as const;

export function recordPretestEquationAssessments(input: {
  session: StudentSession;
  config: LoadedConfig;
  answer: {
    id: string;
    occurredAt: string;
    caseId: 'pretest';
    stageId: string;
    attemptId: string;
    questionId: string;
    value: string;
  };
  referenceCaseId: string;
  targetNodeIds: readonly string[];
  assessmentEventIdPrefix: string;
  assessedAt: string;
}) {
  const trainingCase = input.config.cases.find((entry) => entry.id === input.referenceCaseId);
  if (!trainingCase) throw new Error(`No case configured for ${input.referenceCaseId}`);
  const candidates = equationCandidates(input.answer.value);
  let session = input.session;
  const existingAnswer = session.events.find((event) => event.id === input.answer.id);
  if (!existingAnswer) {
    session = appendSessionEvent(session, {
      id: input.answer.id,
      occurredAt: input.answer.occurredAt,
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: input.answer.caseId,
      stageId: input.answer.stageId,
      attemptId: input.answer.attemptId,
      questionId: input.answer.questionId,
      answer: { format: 'text', value: input.answer.value },
    });
  } else if (existingAnswer.kind !== 'answer.submitted') {
    throw new Error(`Event ${input.answer.id} is not an answer`);
  }

  input.targetNodeIds.forEach((nodeId, nodeIndex) => {
    const rubric = input.config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId);
    if (!rubric) throw new Error(`No rubric configured for node ${nodeId}`);
    const equationSets = trainingCase.equationSets.filter((set) => {
      if (nodeId === 'P7') return set.electrode === 'overall';
      if (nodeId === 'P3' || nodeId === 'P6') return set.electrode !== 'overall';
      return true;
    });
    if (equationSets.length === 0) {
      throw new Error(`No equation set is configured for pretest node ${nodeId}`);
    }
    const selected = equationSets.map((set) => {
      const scores = candidates.map((candidate) => ({
        candidate,
        score: scoreEquation(candidate.source, set, input.config.rubrics.policy),
      }));
      return scores.sort((left, right) =>
        outcomeRank[right.score.outcome] - outcomeRank[left.score.outcome])[0];
    });
    const outcomes = selected.map((entry) => entry?.score.outcome ?? 'miss');
    const objectiveOutcome = outcomes.includes('miss') || outcomes.includes('unanswered')
      ? 'miss' as const
      : outcomes.includes('partial') ? 'partial' as const : 'hit' as const;
    const evidence = selected.flatMap((entry) => entry ? [entry.candidate] : [])
      .filter((candidate, index, values) => values.findIndex((entry) =>
        entry.start === candidate.start && entry.end === candidate.end) === index)
      .map(({ quote, start, end }) => ({ quote, start, end }));
    const decision = resolveRubricDecision({
      rubrics: input.config.rubrics,
      scaffoldPolicy: input.config.scaffoldPolicy,
      nodeId,
      objectiveOutcome,
      assistance: { kind: 'none', rounds: 0 },
      engine: {
        id: 'pretest-equation-scoring',
        version: equationScoringEngineVersion,
        ruleId: 'pretest-equation-combined',
        reason: !selected.some(Boolean)
          ? 'No equation was found in the submitted answer'
          : `Combined ${selected.length} configured equation checks`,
      },
    });
    session = appendSessionEvent(session, {
      id: `${input.assessmentEventIdPrefix}-${nodeIndex + 1}`,
      occurredAt: input.assessedAt,
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: input.answer.caseId,
      stageId: input.answer.stageId,
      attemptId: input.answer.attemptId,
      sourceAnswerEventId: input.answer.id,
      nodeId,
      rubric: { id: rubric.id, version: input.config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: evidence.length > 0 ? evidence : [{ quote: '', start: 0, end: 0 }],
        model: 'equation-scoring',
        provenance: {
          promptId: input.answer.questionId,
          promptVersion: input.config.pretest.version,
          cacheKey: `${input.answer.id}:${nodeId}:equations`,
        },
      },
      ...decision,
    });
  });

  return { session, profile: buildLearnerProfile(session, input.config) };
}
