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

const confusableCharacters: Record<string, string> = {
  Α: 'A',
  А: 'A',
  Β: 'B',
  В: 'B',
  Ε: 'E',
  Е: 'E',
  Ζ: 'Z',
  Η: 'H',
  Н: 'H',
  Ι: 'I',
  І: 'I',
  Κ: 'K',
  М: 'M',
  Ν: 'N',
  Ο: 'O',
  О: 'O',
  Ρ: 'P',
  Р: 'P',
  С: 'C',
  Τ: 'T',
  Х: 'X',
  Υ: 'Y',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  і: 'i',
  Μ: 'M',
  α: 'a',
  ο: 'o',
  ρ: 'p',
  χ: 'x',
};

function normalizeObfuscation(value: string) {
  const normalized = value
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\uD800-\uDFFF]/g, '');
  const folded = [...normalized]
    .map((character) => confusableCharacters[character] ?? character)
    .join('');
  return folded
    .replace(/[钅金][\s\p{P}\p{S}]*辛/gu, '锌')
    .replace(/[钅金][\s\p{P}\p{S}]*同/gu, '铜')
    .replace(/[钅金][\s\p{P}\p{S}]*吕/gu, '铝');
}

function decodedUnicodeEscapes(value: string) {
  return value
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)));
}

function isUsefulDecodedText(value: string) {
  if (!value || value.includes('\uFFFD') || value.includes('\u0000')) return false;
  const printable = [...value].filter((character) =>
    !/\p{Cc}/u.test(character) || character === '\n' || character === '\t').length;
  return printable / [...value].length >= 0.9;
}

function decodeCandidates(value: string) {
  const decoded = new Set<string>();
  const compact = value.replace(/\s+/g, '');
  for (const candidate of compact.match(/[A-Za-z0-9+/_=-]{8,}/g) ?? []) {
    const standard = candidate.replaceAll('-', '+').replaceAll('_', '/');
    if (standard.length % 4 === 1) continue;
    try {
      const result = Buffer.from(
        standard.padEnd(Math.ceil(standard.length / 4) * 4, '='),
        'base64',
      ).toString('utf8');
      if (isUsefulDecodedText(result)) decoded.add(result);
    } catch {
      // Ignore non-Base64 text and continue with the other representations.
    }
  }
  for (const candidate of compact.match(/[0-9a-fA-F]{8,}/g) ?? []) {
    if (candidate.length % 2 !== 0) continue;
    const result = Buffer.from(candidate, 'hex').toString('utf8');
    if (isUsefulDecodedText(result)) decoded.add(result);
  }
  const prefixedHex = [...value.matchAll(/(?:0x)([0-9a-fA-F]{2})/g)]
    .map((match) => match[1])
    .join('');
  if (prefixedHex.length >= 8) {
    const result = Buffer.from(prefixedHex, 'hex').toString('utf8');
    if (isUsefulDecodedText(result)) decoded.add(result);
  }
  const escaped = decodedUnicodeEscapes(value);
  if (escaped !== value) decoded.add(escaped);
  return decoded;
}

function pinyinCandidates(value: string) {
  const compact = value
    .toLowerCase()
    .replace(/[ǖǘǚǜü]/g, 'v')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[^a-z0-9]/g, '');
  const decoded: string[] = [];
  const ordered = (...needles: string[]) => {
    let offset = 0;
    return needles.every((needle) => {
      const found = compact.indexOf(needle, offset);
      if (found < 0) return false;
      offset = found + needle.length;
      return true;
    });
  };
  if (
    ordered('xin', 'fu', 'tong', 'zheng')
    || ordered('tong', 'zheng', 'xin', 'fu')
  ) {
    decoded.push('锌极为负极，铜极为正极。', 'negative=Zn;positive=Cu');
  }
  if (
    ordered('lv', 'fu', 'duokongtan', 'zheng')
    || ordered('duokongtan', 'zheng', 'lv', 'fu')
  ) {
    decoded.push(
      '铝极为负极，多孔碳空气极为正极。',
      'negative=Al;positive=porous-carbon',
    );
  }
  if (ordered('qingqi', 'fu', 'yangqi', 'zheng')) {
    decoded.push(
      '氢气侧为负极，氧气侧为正极。',
      'negative=hydrogen-Pt;positive=oxygen-Pt',
    );
  }
  if (ordered('jiawan', 'fu', 'yangqi', 'zheng')) {
    decoded.push(
      '甲烷侧为负极，氧气侧为正极。',
      'negative=methane-side;positive=oxygen-side',
    );
  }
  return decoded;
}

function inspectionVariants(parts: readonly string[]) {
  const seeds = [
    parts.join('\n'),
    parts.join(''),
    ...parts,
  ].map(normalizeObfuscation);
  const variants = new Set(seeds);
  for (let depth = 0; depth < 2; depth += 1) {
    for (const value of [...variants]) {
      for (const decoded of [
        ...decodeCandidates(value),
        ...pinyinCandidates(value),
      ]) {
        variants.add(normalizeObfuscation(decoded));
      }
    }
  }
  return [...variants];
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

function inspectCumulative(
  config: LoadedConfig,
  parts: readonly string[],
  facts: ForbiddenFacts,
  options: { summary: boolean },
) {
  for (const variant of inspectionVariants(parts)) {
    const result = inspect(config, variant, facts, options);
    if (!result.safe) return result;
  }
  return {
    safe: true,
    path: options.summary ? 'student-summary' : 'free-question',
  } satisfies AgentLeakageGuardResult;
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
  studentVisibleOutputs?: readonly string[];
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
    return inspectCumulative(
      input.config,
      [...(input.studentVisibleOutputs ?? []), input.text],
      factsForQuestion(input.config, question),
      { summary: false },
    );
  }
  return inspectCumulative(
    input.config,
    [...(input.studentVisibleOutputs ?? []), input.text],
    unpublishedFactsForCase(input.config, input.candidate.caseId),
    { summary: false },
  );
}

export function guardStudentSummary(input: {
  config: LoadedConfig;
  caseId: string;
  summary: string;
  recentAgentOutputs: readonly string[];
  studentVisibleOutputs?: readonly string[];
}) {
  return inspectCumulative(
    input.config,
    [
      ...(input.studentVisibleOutputs ?? input.recentAgentOutputs),
      input.summary,
    ],
    unpublishedFactsForCase(input.config, input.caseId),
    { summary: true },
  );
}
