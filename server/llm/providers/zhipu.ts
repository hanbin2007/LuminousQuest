import { OpenAICompatibleProvider } from './openai-compatible';

export function createZhipuProvider(apiKey: string) {
  return new OpenAICompatibleProvider({
    id: 'zhipu',
    apiKey,
    baseUrl: process.env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
    supportsVision: true,
  });
}

