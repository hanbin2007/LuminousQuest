import type { LoadedConfig } from '../../shared/config/schemas';
import type { StudentSession } from '../../shared/session/schema';

export interface ExtractAssessmentInput {
  sessionId: string;
  caseId: string;
  nodeId: string;
  studentAnswer: string;
}

export interface AppRuntime {
  loadConfig: () => Promise<LoadedConfig>;
  extractAssessment: (input: ExtractAssessmentInput) => Promise<{ session: StudentSession | null }>;
  reviewDrawing: (imageData: string) => Promise<string>;
}

declare global {
  // Injected by the integrated Hono server for protected, same-origin API calls.
  // eslint-disable-next-line no-var
  var __LQ_API_TOKEN__: string | undefined;
}

function protectedHeaders() {
  return {
    'content-type': 'application/json',
    'x-lq-api-token': globalThis.__LQ_API_TOKEN__ ?? '',
  };
}

async function jsonResponse<T>(response: Response) {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed with status ${response.status}`);
  return value;
}

export const defaultRuntime: AppRuntime = {
  async loadConfig() {
    return jsonResponse<LoadedConfig>(await fetch('/api/config'));
  },

  async extractAssessment(input) {
    const response = await fetch('/api/assessment/extract', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify(input),
    });
    return jsonResponse<{ session: StudentSession }>(response);
  },

  async reviewDrawing(imageData) {
    const response = await fetch('/api/llm', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify({
        executionMode: 'development',
        capability: 'vision',
        provider: 'mock',
        model: 'mock-v1',
        prompt: { id: 'hand-drawing-feedback' },
        schemaVersion: 'hand-drawing-feedback.v1',
        input: { task: '只用自然语言点评手绘表达，不判分，不写入学习者画像。' },
        images: [{ mediaType: 'image/png', data: imageData }],
      }),
    });
    const result = await jsonResponse<{ response: { content: string } }>(response);
    if (result.response.content.startsWith('Mock vision extraction')) {
      return '已收到手绘表达。请再检查电子路径与离子路径是否分别闭合，方向标注是否彼此一致。';
    }
    return result.response.content;
  },
};
