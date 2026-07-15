import { hashValue } from './cache-key';

export type RecordingRedactor = (value: unknown) => unknown;

const secretKeyPattern = /authorization|api[-_]?key|secret|token|cookie/i;

export const defaultRecordingRedactor: RecordingRedactor = (value) => {
  function visit(entry: unknown, parentKey = ''): unknown {
    if (secretKeyPattern.test(parentKey)) return '[REDACTED]';
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    if (entry && typeof entry === 'object') {
      const object = entry as Record<string, unknown>;
      if (
        typeof object.data === 'string' &&
        typeof object.mediaType === 'string' &&
        object.mediaType.startsWith('image/')
      ) {
        return {
          ...Object.fromEntries(
            Object.entries(object)
              .filter(([key]) => key !== 'data')
              .map(([key, item]) => [key, visit(item, key)]),
          ),
          data: `[IMAGE SHA256:${hashValue(object.data)}]`,
        };
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, item]) => [key, visit(item, key)]),
      );
    }
    return entry;
  }

  return visit(value);
};

