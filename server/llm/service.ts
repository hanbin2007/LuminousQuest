import Ajv from 'ajv';

import { createDevelopmentCacheKey } from './cache-key';
import type { RecordingStore } from './recording-store';
import type {
  LLMExecutionResult,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from './types';

export interface LLMServiceOptions {
  providers: Map<string, LLMProvider>;
  recordings: RecordingStore;
}

export class LLMService {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(private readonly options: LLMServiceOptions) {}

  async execute(request: LLMRequest): Promise<LLMExecutionResult> {
    const cacheKey = createDevelopmentCacheKey(request);

    if (request.executionMode === 'demo' && request.stepId) {
      const demoResponse = await this.options.recordings.getDemo(request.stepId);
      if (demoResponse) return this.result('demo-recording', demoResponse, cacheKey);
    }

    if (request.executionMode === 'development') {
      const cachedResponse = await this.options.recordings.getDevelopment(cacheKey);
      if (cachedResponse) return this.result('development-cache', cachedResponse, cacheKey);
    }

    const provider = this.options.providers.get(request.provider);
    let finalError: Error | undefined;

    if (provider) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await this.callProvider(provider, request);
          this.validateStructuredResponse(request, response);
          if (request.executionMode === 'development') {
            await this.options.recordings.saveDevelopment(cacheKey, request, response);
          }
          return this.result('provider', response, cacheKey);
        } catch (error) {
          finalError = error instanceof Error ? error : new Error(String(error));
        }
      }
    } else {
      finalError = new Error(`Provider ${request.provider} is not configured`);
    }

    const failure = finalError ?? new Error('LLM provider failed without an error');

    if (request.stepId && request.executionMode !== 'demo') {
      const demoResponse = await this.options.recordings.getDemo(request.stepId);
      if (demoResponse) {
        return {
          ...this.result('demo-recording', demoResponse, cacheKey),
          degraded: true,
          error: failure.message,
        };
      }
    }

    return {
      source: 'fallback',
      cacheKey,
      degraded: true,
      requiresTeacherReview: request.capability === 'structured',
      error: failure.message,
      response: {
        content:
          request.capability === 'structured'
            ? '本项暂时无法可靠抽取,已标记为待教师复核。'
            : 'AI 服务暂时不可用,请保留当前作答并稍后重试。',
        model: 'preset-fallback.v1',
        ...(request.capability === 'structured'
          ? { structured: { status: 'unassessed', reason: 'provider unavailable or invalid' } }
          : {}),
      },
    };
  }

  private callProvider(provider: LLMProvider, request: LLMRequest) {
    if (request.capability === 'chat') return provider.chat(request);
    if (request.capability === 'vision') return provider.vision(request);
    return provider.structured(request);
  }

  private validateStructuredResponse(request: LLMRequest, response: LLMResponse) {
    if (request.capability !== 'structured') return;
    if (!request.schema) throw new Error('Structured requests require a JSON schema');

    let structured = response.structured;
    if (structured === undefined) {
      try {
        structured = JSON.parse(response.content);
      } catch {
        throw new Error('Provider returned invalid JSON for a structured request');
      }
    }

    const validate = this.ajv.compile(request.schema);
    if (!validate(structured)) {
      throw new Error(`Provider response failed schema validation: ${this.ajv.errorsText(validate.errors)}`);
    }
    response.structured = structured;
  }

  private result(
    source: LLMExecutionResult['source'],
    response: LLMResponse,
    cacheKey: string,
  ): LLMExecutionResult {
    return {
      source,
      response,
      cacheKey,
      degraded: false,
      requiresTeacherReview: false,
    };
  }
}
