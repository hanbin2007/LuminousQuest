import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

function exampleForSchema(schema: Record<string, unknown> | undefined): unknown {
  if (!schema) return { status: 'unassessed', reason: 'mock schema was not supplied' };
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, exampleForSchema(value)]));
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  return 'mock';
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

