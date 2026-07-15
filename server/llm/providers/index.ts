import type { LLMProvider } from '../types';
import { createDeepSeekProvider } from './deepseek';
import { MockProvider } from './mock';
import { createTongyiProvider } from './tongyi';
import { createZhipuProvider } from './zhipu';

export function createProviderRegistry(environment: NodeJS.ProcessEnv = process.env) {
  const providers = new Map<string, LLMProvider>();
  const mock = new MockProvider();
  providers.set(mock.id, mock);

  if (environment.DEEPSEEK_API_KEY) {
    providers.set('deepseek', createDeepSeekProvider(environment.DEEPSEEK_API_KEY));
  }
  if (environment.TONGYI_API_KEY) {
    providers.set('tongyi', createTongyiProvider(environment.TONGYI_API_KEY));
  }
  if (environment.ZHIPU_API_KEY) {
    providers.set('zhipu', createZhipuProvider(environment.ZHIPU_API_KEY));
  }

  return providers;
}

