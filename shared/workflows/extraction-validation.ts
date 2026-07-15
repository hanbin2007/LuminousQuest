import type { LoadedConfig } from '../config/schemas';
import {
  structuredAssessmentResponseSchema,
  type StructuredAssessmentResponse,
} from './assessment';

export type ExtractionValidationCategory =
  | 'closed-set'
  | 'citation-mismatch'
  | 'normalization-insufficient';

export class ExtractionValidationError extends Error {
  constructor(
    readonly category: ExtractionValidationCategory,
    readonly retryable: boolean,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ExtractionValidationError';
  }
}

interface NormalizedUnit {
  character: string;
  start: number;
  end: number;
}

function basicUnits(value: string) {
  const units: NormalizedUnit[] = [];
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const source = String.fromCodePoint(point);
    const end = index + source.length;
    for (const character of source.normalize('NFKC').toLocaleLowerCase('en-US')) {
      if (!/\s/u.test(character)) units.push({ character, start: index, end });
    }
    index = end;
  }
  return units;
}

function normalizedTypoEntries(commonTypos: Record<string, string>) {
  return Object.entries(commonTypos)
    .map(([source, replacement]) => ({
      source: basicUnits(source).map((unit) => unit.character).join(''),
      replacement: basicUnits(replacement).map((unit) => unit.character).join(''),
    }))
    .filter((entry) => entry.source.length > 0 && entry.replacement.length > 0)
    .sort((left, right) => right.source.length - left.source.length);
}

function normalizeWithPositions(value: string, commonTypos: Record<string, string>) {
  const input = basicUnits(value);
  const typoEntries = normalizedTypoEntries(commonTypos);
  const output: NormalizedUnit[] = [];
  for (let index = 0; index < input.length;) {
    const remaining = input.slice(index).map((unit) => unit.character).join('');
    const typo = typoEntries.find((entry) => remaining.startsWith(entry.source));
    if (!typo) {
      output.push(input[index]);
      index += 1;
      continue;
    }
    const matched = input.slice(index, index + [...typo.source].length);
    const start = matched[0].start;
    const end = matched.at(-1)!.end;
    for (const character of typo.replacement) output.push({ character, start, end });
    index += matched.length;
  }
  return output;
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

interface CitationMatch {
  ratio: number;
  start: number;
  end: number;
}

function findCitationMatch(
  answer: string,
  quote: string,
  commonTypos: Record<string, string>,
  diagnosticRatio: number,
): CitationMatch | null {
  const answerUnits = normalizeWithPositions(answer, commonTypos);
  const quoteText = normalizeWithPositions(quote, commonTypos)
    .map((unit) => unit.character)
    .join('');
  const answerText = answerUnits.map((unit) => unit.character).join('');
  if (quoteText.length === 0 || answerText.length === 0) return null;

  const exactIndex = answerText.indexOf(quoteText);
  if (exactIndex >= 0) {
    return {
      ratio: 0,
      start: answerUnits[exactIndex].start,
      end: answerUnits[exactIndex + quoteText.length - 1].end,
    };
  }

  const maximumEdits = Math.max(1, Math.ceil(quoteText.length * diagnosticRatio));
  const minimumLength = Math.max(1, quoteText.length - maximumEdits);
  const maximumLength = Math.min(answerText.length, quoteText.length + maximumEdits);
  let best: CitationMatch | null = null;
  for (let start = 0; start < answerText.length; start += 1) {
    for (let length = minimumLength; length <= maximumLength && start + length <= answerText.length; length += 1) {
      const candidate = answerText.slice(start, start + length);
      const ratio = levenshteinDistance(candidate, quoteText) / Math.max(candidate.length, quoteText.length);
      if (best === null || ratio < best.ratio) {
        best = {
          ratio,
          start: answerUnits[start].start,
          end: answerUnits[start + length - 1].end,
        };
      }
    }
  }
  return best;
}

function validateEvidence(
  evidence: StructuredAssessmentResponse['assessments'][number]['evidence'][number],
  answer: string,
  config: LoadedConfig,
  detail: Record<string, unknown>,
) {
  const policy = config.scaffoldPolicy.extraction.citation;
  const match = findCitationMatch(
    answer,
    evidence.quote,
    policy.commonTypos,
    policy.normalizationCandidateMaxEditDistanceRatio,
  );
  if (match && match.ratio <= policy.maxEditDistanceRatio) {
    return {
      quote: answer.slice(match.start, match.end),
      start: match.start,
      end: match.end,
    };
  }
  if (match && match.ratio <= policy.normalizationCandidateMaxEditDistanceRatio) {
    throw new ExtractionValidationError(
      'normalization-insufficient',
      false,
      'Citation is close to the answer but exceeds the configured normalization threshold',
      { ...detail, modelQuote: evidence.quote, editDistanceRatio: match.ratio },
    );
  }
  throw new ExtractionValidationError(
    'citation-mismatch',
    true,
    'Citation cannot be grounded in the original answer',
    { ...detail, modelQuote: evidence.quote, editDistanceRatio: match?.ratio ?? null },
  );
}

export function validateAssessmentExtraction(input: {
  extraction: unknown;
  answer: string;
  caseId: string;
  targetNodeIds: readonly string[];
  config: LoadedConfig;
}): StructuredAssessmentResponse {
  const parsed = structuredAssessmentResponseSchema.parse(input.extraction);
  const trainingCase = input.config.cases.find((entry) => entry.id === input.caseId);
  if (!trainingCase) {
    throw new ExtractionValidationError('closed-set', true, `Unknown case ${input.caseId}`);
  }
  const caseNodeIds = new Set(trainingCase.targetNodeIds);
  const targetNodeIds = new Set(input.targetNodeIds);
  for (const nodeId of targetNodeIds) {
    if (!caseNodeIds.has(nodeId)) {
      throw new ExtractionValidationError('closed-set', true, `Node ${nodeId} is not a target of case ${input.caseId}`);
    }
  }
  const extractedNodeIds = new Set(parsed.assessments.map((assessment) => assessment.nodeId));
  if (
    extractedNodeIds.size !== targetNodeIds.size
    || [...targetNodeIds].some((nodeId) => !extractedNodeIds.has(nodeId))
  ) {
    throw new ExtractionValidationError(
      'closed-set',
      true,
      'Extracted node ids must exactly match the requested closed set',
      { requestedNodeIds: [...targetNodeIds], extractedNodeIds: [...extractedNodeIds] },
    );
  }

  const misconceptionNode = new Map(
    input.config.knowledgeModel.nodes.flatMap((node) =>
      node.misconceptions.map((misconception) => [misconception.id, node.id] as const)),
  );
  const anchorIds = new Set(trainingCase.followingAnchors.map((anchor) => anchor.id));
  for (const anchor of parsed.anchors) {
    if (!anchorIds.has(anchor.anchorId)) {
      throw new ExtractionValidationError('closed-set', true, `Unknown anchor ${anchor.anchorId}`);
    }
    anchor.evidence = anchor.evidence.map((evidence, evidenceIndex) => validateEvidence(
      evidence,
      input.answer,
      input.config,
      { caseId: input.caseId, anchorId: anchor.anchorId, evidenceIndex },
    ));
  }
  for (const assessment of parsed.assessments) {
    for (const errorId of assessment.errorIds) {
      if (misconceptionNode.get(errorId) !== assessment.nodeId) {
        throw new ExtractionValidationError(
          'closed-set',
          true,
          `Error ${errorId} is not configured for node ${assessment.nodeId}`,
          { caseId: input.caseId, nodeId: assessment.nodeId, errorId },
        );
      }
    }
    if (assessment.facts.response === 'substantive' && assessment.evidence.length === 0) {
      throw new ExtractionValidationError(
        'citation-mismatch',
        true,
        `Substantive assessment ${assessment.nodeId} requires grounded evidence`,
        { caseId: input.caseId, nodeId: assessment.nodeId },
      );
    }
    assessment.evidence = assessment.evidence.map((evidence, evidenceIndex) => validateEvidence(
      evidence,
      input.answer,
      input.config,
      { caseId: input.caseId, nodeId: assessment.nodeId, evidenceIndex },
    ));
  }
  return parsed;
}
