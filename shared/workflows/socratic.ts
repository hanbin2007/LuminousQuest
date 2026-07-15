import { z } from 'zod';

import { normalizeComparisonText } from './extraction-validation';

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
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1;
  }
  return shared / Math.min(leftGrams.size, rightGrams.size);
}

export function answerLeakage(
  content: string,
  referenceAnswerPoints: readonly string[],
  threshold: number,
  commonTypos: Record<string, string>,
) {
  const normalizedContent = normalizeComparisonText(content, commonTypos);
  let overlap = 0;
  let matchedPointIndex: number | null = null;
  referenceAnswerPoints.forEach((point, index) => {
    const candidate = overlapRatio(
      normalizedContent,
      normalizeComparisonText(point, commonTypos),
    );
    if (candidate > overlap) {
      overlap = candidate;
      matchedPointIndex = index;
    }
  });
  return {
    leaked: overlap >= threshold,
    overlap,
    matchedPointIndex,
  };
}
