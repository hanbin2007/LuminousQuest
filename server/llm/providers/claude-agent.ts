import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { LLMProvider, LLMRequest, LLMResponse } from '../types';

/**
 * Claude Agent SDK provider——走本机 Claude Code 的 OAuth 凭据(钥匙串),无需 API key。
 *
 * 用途:在拿到国内厂商 key 之前跑通 live 链路(判分抽取/辅导/手绘点评)。
 * 判分是单轮纯补全:禁用全部工具、maxTurns=1、不加载本机 settings/CLAUDE.md,
 * 与其它 provider 一样只消费 prompt.text(system)+ JSON 化 input(user)。
 * request.timeoutMs 原样作为 SDK abort 截止时间,未提供时缺省为 60s。
 * temperature 被忽略(Opus 4.8 系不接受采样参数;判分确定性由规则层保证)。
 * 切换到 GLM-5.2 等厂商时只需改 LQ_LLM_PROVIDER/LQ_LLM_MODEL,本文件无需改动。
 */
export class ClaudeAgentProvider implements LLMProvider {
  readonly id = 'claude-agent';

  chat(request: LLMRequest) {
    return this.complete(request, false, false);
  }

  vision(request: LLMRequest) {
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
    const schemaInstruction = structured
      ? `\nReturn JSON matching this schema exactly. Output only the JSON object, no prose, no code fences:\n${JSON.stringify(request.schema)}`
      : '';
    const systemPrompt = `${request.prompt.text}${schemaInstruction}`;
    const userText = JSON.stringify(request.input);

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.timeoutMilliseconds(request.timeoutMs));

    try {
      const conversation = query({
        prompt: this.userMessages(userText, includeImages ? request.images : []),
        options: {
          model: request.model,
          systemPrompt,
          maxTurns: 1,
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          abortController: abort,
        },
      });

      for await (const message of conversation) {
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new Error(`claude-agent run failed: ${message.subtype}`);
        }
        const content = message.result.trim();
        if (!content) throw new Error('claude-agent returned an empty response');
        return {
          content: structured ? stripCodeFence(content) : content,
          model: request.model,
          usage: {
            inputTokens: message.usage?.input_tokens,
            outputTokens: message.usage?.output_tokens,
          },
        };
      }
      throw new Error('claude-agent produced no result message');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async *userMessages(
    text: string,
    images: LLMRequest['images'],
  ): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [
          ...images.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType as 'image/png',
              data: image.data.startsWith('data:')
                ? image.data.slice(image.data.indexOf(',') + 1)
                : image.data,
            },
          })),
          { type: 'text' as const, text },
        ],
      },
      parent_tool_use_id: null,
      session_id: '',
    };
  }

  private timeoutMilliseconds(requestTimeout?: number) {
    const configured = Number(requestTimeout ?? process.env.LLM_TIMEOUT_MS ?? 60_000);
    return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  }
}

function stripCodeFence(content: string) {
  const match = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : content;
}
