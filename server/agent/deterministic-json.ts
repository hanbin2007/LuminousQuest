import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === 'number' && Object.is(value, -0)) return 0;
  return value;
}

export function deterministicJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function deterministicHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(deterministicJson(value)).digest('hex')}`;
}
