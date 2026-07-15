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

function imageBytes(data: string) {
  const dataUrl = /^data:[^;,]+(;base64)?,([\s\S]*)$/.exec(data);
  if (dataUrl) {
    return dataUrl[1]
      ? Buffer.from(dataUrl[2], 'base64')
      : Buffer.from(decodeURIComponent(dataUrl[2]), 'utf8');
  }
  const compact = data.replace(/\s/g, '');
  const looksLikeBase64 = compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
  return looksLikeBase64 ? Buffer.from(compact, 'base64') : Buffer.from(data, 'utf8');
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
    temperature: request.temperature,
    schema: request.schema,
    input: request.input,
    imageHashes: request.images.map((image) => ({
      mediaType: image.mediaType,
      sha256: hashValue(imageBytes(image.data)),
    })),
  });

  return hashValue(JSON.stringify(material));
}
