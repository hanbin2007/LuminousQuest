import { OpenAICompatibleProvider } from './openai-compatible';

export function createTongyiProvider(apiKey: string) {
  return new OpenAICompatibleProvider({
    id: 'tongyi',
    apiKey,
    baseUrl:
      process.env.TONGYI_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    supportsVision: true,
  });
}

