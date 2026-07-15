import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

function exampleForSchema(schema: Record<string, unknown> | undefined): unknown {
  if (!schema) return { status: 'unassessed', reason: 'mock schema was not supplied' };
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const alternatives = (schema.oneOf ?? schema.anyOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(alternatives) && alternatives.length > 0) return exampleForSchema(alternatives[0]);
  if (schema.type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, exampleForSchema(value)]));
  }
  if (schema.type === 'array') {
    const count = typeof schema.minItems === 'number' ? Math.max(0, schema.minItems) : 0;
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    return Array.from({ length: count }, () => exampleForSchema(itemSchema));
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
    const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
    let value = minimum ?? 0;
    if (maximum !== undefined) value = Math.min(value, maximum);
    return schema.type === 'integer' ? Math.ceil(value) : value;
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'null') return null;
  if (schema.format === 'date-time') return '2026-07-15T00:00:00.000Z';
  const minimumLength = typeof schema.minLength === 'number' ? schema.minLength : 0;
  return 'mock'.padEnd(minimumLength, 'x');
}

export class MockProvider implements LLMProvider {
  readonly id = 'mock';

  async chat(request: LLMRequest): Promise<LLMResponse> {
    return {
      content: `Mock response for ${request.prompt.id}`,
      model: request.model || 'mock-v1',
    };
  }

  async vision(request: LLMRequest): Promise<LLMResponse> {
    return {
      content: `Mock vision extraction for ${request.images.length} image(s)`,
      model: request.model || 'mock-v1',
    };
  }

  async structured(request: LLMRequest): Promise<LLMResponse> {
    const input = request.input as { mockStructuredResponse?: unknown } | null;
    const value = input?.mockStructuredResponse ?? exampleForSchema(request.schema);
    return {
      content: JSON.stringify(value),
      structured: value,
      model: request.model || 'mock-v1',
    };
  }
}
