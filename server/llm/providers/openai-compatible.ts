import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

interface OpenAICompatibleOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
  supportsVision: boolean;
}

function contentToString(content: unknown) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part ? String(part.text) : String(part),
      )
      .join('');
  }
  return JSON.stringify(content);
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
  }

  chat(request: LLMRequest) {
    return this.complete(request, false, false);
  }

  vision(request: LLMRequest) {
    if (!this.options.supportsVision) {
      return Promise.reject(new Error(`${this.id} vision is not enabled by this adapter`));
    }
    return this.complete(request, true, false);
  }

  structured(request: LLMRequest) {
    return this.complete(request, request.images.length > 0, true);
  }

  private async complete(
    request: LLMRequest,
    includeImages: boolean,
    structured: boolean,
  ): Promise<LLMResponse> {
    const userText = JSON.stringify(request.input);
    const userContent = includeImages
      ? [
          { type: 'text', text: userText },
          ...request.images.map((image) => ({
            type: 'image_url',
            image_url: {
              url: image.data.startsWith('data:')
                ? image.data
                : `data:${image.mediaType};base64,${image.data}`,
            },
          })),
        ]
      : userText;
    const schemaInstruction = structured
      ? `\nReturn JSON matching this schema exactly:\n${JSON.stringify(request.schema)}`
      : '';
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: 'system', content: `${request.prompt.text}${schemaInstruction}` },
          { role: 'user', content: userContent },
        ],
        ...(structured ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 20_000)),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`${this.id} returned HTTP ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = contentToString(payload.choices?.[0]?.message?.content ?? '');
    if (!content) throw new Error(`${this.id} returned an empty response`);

    return {
      content,
      model: request.model,
      usage: {
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
      },
    };
  }
}

