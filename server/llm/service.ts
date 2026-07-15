import Ajv from 'ajv';

import { createDevelopmentCacheKey } from './cache-key';
import {
  ProviderTimeoutError,
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

export interface StructuredValidationContext {
  source: 'provider' | 'development-cache' | 'demo-recording';
  attempt: number;
}

export interface LLMExecutionOptions {
  retryCount?: number;
  timeoutMs?: number;
  validateStructured?: (
    value: unknown,
    context: StructuredValidationContext,
  ) => unknown | Promise<unknown>;
}

const publicFailureMessage = 'AI service is temporarily unavailable';

export class LLMService {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly logger: LLMServiceLogger;

  constructor(private readonly options: LLMServiceOptions) {
    this.logger = options.logger ?? console;
  }

  async execute(
    request: LLMRequest,
    executionOptions: LLMExecutionOptions = {},
  ): Promise<LLMExecutionResult> {
    const cacheKey = createDevelopmentCacheKey(request);

    if (request.executionMode === 'demo') {
      let failure: Error | undefined;
      if (request.stepId) {
        const demoResponse = await this.options.recordings.getDemo(request.stepId);
        if (demoResponse) {
          try {
            await this.validateStructuredResponse(
              request,
              demoResponse,
              executionOptions.validateStructured,
              { source: 'demo-recording', attempt: 0 },
            );
            return this.result('demo-recording', demoResponse, cacheKey);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            this.logFailure(request, 1, error);
          }
        }
      }
      return this.fallback(
        request,
        cacheKey,
        failure,
        failure ? undefined : 'replay-missing',
      );
    }

    if (request.executionMode === 'development') {
      const cachedResponse = await this.options.recordings.getDevelopment(cacheKey);
      if (cachedResponse) {
        try {
          await this.validateStructuredResponse(
            request,
            cachedResponse,
            executionOptions.validateStructured,
            { source: 'development-cache', attempt: 0 },
          );
          return this.result('development-cache', cachedResponse, cacheKey);
        } catch (error) {
          this.logFailure(request, 0, error);
          if (error instanceof StructuredResponseValidationError && !error.retryable) {
            return this.fallback(request, cacheKey, error);
          }
        }
      }
    }

    const provider = this.options.providers.get(request.provider);
    let finalError: Error | undefined;
    let providerResponse: LLMResponse | undefined;

    if (provider) {
      const retryCount = Number.isInteger(executionOptions.retryCount)
        ? Math.min(3, Math.max(0, executionOptions.retryCount!))
        : 1;
      for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
        try {
          const response = await this.callProvider(provider, request, executionOptions.timeoutMs);
          await this.validateStructuredResponse(
            request,
            response,
            executionOptions.validateStructured,
            { source: 'provider', attempt },
          );
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

    const validationBlocksReplay = finalError instanceof StructuredResponseValidationError
      && !finalError.retryable;
    if (request.stepId && !validationBlocksReplay) {
      const demoResponse = await this.options.recordings.getDemo(request.stepId);
      if (demoResponse) {
        try {
          await this.validateStructuredResponse(
            request,
            demoResponse,
            executionOptions.validateStructured,
            { source: 'demo-recording', attempt: 0 },
          );
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

  private fallback(
    request: LLMRequest,
    cacheKey: string,
    failure?: Error,
    failureReason = this.failureReason(failure),
  ): LLMExecutionResult {
    return {
      source: 'fallback',
      cacheKey,
      degraded: true,
      requiresTeacherReview: request.capability === 'structured',
      error: publicFailureMessage,
      ...(failureReason ? { failureReason } : {}),
      response: {
        content:
          request.capability === 'structured'
            ? '本项暂时无法可靠抽取,已标记为待教师复核。'
            : 'AI 服务暂时不可用,请保留当前作答并稍后重试。',
        model: 'preset-fallback.v1',
        ...(request.capability === 'structured'
          ? { structured: { status: 'needs-review', reason: 'provider unavailable or invalid' } }
          : {}),
      },
    };
  }

  private shouldRetry(error: Error) {
    if (error instanceof StructuredResponseValidationError) return error.retryable;
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

  private async callProvider(provider: LLMProvider, request: LLMRequest, timeoutMs?: number) {
    const effectiveRequest = timeoutMs === undefined ? request : { ...request, timeoutMs };
    const operation = request.capability === 'chat'
      ? provider.chat(effectiveRequest)
      : request.capability === 'vision'
        ? provider.vision(effectiveRequest)
        : provider.structured(effectiveRequest);
    if (timeoutMs === undefined) return operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ProviderTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async validateStructuredResponse(
    request: LLMRequest,
    response: LLMResponse,
    validateStructured: LLMExecutionOptions['validateStructured'],
    context: StructuredValidationContext,
  ) {
    if (request.capability !== 'structured') return;
    if (!request.schema) {
      throw new StructuredResponseValidationError(
        'Structured requests require a JSON schema',
        { retryable: false, category: 'schema-definition' },
      );
    }

    let structured = response.structured;
    if (structured === undefined) {
      try {
        structured = JSON.parse(response.content);
      } catch {
        throw new StructuredResponseValidationError(
          'Provider returned invalid JSON for a structured request',
          { category: 'invalid-json' },
        );
      }
    }

    try {
      const validate = this.ajv.compile(request.schema);
      if (!validate(structured)) {
        throw new StructuredResponseValidationError(
          `Provider response failed schema validation: ${this.ajv.errorsText(validate.errors)}`,
          { category: 'schema-invalid' },
        );
      }
    } catch (error) {
      if (error instanceof StructuredResponseValidationError) throw error;
      throw new StructuredResponseValidationError(
        `Invalid structured response schema: ${(error as Error).message}`,
        { retryable: false, category: 'schema-definition' },
      );
    }
    response.structured = validateStructured
      ? await validateStructured(structured, context)
      : structured;
  }

  private failureReason(error?: Error) {
    if (!error) return undefined;
    if (error instanceof StructuredResponseValidationError) return error.category;
    if (error instanceof ProviderTimeoutError || error.name === 'TimeoutError') return 'timeout';
    if (error instanceof ProviderHttpError) return 'http-error';
    if (error instanceof UnsupportedCapabilityError) return 'unsupported-capability';
    return 'provider-error';
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
