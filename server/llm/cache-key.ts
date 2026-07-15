import { createHash } from 'node:crypto';

import type { LLMRequest } from './types';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === 'number' && Object.is(value, -0)) return 0;
  return value;
}

export function hashValue(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function createDevelopmentCacheKey(request: LLMRequest) {
  const material = canonicalize({
    provider: request.provider,
    model: request.model,
    capability: request.capability,
    prompt: {
      id: request.prompt.id,
      version: request.prompt.version,
      text: request.prompt.text,
    },
    schemaVersion: request.schemaVersion,
    configVersion: request.configVersion,
    schema: request.schema,
    input: request.input,
    imageHashes: request.images.map((image) => ({
      mediaType: image.mediaType,
      sha256: hashValue(image.data),
    })),
  });

  return hashValue(JSON.stringify(material));
}

