import type { LoadedConfig } from '../config/schemas';
import {
  structuredAssessmentResponseSchema,
  type StructuredAssessmentResponse,
} from './assessment';

export type ExtractionValidationCategory =
  | 'closed-set'
  | 'citation-mismatch'
  | 'normalization-insufficient'
  | 'fact-grounding'
  | 'answer-too-long';

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

export function normalizeComparisonText(value: string, commonTypos: Record<string, string>) {
  return normalizeWithPositions(value, commonTypos)
    .map((unit) => unit.character)
    .join('');
}

function aliasBoundaryCharacter(character: string | undefined) {
  return character !== undefined && /[a-z0-9^+\-]/iu.test(character);
}

function containsNormalizedAlias(text: string, alias: string) {
  if (!/[a-z0-9]/iu.test(alias)) return text.includes(alias);
  for (let index = text.indexOf(alias); index >= 0; index = text.indexOf(alias, index + 1)) {
    if (
      !aliasBoundaryCharacter(text[index - 1])
      && !aliasBoundaryCharacter(text[index + alias.length])
    ) {
      return true;
    }
  }
  return false;
}

const booleanNegationTokens = [
  '并非',
  '并不',
  '无法',
  '不能',
  '不会',
  '不可',
  '不得',
  '没有',
  '未',
  '没',
  '非',
  '不',
] as const;

function containsBooleanNegation(value: string, commonTypos: Record<string, string>) {
  const normalized = normalizeComparisonText(value, commonTypos);
  return booleanNegationTokens.some((token) => normalized.includes(token));
}

function quoteGroundingContext(
  answer: string,
  evidence: { start: number; end: number },
) {
  const adjacentCharacters = 4;
  const before = [...answer.slice(0, evidence.start)].slice(-adjacentCharacters).join('');
  const after = [...answer.slice(evidence.end)].slice(0, adjacentCharacters).join('');
  return `${before}${answer.slice(evidence.start, evidence.end)}${after}`;
}

export function factValueAliases(
  value: string,
  aliases: Record<string, string[]>,
  commonTypos: Record<string, string>,
) {
  const configured = aliases[value] ?? [];
  return [...new Set([value, ...configured]
    .map((entry) => normalizeComparisonText(entry, commonTypos))
    .filter((entry) => entry.length > 0))];
}

export function quoteExpressesFactValue(input: {
  quote: string;
  value: string;
  aliases: Record<string, string[]>;
  commonTypos: Record<string, string>;
  groundingContext?: string;
}) {
  const quote = normalizeComparisonText(input.quote, input.commonTypos);
  if (
    normalizeComparisonText(input.value, input.commonTypos) === 'true'
    && containsBooleanNegation(input.groundingContext ?? input.quote, input.commonTypos)
  ) {
    return false;
  }
  return factValueAliases(input.value, input.aliases, input.commonTypos)
    .some((alias) => containsNormalizedAlias(quote, alias));
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

function protectedSemanticTokens(value: string, commonTypos: Record<string, string>) {
  const normalized = normalizeComparisonText(value, commonTypos);
  const tokens = new Set<string>();
  for (const pattern of [
    /不|非|未/gu,
    /正极|负极/gu,
    /氧化|还原/gu,
    /流入|流出/gu,
    /[a-z][a-z0-9]*(?:\^[0-9]*[+\-]|[0-9]*[+\-])?/giu,
  ]) {
    for (const match of normalized.matchAll(pattern)) tokens.add(match[0]);
  }
  return [...tokens].sort();
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
  // Unlisted edits are never admitted: ratio === 0 is the only success path.
  // maxEditDistanceRatio is retained only as diagnostic detail for rejected candidates.
  if (match?.ratio === 0) {
    return {
      quote: answer.slice(match.start, match.end),
      start: match.start,
      end: match.end,
    };
  }
  if (match && match.ratio <= policy.normalizationCandidateMaxEditDistanceRatio) {
    const actualQuote = answer.slice(match.start, match.end);
    const modelTokens = protectedSemanticTokens(evidence.quote, policy.commonTypos);
    const answerTokens = protectedSemanticTokens(actualQuote, policy.commonTypos);
    throw new ExtractionValidationError(
      'normalization-insufficient',
      false,
      'Citation contains an edit outside the configured typo map',
      {
        ...detail,
        modelQuote: evidence.quote,
        editDistanceRatio: match.ratio,
        maxEditDistanceRatio: policy.maxEditDistanceRatio,
        protectedTokenMismatch: JSON.stringify(modelTokens) !== JSON.stringify(answerTokens),
        modelProtectedTokens: modelTokens,
        answerProtectedTokens: answerTokens,
      },
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
  const maximumAnswerCharacters = input.config.scaffoldPolicy.extraction.maximumAnswerCharacters;
  if (input.answer.length > maximumAnswerCharacters) {
    throw new ExtractionValidationError(
      'answer-too-long',
      false,
      `Answer exceeds the configured ${maximumAnswerCharacters} character limit`,
      { answerLength: input.answer.length, maximumAnswerCharacters },
    );
  }
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
    const configuredAnchor = trainingCase.followingAnchors.find((entry) => entry.id === anchor.anchorId);
    if (!anchorIds.has(anchor.anchorId) || !configuredAnchor) {
      throw new ExtractionValidationError('closed-set', true, `Unknown anchor ${anchor.anchorId}`);
    }
    const allowedFactIds = new Set(configuredAnchor.correctValue.split(';').map((entry) => {
      const separator = entry.indexOf('=');
      return separator < 1 ? '' : entry.slice(0, separator).trim();
    }).filter(Boolean));
    const seenFactIds = new Set<string>();
    for (const [factIndex, fact] of anchor.facts.entries()) {
      if (!allowedFactIds.has(fact.id) || seenFactIds.has(fact.id)) {
        throw new ExtractionValidationError(
          'closed-set',
          true,
          `Anchor ${anchor.anchorId} contains an unknown or duplicate fact slot ${fact.id}`,
          { caseId: input.caseId, anchorId: anchor.anchorId, factIndex, slotId: fact.id },
        );
      }
      seenFactIds.add(fact.id);
      fact.evidence = validateEvidence(
        fact.evidence,
        input.answer,
        input.config,
        { caseId: input.caseId, anchorId: anchor.anchorId, slotId: fact.id, factIndex },
      );
      if (!quoteExpressesFactValue({
        quote: fact.evidence.quote,
        value: fact.value,
        aliases: input.config.scaffoldPolicy.extraction.factValueAliases,
        commonTypos: input.config.scaffoldPolicy.extraction.citation.commonTypos,
        groundingContext: quoteGroundingContext(input.answer, fact.evidence),
      })) {
        throw new ExtractionValidationError(
          'fact-grounding',
          false,
          `Anchor fact ${fact.id} is not expressed by its bound quote`,
          {
            caseId: input.caseId,
            anchorId: anchor.anchorId,
            slotId: fact.id,
            slotValue: fact.value,
            modelQuote: fact.evidence.quote,
          },
        );
      }
    }
    anchor.evidence = anchor.evidence.map((evidence, evidenceIndex) => validateEvidence(
      evidence,
      input.answer,
      input.config,
      { caseId: input.caseId, anchorId: anchor.anchorId, evidenceIndex },
    ));
  }
  for (const assessment of parsed.assessments) {
    const evidencePath = trainingCase.evidencePaths.find((entry) =>
      entry.nodeId === assessment.nodeId && entry.source === 'answer');
    const allowedSlotIds = new Set(evidencePath?.factRequirements.map((entry) => entry.id) ?? []);
    const seenSlotIds = new Set<string>();
    for (const [slotIndex, slot] of assessment.facts.slots.entries()) {
      if (!allowedSlotIds.has(slot.id) || seenSlotIds.has(slot.id)) {
        throw new ExtractionValidationError(
          'closed-set',
          true,
          `Assessment ${assessment.nodeId} contains an unknown or duplicate fact slot ${slot.id}`,
          { caseId: input.caseId, nodeId: assessment.nodeId, slotId: slot.id, slotIndex },
        );
      }
      seenSlotIds.add(slot.id);
      slot.evidence = validateEvidence(
        slot.evidence,
        input.answer,
        input.config,
        { caseId: input.caseId, nodeId: assessment.nodeId, slotId: slot.id, slotIndex },
      );
      if (!quoteExpressesFactValue({
        quote: slot.evidence.quote,
        value: slot.value,
        aliases: input.config.scaffoldPolicy.extraction.factValueAliases,
        commonTypos: input.config.scaffoldPolicy.extraction.citation.commonTypos,
        groundingContext: quoteGroundingContext(input.answer, slot.evidence),
      })) {
        throw new ExtractionValidationError(
          'fact-grounding',
          false,
          `Fact ${slot.id} is not expressed by its bound quote`,
          {
            caseId: input.caseId,
            nodeId: assessment.nodeId,
            slotId: slot.id,
            slotValue: slot.value,
            modelQuote: slot.evidence.quote,
          },
        );
      }
    }
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
