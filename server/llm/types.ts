export type LLMCapability = 'chat' | 'vision' | 'structured';
export type LLMExecutionMode = 'live' | 'development' | 'demo';

export interface LLMImage {
  mediaType: string;
  data: string;
}

export interface LLMRequest {
  executionMode: LLMExecutionMode;
  capability: LLMCapability;
  provider: string;
  model: string;
  prompt: {
    id: string;
    version: string;
    text: string;
  };
  schemaVersion: string;
  configVersion: string;
  input: unknown;
  images: LLMImage[];
  schema?: Record<string, unknown>;
  stepId?: string;
  timeoutMs?: number;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  structured?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface LLMProvider {
  readonly id: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
  vision(request: LLMRequest): Promise<LLMResponse>;
  structured(request: LLMRequest): Promise<LLMResponse>;
}

export interface LLMExecutionResult {
  source: 'provider' | 'development-cache' | 'demo-recording' | 'fallback';
  response: LLMResponse;
  cacheKey: string;
  degraded: boolean;
  requiresTeacherReview: boolean;
  error?: string;
  failureReason?: string;
}
