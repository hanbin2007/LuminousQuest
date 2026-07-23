import type { LLMProvider } from '../types';
import { createDeepSeekProvider } from './deepseek';
import { MockProvider } from './mock';
import { createModelverseProvider } from './modelverse';
import { createTongyiProvider } from './tongyi';
import { createZhipuProvider } from './zhipu';

let claudeAgentModule: Promise<typeof import('./claude-agent')> | undefined;

function loadClaudeAgentModule() {
  claudeAgentModule ??= import('./claude-agent').catch((cause: unknown) => {
    throw new Error(
      'claude-agent provider is unavailable in this runtime; use LQ_LLM_PROVIDER=zhipu or switch to demo mode',
      { cause },
    );
  });
  return claudeAgentModule;
}

const lazyClaudeAgentProvider: LLMProvider = {
  id: 'claude-agent',
  async chat(request) {
    const { ClaudeAgentProvider } = await loadClaudeAgentModule();
    return new ClaudeAgentProvider().chat(request);
  },
  async vision(request) {
    const { ClaudeAgentProvider } = await loadClaudeAgentModule();
    return new ClaudeAgentProvider().vision(request);
  },
  async structured(request) {
    const { ClaudeAgentProvider } = await loadClaudeAgentModule();
    return new ClaudeAgentProvider().structured(request);
  },
};

export function createProviderRegistry(environment: NodeJS.ProcessEnv = process.env) {
  const providers = new Map<string, LLMProvider>();
  const mock = new MockProvider();
  providers.set(mock.id, mock);

  // 本机 Claude Code OAuth(钥匙串)供电,无需 key;仅本地开发/临时 live 用
  providers.set(lazyClaudeAgentProvider.id, lazyClaudeAgentProvider);

  if (environment.DEEPSEEK_API_KEY) {
    providers.set('deepseek', createDeepSeekProvider(environment.DEEPSEEK_API_KEY));
  }
  if (environment.TONGYI_API_KEY) {
    providers.set('tongyi', createTongyiProvider(environment.TONGYI_API_KEY));
  }
  if (environment.ZHIPU_API_KEY) {
    providers.set('zhipu', createZhipuProvider(environment.ZHIPU_API_KEY));
  }
  if (environment.MODELVERSE_API_KEY) {
    providers.set('modelverse', createModelverseProvider(environment.MODELVERSE_API_KEY));
  }

  return providers;
}
