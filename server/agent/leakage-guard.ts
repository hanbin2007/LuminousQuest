import type { LoadedConfig } from '../../shared/config/schemas';
import {
  answerLeakage,
  factValueLeakage,
} from '../../shared/workflows/socratic';
import {
  findAgentQuestion,
  hashQuestionContent,
  type AgentQuestionBankEntry,
} from './question-bank';
import type { ResponseContractCandidate } from './response-contracts';

export type AgentLeakageGuardResult =
  | {
      safe: true;
      path: 'question-bank-verbatim' | 'free-question' | 'student-summary';
    }
  | {
      safe: false;
      category:
        | 'question-content-mismatch'
        | 'answer-point-leak'
        | 'target-fact-leak'
        | 'summary-answer-leak';
      detail: string;
    };

interface ForbiddenFacts {
  referenceAnswerPoints: string[];
  forbiddenValues: string[];
}

function unique(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function factsForQuestion(
  config: LoadedConfig,
  question: AgentQuestionBankEntry,
): ForbiddenFacts {
  if (question.caseId === 'pretest') {
    if (question.questionId === 'pretest-builder') {
      return {
        referenceAnswerPoints: config.pretest.builder.structuralRules.map(
          (rule) => rule.description,
        ),
        forbiddenValues: config.pretest.builder.structuralRules.flatMap(
          (rule) => rule.requiredComponentIds,
        ),
      };
    }
    const configured = config.pretest.questions.find(
      (entry) => entry.id === question.questionId,
    );
    if (!configured) return { referenceAnswerPoints: [], forbiddenValues: [] };
    if (configured.type === 'choice') {
      const correct = configured.options.filter((option) => option.correct);
      return {
        referenceAnswerPoints: correct.map((option) => option.text),
        forbiddenValues: correct.map((option) => option.text),
      };
    }
    return {
      referenceAnswerPoints: unique([
        ...configured.answerGuidance,
        ...(configured.evidence ?? []).flatMap((entry) =>
          entry.referenceAnswerPoints),
      ]),
      forbiddenValues: unique([
        ...(configured.evidence ?? []).flatMap((entry) =>
          entry.factRequirements.flatMap((fact) => fact.acceptedValues)),
        ...configured.referenceEquations.map((entry) => entry.equation),
      ]),
    };
  }

  const trainingCase = config.cases.find((entry) => entry.id === question.caseId);
  if (!trainingCase) return { referenceAnswerPoints: [], forbiddenValues: [] };
  const equationSetId = question.questionId.startsWith(`${trainingCase.id}:`)
    ? question.questionId.slice(trainingCase.id.length + 1)
    : '';
  const equationSet = trainingCase.equationSets.find(
    (entry) => entry.id === equationSetId,
  );
  if (equationSet) {
    return {
      referenceAnswerPoints: [...equationSet.accepted],
      forbiddenValues: [...equationSet.accepted],
    };
  }
  return {
    referenceAnswerPoints: unique(
      trainingCase.evidencePaths.flatMap((entry) => entry.referenceAnswerPoints),
    ),
    forbiddenValues: unique([
      ...trainingCase.followingAnchors.map((anchor) => anchor.correctValue),
      ...trainingCase.evidencePaths.flatMap((entry) =>
        entry.factRequirements.flatMap((fact) => fact.acceptedValues)),
      ...trainingCase.equationSets.flatMap((entry) => entry.accepted),
    ]),
  };
}

export function unpublishedFactsForCase(
  config: LoadedConfig,
  caseId: string,
): ForbiddenFacts {
  const questions = caseId === 'pretest'
    ? [
        findAgentQuestion(config, 'pretest-builder'),
        ...config.pretest.questions.map((question) =>
          findAgentQuestion(config, question.id)),
      ]
    : [
        findAgentQuestion(config, `${caseId}:analysis`),
        ...(
          config.cases.find((entry) => entry.id === caseId)?.equationSets.map(
            (equationSet) =>
              findAgentQuestion(config, `${caseId}:${equationSet.id}`),
          ) ?? []
        ),
      ];
  const facts = questions
    .filter((question): question is AgentQuestionBankEntry => Boolean(question))
    .map((question) => factsForQuestion(config, question));
  return {
    referenceAnswerPoints: unique(
      facts.flatMap((entry) => entry.referenceAnswerPoints),
    ),
    forbiddenValues: unique(facts.flatMap((entry) => entry.forbiddenValues)),
  };
}

function inspect(
  config: LoadedConfig,
  content: string,
  facts: ForbiddenFacts,
  options: { summary: boolean },
): AgentLeakageGuardResult {
  const policy = config.scaffoldPolicy.socratic;
  const commonTypos = config.scaffoldPolicy.extraction.citation.commonTypos;
  const overlap = answerLeakage(
    content,
    facts.referenceAnswerPoints,
    policy.answerOverlapThreshold,
    commonTypos,
    policy.minimumSharedBigrams,
  );
  if (overlap.leaked) {
    return {
      safe: false,
      category: options.summary ? 'summary-answer-leak' : 'answer-point-leak',
      detail: `configured answer overlap ${overlap.overlap.toFixed(3)}`,
    };
  }
  const fact = factValueLeakage({
    content,
    forbiddenValues: facts.forbiddenValues,
    aliases: config.scaffoldPolicy.extraction.factValueAliases,
    commonTypos,
  });
  const leaked = options.summary
    ? fact.leaked
    : fact.matchedValue !== null;
  if (leaked) {
    return {
      safe: false,
      category: options.summary ? 'summary-answer-leak' : 'target-fact-leak',
      detail: fact.matchedValue
        ? 'configured target fact was revealed'
        : fact.proxyReference
          ? 'summary resolves multiple hidden facts by proxy'
          : 'summary includes a complete hidden equation',
    };
  }
  return {
    safe: true,
    path: options.summary ? 'student-summary' : 'free-question',
  };
}

export function guardQuestionBankText(
  question: AgentQuestionBankEntry,
  text: string,
): AgentLeakageGuardResult {
  if (
    text !== question.prompt
    || hashQuestionContent(text) !== question.contentHash
  ) {
    return {
      safe: false,
      category: 'question-content-mismatch',
      detail: 'configured questions must be presented byte-for-byte',
    };
  }
  return { safe: true, path: 'question-bank-verbatim' };
}

export function guardFreeQuestion(input: {
  config: LoadedConfig;
  text: string;
  candidate: ResponseContractCandidate;
}) {
  if (input.candidate.kind === 'question' && input.candidate.questionId) {
    const question = findAgentQuestion(input.config, input.candidate.questionId);
    if (!question) {
      return {
        safe: false,
        category: 'target-fact-leak',
        detail: 'response contract candidate points to an unknown question',
      } satisfies AgentLeakageGuardResult;
    }
    if (
      input.text === question.prompt
      && hashQuestionContent(input.text) === question.contentHash
    ) {
      return {
        safe: true,
        path: 'question-bank-verbatim',
      } satisfies AgentLeakageGuardResult;
    }
    return inspect(input.config, input.text, factsForQuestion(input.config, question), {
      summary: false,
    });
  }
  return inspect(
    input.config,
    input.text,
    unpublishedFactsForCase(input.config, input.candidate.caseId),
    { summary: false },
  );
}

export function guardStudentSummary(input: {
  config: LoadedConfig;
  caseId: string;
  summary: string;
  recentAgentOutputs: readonly string[];
}) {
  const combined = [
    ...input.recentAgentOutputs.slice(-3),
    input.summary,
  ].join('\n');
  return inspect(
    input.config,
    combined,
    unpublishedFactsForCase(input.config, input.caseId),
    { summary: true },
  );
}
