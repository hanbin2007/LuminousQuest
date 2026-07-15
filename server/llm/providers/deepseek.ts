import { OpenAICompatibleProvider } from './openai-compatible';

export function createDeepSeekProvider(apiKey: string) {
  return new OpenAICompatibleProvider({
    id: 'deepseek',
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    supportsVision: false,
  });
}

