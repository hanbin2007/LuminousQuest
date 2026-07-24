import type { LLMExecutionMode } from './types';

const defaultModels: Record<string, string> = {
  'claude-agent': 'claude-sonnet-5',
  deepseek: 'deepseek-chat',
  mock: 'mock-v1',
  modelverse: 'glm-5.2',
  tongyi: 'qwen-plus',
  unconfigured: 'unconfigured',
  zhipu: 'glm-4-flash',
};

function configuredValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function inferConfiguredProvider(environment: NodeJS.ProcessEnv) {
  const selected = configuredValue(environment.LQ_LLM_PROVIDER);
  if (selected) return selected;
  // The Claude Agent SDK authenticates through the local Claude OAuth session;
  // it intentionally does not require an API key. Other configured provider
  // keys remain available only through an explicit LQ_LLM_PROVIDER selection.
  return 'claude-agent';
}

export function defaultModelForProvider(provider: string) {
  return defaultModels[provider] ?? `${provider}-default`;
}

export function resolveLLMConfiguration(input: {
  environment: NodeJS.ProcessEnv;
  lockDemo: boolean;
  executionMode?: LLMExecutionMode;
  provider?: string;
  model?: string;
}) {
  const provider = configuredValue(input.provider)
    ?? inferConfiguredProvider(input.environment);
  const model = configuredValue(input.model)
    ?? configuredValue(input.environment.LQ_LLM_MODEL)
    ?? defaultModelForProvider(provider);
  const requestedMode = input.lockDemo
    ? 'demo'
    : input.executionMode ?? configuredValue(input.environment.LQ_LLM_EXECUTION_MODE);
  const executionMode: LLMExecutionMode = requestedMode === 'live'
    || requestedMode === 'development'
    || requestedMode === 'demo'
    ? requestedMode
    : provider === 'mock' ? 'development' : 'live';
  return { executionMode, provider, model };
}
