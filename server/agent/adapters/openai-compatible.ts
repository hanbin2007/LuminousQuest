import {
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
  type NormalizedAgentAction,
} from '../../../shared/agent/contracts';
import {
  AgentTurnAdapterError,
  parseAgentTurnAdapterResult,
  type AgentToolExecutionResult,
  type AgentTurnAdapter,
  type AgentTurnAdapterRequest,
  type AgentTurnAdapterResult,
} from './adapter';

export const OPENAI_AGENT_ADAPTER_VERSION = 'openai-agent-adapter.v1' as const;

interface OpenAICompatibleAgentTurnAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIAssistantMessage {
  role: 'assistant';
  content: unknown;
  tool_calls?: OpenAIToolCall[];
}

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | OpenAIAssistantMessage
  | { role: 'tool'; content: string; tool_call_id: string };

interface OpenAICompletionPayload {
  choices?: Array<{ message?: OpenAIAssistantMessage }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function errorResult(
  action: NormalizedAgentAction,
  category: string,
  detail: string,
): AgentToolExecutionResult {
  return {
    accepted: false,
    action,
    errorCategory: category,
    content: JSON.stringify({
      ok: false,
      error: { category, detail },
      instruction: 'Repair the tool call once using the declared schema.',
    }),
  };
}

function defaultToolResult(action: NormalizedAgentAction): AgentToolExecutionResult {
  return {
    accepted: true,
    action,
    content: JSON.stringify({ ok: true }),
  };
}

function parseArguments(call: OpenAIToolCall): NormalizedAgentAction {
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.function.arguments);
  } catch {
    throw new AgentTurnAdapterError(
      `Tool ${call.function.name} returned invalid JSON arguments`,
      'invalid-tool-json',
    );
  }
  return normalizedAgentActionSchema.parse({
    callId: call.id,
    name: call.function.name,
    arguments: argumentsValue,
  });
}

function combinedSignal(requestSignal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
}

export class OpenAICompatibleAgentTurnAdapter implements AgentTurnAdapter {
  readonly id = 'openai-compatible' as const;
  readonly version = OPENAI_AGENT_ADAPTER_VERSION;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: OpenAICompatibleAgentTurnAdapterOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async execute(request: AgentTurnAdapterRequest): Promise<AgentTurnAdapterResult> {
    const apiKey = this.options.apiKey ?? process.env.LQ_LLM_API_KEY;
    const baseUrl = (this.options.baseUrl ?? process.env.LQ_LLM_BASE_URL)?.replace(/\/$/, '');
    if (!apiKey || !baseUrl) {
      throw new AgentTurnAdapterError(
        'OpenAI-compatible agent adapter is missing its API key or base URL',
        'configuration',
      );
    }

    const messages: OpenAIMessage[] = [
      {
        role: 'system',
        content: Array.isArray(request.systemPrompt)
          ? request.systemPrompt.join('\n')
          : request.systemPrompt,
      },
      ...request.messages.map((message): OpenAIMessage => {
        if (message.role === 'tool') {
          if (!message.toolCallId) {
            throw new AgentTurnAdapterError(
              'A tool history message is missing toolCallId',
              'invalid-message-chain',
            );
          }
          return {
            role: 'tool',
            content: message.content,
            tool_call_id: message.toolCallId,
          };
        }
        return { role: message.role, content: message.content };
      }),
    ];
    const orderedActions: NormalizedAgentAction[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    const validationFailures = new Map<string, number>();
    let toolCallAttempts = 0;

    for (let turn = 0; turn < request.maxTurns; turn += 1) {
      const response = await this.fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages,
          tools: request.tools.map((definition) => ({
            type: 'function',
            function: {
              name: definition.name,
              description: definition.description,
              parameters: definition.inputSchema,
              strict: true,
            },
          })),
          tool_choice: 'required',
          parallel_tool_calls: false,
          temperature: 0.1,
        }),
        signal: combinedSignal(
          request.signal,
          this.options.timeoutMs ?? 60_000,
        ),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new AgentTurnAdapterError(
          `OpenAI-compatible agent request failed with HTTP ${response.status}: ${detail}`,
          'http-error',
          response.status,
          detail,
        );
      }

      const payload = await response.json() as OpenAICompletionPayload;
      const assistant = payload.choices?.[0]?.message;
      if (!assistant) {
        throw new AgentTurnAdapterError(
          'OpenAI-compatible agent response has no assistant message',
          'invalid-provider-response',
        );
      }
      const toolCalls = assistant.tool_calls ?? [];
      messages.push({
        role: 'assistant',
        content: assistant.content ?? '',
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      inputTokens += payload.usage?.prompt_tokens ?? 0;
      outputTokens += payload.usage?.completion_tokens ?? 0;
      totalTokens += payload.usage?.total_tokens
        ?? (payload.usage?.prompt_tokens ?? 0) + (payload.usage?.completion_tokens ?? 0);

      if (toolCalls.length === 0) {
        throw new AgentTurnAdapterError(
          'OpenAI-compatible agent ended without a tool call',
          'missing-tool-call',
        );
      }

      for (const [index, call] of toolCalls.entries()) {
        toolCallAttempts += 1;
        if (toolCallAttempts > 8) {
          throw new AgentTurnAdapterError(
            'OpenAI-compatible agent exceeded 8 tool-call attempts',
            'tool-limit',
          );
        }
        let action: NormalizedAgentAction;
        try {
          action = parseArguments(call);
        } catch (error) {
          const failures = (validationFailures.get(call.id) ?? 0) + 1;
          validationFailures.set(call.id, failures);
          const category = error instanceof AgentTurnAdapterError
            ? error.category
            : 'invalid-tool-arguments';
          const detail = error instanceof Error ? error.message : String(error);
          if (failures > 1) {
            throw new AgentTurnAdapterError(
              `Agent tool arguments remained invalid after one repair: ${detail}`,
              category,
            );
          }
          const placeholder = {
            callId: call.id,
            name: 'get_profile',
            arguments: {},
          } as const;
          const rejected = errorResult(placeholder, category, detail);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: rejected.content,
          });
          continue;
        }

        const execution = request.executeTool
          ? await request.executeTool(action)
          : defaultToolResult(action);
        const canonicalAction = normalizedAgentActionSchema.parse(execution.action);
        if (canonicalAction.callId !== call.id || canonicalAction.name !== action.name) {
          throw new AgentTurnAdapterError(
            'Tool execution changed the provider call id or tool name',
            'invalid-tool-result',
          );
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: execution.content,
        });
        if (!execution.accepted) {
          const failures = (validationFailures.get(call.id) ?? 0) + 1;
          validationFailures.set(call.id, failures);
          if (failures > 1) {
            throw new AgentTurnAdapterError(
              `Agent tool execution remained invalid after one repair: ${
                execution.errorCategory ?? 'tool-rejected'
              }`,
              execution.errorCategory ?? 'tool-rejected',
            );
          }
          continue;
        }

        validationFailures.delete(call.id);
        orderedActions.push(canonicalAction);
        if (terminalAgentActionNameSchema.safeParse(canonicalAction.name).success) {
          if (index !== toolCalls.length - 1) {
            throw new AgentTurnAdapterError(
              'Provider emitted another tool call after a terminal action',
              'terminal-latch',
            );
          }
          return parseAgentTurnAdapterResult({
            source: 'provider',
            model: request.model,
            orderedActions,
            terminalAction: {
              callId: canonicalAction.callId,
              name: canonicalAction.name,
            },
            usage: {
              inputTokens,
              outputTokens,
              totalTokens,
            },
          });
        }
      }
    }

    throw new AgentTurnAdapterError(
      `OpenAI-compatible agent exceeded ${request.maxTurns} turns without a terminal action`,
      'max-turns',
    );
  }
}
