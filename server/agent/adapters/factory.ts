import type { AgentTurnAdapter } from './adapter';
import { OpenAICompatibleAgentTurnAdapter } from './openai-compatible';

let claudeAgentAdapterModule:
  | Promise<typeof import('./claude-agent')>
  | undefined;

function loadClaudeAgentAdapterModule() {
  claudeAgentAdapterModule ??= import('./claude-agent');
  return claudeAgentAdapterModule;
}

const lazyClaudeAgentAdapter: AgentTurnAdapter & {
  readonly version: 'claude-agent-adapter.v1';
} = {
  id: 'claude-agent',
  version: 'claude-agent-adapter.v1',
  async execute(request) {
    const { ClaudeAgentTurnAdapter } = await loadClaudeAgentAdapterModule();
    return new ClaudeAgentTurnAdapter().execute(request);
  },
};

const openAIProviders = {
  deepseek: {
    key: 'DEEPSEEK_API_KEY',
    baseUrl: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
  },
  modelverse: {
    key: 'MODELVERSE_API_KEY',
    baseUrl: 'MODELVERSE_BASE_URL',
    defaultBaseUrl: 'https://api.modelverse.cn/v1',
  },
  tongyi: {
    key: 'TONGYI_API_KEY',
    baseUrl: 'TONGYI_BASE_URL',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  zhipu: {
    key: 'ZHIPU_API_KEY',
    baseUrl: 'ZHIPU_BASE_URL',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
} as const;

export function createAgentAdapterRegistry(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const adapters = new Map<string, AgentTurnAdapter>();
  adapters.set('claude-agent', lazyClaudeAgentAdapter);
  for (const [provider, configuration] of Object.entries(openAIProviders)) {
    const apiKey = environment[configuration.key];
    if (!apiKey) continue;
    adapters.set(provider, new OpenAICompatibleAgentTurnAdapter({
      apiKey,
      baseUrl: environment[configuration.baseUrl] ?? configuration.defaultBaseUrl,
    }));
  }
  return adapters;
}
