import Ajv from 'ajv';

import { createDevelopmentCacheKey } from './cache-key';
import {
  ProviderHttpError,
  StructuredResponseValidationError,
  UnsupportedCapabilityError,
} from './errors';
import type { RecordingStore } from './recording-store';
import type {
  LLMExecutionResult,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from './types';

export interface LLMServiceLogger {
  error(message: string): void;
  warn(message: string): void;
}

export interface LLMServiceOptions {
  providers: Map<string, LLMProvider>;
  recordings: RecordingStore;
  logger?: LLMServiceLogger;
}

const publicFailureMessage = 'AI service is temporarily unavailable';

export class LLMService {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly logger: LLMServiceLogger;

  constructor(private readonly options: LLMServiceOptions) {
    this.logger = options.logger ?? console;
  }

  async execute(request: LLMRequest): Promise<LLMExecutionResult> {
    const cacheKey = createDevelopmentCacheKey(request);

    if (request.executionMode === 'demo') {
      if (request.stepId) {
        const demoResponse = await this.options.recordings.getDemo(request.stepId);
        if (demoResponse) {
          try {
            this.validateStructuredResponse(request, demoResponse);
            return this.result('demo-recording', demoResponse, cacheKey);
          } catch (error) {
            this.logFailure(request, 1, error);
          }
        }
      }
      return this.fallback(request, cacheKey);
    }

    if (request.executionMode === 'development') {
      const cachedResponse = await this.options.recordings.getDevelopment(cacheKey);
      if (cachedResponse) {
        try {
          this.validateStructuredResponse(request, cachedResponse);
          return this.result('development-cache', cachedResponse, cacheKey);
        } catch (error) {
          this.logFailure(request, 0, error);
        }
      }
    }

    const provider = this.options.providers.get(request.provider);
    let finalError: Error | undefined;
    let providerResponse: LLMResponse | undefined;

    if (provider) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await this.callProvider(provider, request);
          this.validateStructuredResponse(request, response);
          providerResponse = response;
          break;
        } catch (error) {
          finalError = error instanceof Error ? error : new Error(String(error));
          this.logFailure(request, attempt, finalError);
          if (!this.shouldRetry(finalError)) break;
        }
      }
    } else {
      finalError = new Error(`Provider ${request.provider} is not configured`);
      this.logFailure(request, 0, finalError);
    }

    if (providerResponse) {
      if (request.executionMode === 'development') {
        try {
          await this.options.recordings.saveDevelopment(cacheKey, request, providerResponse);
        } catch (error) {
          this.logger.warn(
            `[llm] cache write failed for ${request.provider}/${request.model}: ${(error as Error).message}`,
          );
        }
      }
      return this.result('provider', providerResponse, cacheKey);
    }

    if (request.stepId) {
      const demoResponse = await this.options.recordings.getDemo(request.stepId);
      if (demoResponse) {
        try {
          this.validateStructuredResponse(request, demoResponse);
          return {
            ...this.result('demo-recording', demoResponse, cacheKey),
            degraded: true,
            error: publicFailureMessage,
          };
        } catch (error) {
          finalError = error instanceof Error ? error : new Error(String(error));
          this.logFailure(request, 0, finalError);
        }
      }
    }

    return this.fallback(request, cacheKey, finalError);
  }

  private fallback(request: LLMRequest, cacheKey: string, _failure?: Error): LLMExecutionResult {
    return {
      source: 'fallback',
      cacheKey,
      degraded: true,
      requiresTeacherReview: request.capability === 'structured',
      error: publicFailureMessage,
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

  private shouldRetry(error: Error) {
    if (error instanceof StructuredResponseValidationError) return false;
    if (error instanceof UnsupportedCapabilityError) return false;
    if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) return false;
    return true;
  }

  private logFailure(request: LLMRequest, attempt: number, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `[llm] ${request.provider}/${request.model} ${request.capability} attempt ${attempt}: ${detail}`,
    );
  }

  private callProvider(provider: LLMProvider, request: LLMRequest) {
    if (request.capability === 'chat') return provider.chat(request);
    if (request.capability === 'vision') return provider.vision(request);
    return provider.structured(request);
  }

  private validateStructuredResponse(request: LLMRequest, response: LLMResponse) {
    if (request.capability !== 'structured') return;
    if (!request.schema) {
      throw new StructuredResponseValidationError('Structured requests require a JSON schema');
    }

    let structured = response.structured;
    if (structured === undefined) {
      try {
        structured = JSON.parse(response.content);
      } catch {
        throw new StructuredResponseValidationError(
          'Provider returned invalid JSON for a structured request',
        );
      }
    }

    try {
      const validate = this.ajv.compile(request.schema);
      if (!validate(structured)) {
        throw new StructuredResponseValidationError(
          `Provider response failed schema validation: ${this.ajv.errorsText(validate.errors)}`,
        );
      }
    } catch (error) {
      if (error instanceof StructuredResponseValidationError) throw error;
      throw new StructuredResponseValidationError(`Invalid structured response schema: ${(error as Error).message}`);
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
