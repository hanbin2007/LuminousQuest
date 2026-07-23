import { OpenAICompatibleProvider } from './openai-compatible';

// 优云智算 Modelverse:非 Claude 系模型(GLM/DeepSeek 等)走 OpenAI 兼容端点
export function createModelverseProvider(apiKey: string) {
  return new OpenAICompatibleProvider({
    id: 'modelverse',
    apiKey,
    baseUrl: process.env.MODELVERSE_BASE_URL ?? 'https://api.modelverse.cn/v1',
    supportsVision: false,
  });
}
