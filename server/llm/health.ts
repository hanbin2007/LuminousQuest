import {
  ProviderHttpError,
  ProviderTimeoutError,
  UnsupportedCapabilityError,
} from './errors';
import type { LLMExecutionMode, LLMProvider, LLMRequest } from './types';
import {
  AgentTurnAdapterError,
  type AgentTurnAdapter,
} from '../agent/adapters/adapter';
import { deterministicHash } from '../agent/deterministic-json';
import { createAgentToolDefinitions } from '../agent/tools';

export type LLMHealthStatus = 'ok' | 'degraded' | 'down';

export interface LLMHealthResult {
  provider: string;
  model: string;
  status: LLMHealthStatus;
  detail: string;
}

interface LLMHealthConfiguration {
  executionMode: LLMExecutionMode;
  provider: string;
  model: string;
}

interface LLMHealthMonitorOptions {
  providers: Map<string, LLMProvider>;
  agentAdapters?: Map<string, AgentTurnAdapter>;
  configuration: () => LLMHealthConfiguration;
  now?: () => number;
  ttlMs?: number;
}

interface CachedHealth {
  expiresAt: number;
  result: LLMHealthResult;
}

const healthPrompt = {
  id: 'llm-health',
  version: 'llm-health.v1',
  text: 'Return only {"ok":true}.',
};

const healthSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', const: true },
  },
} as const;

export function classifyLLMHealthError(
  provider: string,
  error: unknown,
): Pick<LLMHealthResult, 'status' | 'detail'> {
  const providerLabel = provider === 'modelverse' ? 'Modelverse' : provider;
  if (
    error instanceof ProviderTimeoutError
    || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
  ) {
    return { status: 'degraded', detail: `${provider} 探活超时，请稍后重试` };
  }
  if (
    error instanceof AgentTurnAdapterError
    && error.category === 'http-error'
    && error.httpStatus !== undefined
  ) {
    return classifyLLMHealthError(
      provider,
      new ProviderHttpError(provider, error.httpStatus, error.detail ?? ''),
    );
  }
  if (error instanceof ProviderHttpError) {
    const balanceFailure = error.status === 402 || (
      error.status === 403
      && /account[\s_-]*overdue|overdue|insufficient[\s_-]*(?:balance|funds?|credit)|balance[\s_-]*(?:insufficient|exhausted|depleted)|quota[\s_-]*(?:exhausted|depleted)|余额不足|欠费|充值/iu
        .test(error.detail)
    );
    if (balanceFailure) {
      return {
        status: 'down',
        detail: `${providerLabel} 账户余额不足或已欠费，请充值后重试`,
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        status: 'down',
        detail: `${providerLabel} 认证或访问权限失败，请检查 API Key`,
      };
    }
    if (error.status === 429) {
      return { status: 'degraded', detail: `${providerLabel} 请求受限，请稍后重试` };
    }
    if (error.status >= 500) {
      return { status: 'degraded', detail: `${providerLabel} 服务暂时不可用，请稍后重试` };
    }
    return {
      status: 'down',
      detail: `${providerLabel} 探活请求被拒绝（HTTP ${error.status}）`,
    };
  }
  if (error instanceof UnsupportedCapabilityError) {
    return { status: 'down', detail: `${providerLabel} 不支持应用所需的 AI 能力` };
  }
  if (error instanceof TypeError) {
    return { status: 'degraded', detail: `${providerLabel} 网络连接失败，请检查网络后重试` };
  }
  return { status: 'down', detail: `${providerLabel} 通道不可用，请检查服务配置` };
}

export class LLMHealthMonitor {
  private readonly cache = new Map<string, CachedHealth>();
  private readonly inFlight = new Map<string, Promise<LLMHealthResult>>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: LLMHealthMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  async get(): Promise<LLMHealthResult> {
    const configuration = this.options.configuration();
    const key = [
      configuration.executionMode,
      configuration.provider,
      configuration.model,
    ].join('\u0000');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.result;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const probe = this.probe(configuration)
      .then((result) => {
        this.cache.set(key, { result, expiresAt: this.now() + this.ttlMs });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, probe);
    return probe;
  }

  private async probe(configuration: LLMHealthConfiguration): Promise<LLMHealthResult> {
    const base = { provider: configuration.provider, model: configuration.model };
    if (configuration.executionMode === 'demo') {
      return {
        ...base,
        status: 'degraded',
        detail: '演示回放模式，未调用在线 AI',
      };
    }
    if (configuration.provider === 'mock') {
      return {
        ...base,
        status: 'degraded',
        detail: 'Mock 演示通道已启用，未调用在线 AI',
      };
    }

    const provider = this.options.providers.get(configuration.provider);
    const agentAdapter = this.options.agentAdapters?.get(configuration.provider);
    if (!provider && !agentAdapter) {
      return {
        ...base,
        status: 'down',
        detail: `${configuration.provider} 未配置或缺少访问凭据`,
      };
    }

    const request: LLMRequest = {
      executionMode: 'live',
      capability: 'structured',
      provider: configuration.provider,
      model: configuration.model,
      prompt: healthPrompt,
      schemaVersion: 'llm-health.v1',
      configVersion: 'llm-health',
      input: {},
      images: [],
      schema: structuredClone(healthSchema),
      temperature: 0,
      timeoutMs: healthTimeoutMilliseconds(),
    };
    try {
      if (agentAdapter) {
        const tools = createAgentToolDefinitions().filter(
          (definition) => definition.name === 'end_case',
        );
        const requestHash = deterministicHash({
          probe: 'agent-tool-call-canary.v1',
          provider: configuration.provider,
          model: configuration.model,
          tools,
        });
        let observedCanaryToolCall = false;
        const result = await agentAdapter.execute({
          requestHash,
          model: configuration.model,
          systemPrompt:
            'Health canary: call end_case exactly once with summary "health-canary".',
          messages: [{
            role: 'user',
            content: 'Run the required tool-call canary now.',
          }],
          tools,
          maxTurns: 4,
          signal: AbortSignal.timeout(healthTimeoutMilliseconds()),
          executeTool: async (action) => {
            const accepted = action.name === 'end_case'
              && action.arguments.summary === 'health-canary';
            if (accepted) observedCanaryToolCall = true;
            return {
              accepted,
              action,
              content: JSON.stringify({ ok: accepted }),
              ...(accepted ? {} : { errorCategory: 'wrong-canary-tool' }),
            };
          },
        });
        if (
          !observedCanaryToolCall
          || result.terminalAction.name !== 'end_case'
          || !result.orderedActions.some((action) => action.name === 'end_case')
        ) {
          throw new Error('Provider did not complete the tool-call canary');
        }
        return {
          ...base,
          status: 'ok',
          detail: '实时 AI 工具调用通道可用',
        };
      }
      if (!provider) {
        throw new Error('Structured provider is not configured');
      }
      const response = await provider.structured(request);
      const value = response.structured ?? JSON.parse(response.content);
      if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) {
        throw new Error('Provider returned an invalid health response');
      }
      return {
        ...base,
        status: 'ok',
        detail: '实时 AI 通道可用',
      };
    } catch (error) {
      return {
        ...base,
        ...classifyLLMHealthError(configuration.provider, error),
      };
    }
  }
}

function healthTimeoutMilliseconds() {
  const configured = Number(process.env.LLM_TIMEOUT_MS ?? 20_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
}
