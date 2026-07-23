import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
  type NormalizedAgentAction,
} from '../../../shared/agent/contracts';
import { AGENT_TOOL_SPECS } from '../tools';
import {
  AgentTurnAdapterError,
  parseAgentTurnAdapterResult,
  type AgentToolExecutionResult,
  type AgentTurnAdapter,
  type AgentTurnAdapterRequest,
  type AgentTurnAdapterResult,
} from './adapter';

export const CLAUDE_AGENT_ADAPTER_VERSION = 'claude-agent-adapter.v1' as const;

interface ClaudeAgentSdk {
  query: typeof query;
  createSdkMcpServer: typeof createSdkMcpServer;
  tool: typeof tool;
}

interface ClaudeAgentTurnAdapterOptions {
  sdk?: ClaudeAgentSdk;
  minimumMaxTurns?: number;
  timeoutMs?: number;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'tool_use'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { name?: unknown }).name === 'string',
  );
}

function localToolName(name: string) {
  return name.startsWith('mcp__lq__') ? name.slice('mcp__lq__'.length) : name;
}

function defaultToolResult(action: NormalizedAgentAction): AgentToolExecutionResult {
  return {
    accepted: true,
    action,
    content: JSON.stringify({ ok: true }),
  };
}

class ToolCallBroker {
  private readonly queued = new Map<string, string[]>();
  private readonly waiting = new Map<string, Array<(callId: string) => void>>();
  private readonly unmatchedFallbacks = new Map<string, number>();
  private fallbackSequence = 0;

  publish(name: string, callId: string) {
    const key = localToolName(name);
    const waiter = this.waiting.get(key)?.shift();
    if (waiter) {
      waiter(callId);
      return false;
    }
    const fallbackCount = this.unmatchedFallbacks.get(key) ?? 0;
    if (fallbackCount > 0) {
      if (fallbackCount === 1) this.unmatchedFallbacks.delete(key);
      else this.unmatchedFallbacks.set(key, fallbackCount - 1);
      return true;
    }
    const queue = this.queued.get(key) ?? [];
    queue.push(callId);
    this.queued.set(key, queue);
    return false;
  }

  async take(name: string) {
    const queue = this.queued.get(name);
    const queued = queue?.shift();
    if (queued) return queued;
    return new Promise<string>((resolve) => {
      const waiters = this.waiting.get(name) ?? [];
      waiters.push(resolve);
      this.waiting.set(name, waiters);
      setTimeout(() => {
        const index = waiters.indexOf(resolve);
        if (index < 0) return;
        waiters.splice(index, 1);
        this.fallbackSequence += 1;
        this.unmatchedFallbacks.set(
          name,
          (this.unmatchedFallbacks.get(name) ?? 0) + 1,
        );
        resolve(`claude-tool-${this.fallbackSequence}`);
      }, 250).unref();
    });
  }
}

export class ClaudeAgentTurnAdapter implements AgentTurnAdapter {
  readonly id = 'claude-agent' as const;
  readonly version = CLAUDE_AGENT_ADAPTER_VERSION;
  private readonly sdk: ClaudeAgentSdk;

  constructor(private readonly options: ClaudeAgentTurnAdapterOptions = {}) {
    this.sdk = options.sdk ?? { query, createSdkMcpServer, tool };
  }

  async execute(request: AgentTurnAdapterRequest): Promise<AgentTurnAdapterResult> {
    const requestedToolNames = new Set(request.tools.map((definition) => definition.name));
    const selectedToolSpecs = AGENT_TOOL_SPECS.filter((spec) =>
      requestedToolNames.has(spec.name));
    if (
      requestedToolNames.size !== request.tools.length
      || selectedToolSpecs.length !== requestedToolNames.size
    ) {
      throw new AgentTurnAdapterError(
        'claude-agent received duplicate or unsupported tool definitions',
        'invalid-tool-definition',
      );
    }
    const broker = new ToolCallBroker();
    const orderedActions: NormalizedAgentAction[] = [];
    const observedToolUses: NormalizedAgentAction[] = [];
    const handledProviderCallIds = new Set<string>();
    const attemptedCallIds = new Set<string>();
    let fatalToolError: unknown;
    let invalidToolUseCount = 0;
    let toolExecutionTail = Promise.resolve();

    const executeSerially = <T>(operation: () => Promise<T>) => {
      const pending = toolExecutionTail.then(operation);
      toolExecutionTail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };
    const recordToolAttempt = (callId: string) => {
      attemptedCallIds.add(callId);
      if (attemptedCallIds.size > 8) {
        fatalToolError = new AgentTurnAdapterError(
          'claude-agent exceeded 8 tool-call attempts',
          'tool-limit',
        );
      }
    };

    const sdkTools = selectedToolSpecs.map((spec) => {
      const shape = (spec.schema as z.ZodObject<z.ZodRawShape>).shape;
      return this.sdk.tool(
        spec.name,
        spec.description,
        shape,
        async (argumentsValue) => {
          const callId = await broker.take(spec.name);
          handledProviderCallIds.add(callId);
          recordToolAttempt(callId);
          return executeSerially(async () => {
            try {
              const action = normalizedAgentActionSchema.parse({
                callId,
                name: spec.name,
                arguments: argumentsValue,
              });
              const execution = request.executeTool
                ? await request.executeTool(action)
                : defaultToolResult(action);
              const canonical = normalizedAgentActionSchema.parse(execution.action);
              if (canonical.callId !== callId || canonical.name !== action.name) {
                throw new AgentTurnAdapterError(
                  'Tool execution changed the provider call id or tool name',
                  'invalid-tool-result',
                );
              }
              if (execution.accepted) {
                orderedActions.push(canonical);
              }
              return {
                content: [{ type: 'text' as const, text: execution.content }],
                ...(execution.accepted ? {} : { isError: true }),
              };
            } catch (error) {
              fatalToolError = error;
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    ok: false,
                    error: { category: 'tool-execution-error' },
                  }),
                }],
                isError: true,
              };
            }
          });
        },
      );
    });
    const mcpServer = this.sdk.createSdkMcpServer({
      name: 'lq',
      version: CLAUDE_AGENT_ADAPTER_VERSION,
      tools: sdkTools,
      alwaysLoad: true,
    });
    const abortController = new AbortController();
    const abort = () => abortController.abort(request.signal?.reason);
    const configuredTimeout = Number(
      this.options.timeoutMs ?? process.env.LLM_TIMEOUT_MS ?? 120_000,
    );
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 120_000;
    const timeout = setTimeout(
      () => abortController.abort(new DOMException('Agent turn timed out', 'TimeoutError')),
      timeoutMs,
    );
    timeout.unref();
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener('abort', abort, { once: true });

    let resultMessage: Extract<SDKMessage, { type: 'result' }> | undefined;
    try {
      const conversation = this.sdk.query({
        prompt: JSON.stringify({ messages: request.messages }),
        options: {
          model: request.model,
          systemPrompt: request.systemPrompt,
          maxTurns: Math.max(
            this.options.minimumMaxTurns ?? 12,
            request.maxTurns,
          ),
          tools: [],
          allowedTools: ['mcp__lq__*'],
          mcpServers: { lq: mcpServer },
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          abortController,
        },
      });

      for await (const message of conversation) {
        if (message.type === 'assistant') {
          const content = Array.isArray(message.message.content)
            ? message.message.content
            : [];
          for (const block of content) {
            if (!isToolUseBlock(block)) continue;
            const name = localToolName(block.name);
            try {
              const observed = normalizedAgentActionSchema.parse({
                callId: block.id,
                name,
                arguments: block.input,
              });
              invalidToolUseCount = 0;
              observedToolUses.push(observed);
              const matchedFallback = broker.publish(name, block.id);
              if (matchedFallback) {
                handledProviderCallIds.add(block.id);
              } else {
                recordToolAttempt(block.id);
              }
            } catch {
              // The SDK MCP layer returns the schema error to Claude for one repair.
              recordToolAttempt(block.id);
              invalidToolUseCount += 1;
              if (invalidToolUseCount > 1) {
                fatalToolError = new AgentTurnAdapterError(
                  'claude-agent tool arguments remained invalid after one repair',
                  'invalid-tool-arguments',
                );
              }
            }
          }
        }
        if (message.type === 'result') resultMessage = message;
      }
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }

    if (fatalToolError) throw fatalToolError;
    if (!resultMessage) {
      throw new AgentTurnAdapterError(
        'claude-agent produced no result message',
        'invalid-provider-response',
      );
    }
    if (resultMessage.subtype !== 'success') {
      throw new AgentTurnAdapterError(
        `claude-agent run failed: ${resultMessage.subtype}`,
        resultMessage.subtype === 'error_max_turns' ? 'max-turns' : 'provider-error',
      );
    }

    // Query doubles used by tests may emit tool_use blocks without running the MCP
    // handler. Execute those calls here so the adapter contract remains identical.
    for (const observed of observedToolUses) {
      if (handledProviderCallIds.has(observed.callId)) continue;
      const execution = request.executeTool
        ? await request.executeTool(observed)
        : defaultToolResult(observed);
      if (!execution.accepted) {
        throw new AgentTurnAdapterError(
          `Recorded Claude tool call was rejected: ${
            execution.errorCategory ?? 'tool-rejected'
          }`,
          execution.errorCategory ?? 'tool-rejected',
        );
      }
      orderedActions.push(normalizedAgentActionSchema.parse(execution.action));
    }

    const terminal = orderedActions.at(-1);
    if (
      !terminal
      || !terminalAgentActionNameSchema.safeParse(terminal.name).success
    ) {
      throw new AgentTurnAdapterError(
        'claude-agent ended without a terminal tool call',
        'missing-terminal-tool',
      );
    }
    const inputTokens = resultMessage.usage?.input_tokens;
    const outputTokens = resultMessage.usage?.output_tokens;
    return parseAgentTurnAdapterResult({
      source: 'provider',
      model: request.model,
      orderedActions,
      terminalAction: { callId: terminal.callId, name: terminal.name },
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      },
    });
  }
}
