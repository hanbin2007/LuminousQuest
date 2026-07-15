import { z } from 'zod';

import {
  normalizeComparisonText,
  quoteExpressesFactValue,
} from './extraction-validation';

export const socraticActionSchema = z
  .object({
    action: z.enum(['probe', 'hint', 'check']),
    content: z.string().trim().min(1),
  })
  .strict();

export type SocraticAction = z.infer<typeof socraticActionSchema>;

export const socraticActionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'content'],
  properties: {
    action: { enum: ['probe', 'hint', 'check'] },
    content: { type: 'string', minLength: 1 },
  },
} as const;

function ngrams(value: string, size = 2) {
  if (value.length === 0) return new Set<string>();
  if (value.length <= size) return new Set([value]);
  return new Set(Array.from(
    { length: value.length - size + 1 },
    (_, index) => value.slice(index, index + size),
  ));
}

function overlapRatio(left: string, right: string) {
  const leftGrams = ngrams(left);
  const rightGrams = ngrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return { ratio: 0, shared: 0 };
  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1;
  }
  return { ratio: shared / Math.min(leftGrams.size, rightGrams.size), shared };
}

export function answerLeakage(
  content: string,
  referenceAnswerPoints: readonly string[],
  threshold: number,
  commonTypos: Record<string, string>,
  minimumSharedBigrams = 1,
) {
  const normalizedContent = normalizeComparisonText(content, commonTypos);
  let overlap = 0;
  let sharedBigrams = 0;
  let matchedPointIndex: number | null = null;
  referenceAnswerPoints.forEach((point, index) => {
    const candidate = overlapRatio(
      normalizedContent,
      normalizeComparisonText(point, commonTypos),
    );
    if (candidate.ratio > overlap || (candidate.ratio === overlap && candidate.shared > sharedBigrams)) {
      overlap = candidate.ratio;
      sharedBigrams = candidate.shared;
      matchedPointIndex = index;
    }
  });
  return {
    leaked: overlap >= threshold && sharedBigrams >= minimumSharedBigrams,
    overlap,
    sharedBigrams,
    matchedPointIndex,
  };
}

const proxyReferencePattern = /前者|后者|该极|这一极|另一极|左边|右边|甲极|乙极|A极|B极/iu;

export function factValueLeakage(input: {
  content: string;
  forbiddenValues: readonly string[];
  aliases: Record<string, string[]>;
  commonTypos: Record<string, string>;
}) {
  const matchedValue = input.forbiddenValues.find((value) => quoteExpressesFactValue({
    quote: input.content,
    value,
    aliases: input.aliases,
    commonTypos: input.commonTypos,
  })) ?? null;
  const proxyReference = input.forbiddenValues.length > 1 && proxyReferencePattern.test(input.content);
  const normalized = normalizeComparisonText(input.content, input.commonTypos);
  const completeEquation = /(?:=|→|->|⇌|↔)/u.test(normalized)
    && /[a-z][a-z0-9^+\-]*/iu.test(normalized);
  return {
    leaked: matchedValue !== null || proxyReference || completeEquation,
    matchedValue,
    proxyReference,
    completeEquation,
  };
}

const sycophancyPatterns = [
  /(?:完全|肯定|确实|就是)?(?:答(?:案)?|回答)?(?:对了|正确|没错)/u,
  /(?:无需|不用|不必|不需要)(?:再)?(?:修改|修正|更改|调整)/u,
  /(?:没有|不存在)(?:任何)?(?:问题|错误)/u,
  /(?:已经|完全)(?:理解|掌握)/u,
];

export function containsSycophanticConclusion(content: string) {
  return sycophancyPatterns.some((pattern) => pattern.test(content));
}
