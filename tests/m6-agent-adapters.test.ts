import { describe, expect, it, vi } from 'vitest';

import type {
  AgentTurnAdapterRequest,
  AgentTurnAdapterResult,
} from '../server/agent/adapters/adapter';
import { ClaudeAgentTurnAdapter } from '../server/agent/adapters/claude-agent';
import { OpenAICompatibleAgentTurnAdapter } from '../server/agent/adapters/openai-compatible';

const request = {
  requestHash: `sha256:${'f'.repeat(64)}`,
  model: 'frozen-model',
  systemPrompt: 'Server-only system prompt',
  messages: [{ role: 'user', content: 'Student answer' }],
  tools: [
    {
      name: 'get_profile',
      description: 'Read the profile.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'ask_student',
      description: 'Ask the student one question.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'responseContractId'],
        properties: {
          text: { type: 'string' },
          responseContractId: { type: 'string' },
        },
      },
    },
  ],
  maxTurns: 9,
} satisfies AgentTurnAdapterRequest;

const normalizedResult = {
  source: 'provider',
  model: 'frozen-model',
  orderedActions: [{
    callId: 'call-1',
    name: 'ask_student',
    arguments: {
      text: 'Why?',
      responseContractId: 'response-contract-1',
    },
  }],
  terminalAction: { callId: 'call-1', name: 'ask_student' },
  usage: {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  },
} satisfies AgentTurnAdapterResult;

function completion(message: unknown, usage = {
  prompt_tokens: 10,
  completion_tokens: 2,
  total_tokens: 12,
}) {
  return new Response(JSON.stringify({
    choices: [{ message }],
    usage,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('provider-neutral AgentTurnAdapter runtime', () => {
  it('freezes a normalized tool-call trace and usage result independent of provider payloads', () => {
    expect(normalizedResult).toMatchObject({
      source: 'provider',
      terminalAction: { callId: 'call-1', name: 'ask_student' },
      usage: { totalTokens: 17 },
    });
  });

  it('preserves OpenAI assistant tool_calls and replies with the same tool_call_id', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(completion({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'profile-call',
          type: 'function',
          function: { name: 'get_profile', arguments: '{}' },
        }],
      }))
      .mockResolvedValueOnce(completion({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'ask-call',
          type: 'function',
          function: {
            name: 'ask_student',
            arguments: JSON.stringify({
              text: '请说明理由。',
              responseContractId: 'candidate-1',
            }),
          },
        }],
      }));
    const executeTool = vi.fn(async (action) => ({
      accepted: true,
      action,
      content: action.name === 'get_profile'
        ? JSON.stringify({ profile: 'current' })
        : JSON.stringify({ waiting: true }),
    }));
    const adapter = new OpenAICompatibleAgentTurnAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://provider.invalid/v1',
      fetch,
    });

    const result = await adapter.execute({ ...request, executeTool });

    expect(result.orderedActions.map((action) => action.name)).toEqual([
      'get_profile',
      'ask_student',
    ]);
    expect(result.terminalAction).toEqual({
      callId: 'ask-call',
      name: 'ask_student',
    });
    const secondBody = JSON.parse(
      String((fetch.mock.calls[1]?.[1] as RequestInit).body),
    ) as {
      parallel_tool_calls: boolean;
      messages: Array<Record<string, unknown>>;
    };
    expect(secondBody.parallel_tool_calls).toBe(false);
    expect(secondBody.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      tool_calls: [expect.objectContaining({ id: 'profile-call' })],
    }));
    expect(secondBody.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'profile-call',
      content: JSON.stringify({ profile: 'current' }),
    });
  });

  it('budgets OpenAI argument repair independently for each provider call id', async () => {
    const invalid = (id: string) => completion({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: { name: 'ask_student', arguments: '{}' },
      }],
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(invalid('invalid-call-1'))
      .mockResolvedValueOnce(invalid('invalid-call-2'))
      .mockResolvedValueOnce(completion({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'valid-call',
          type: 'function',
          function: {
            name: 'ask_student',
            arguments: JSON.stringify({
              text: '请说明理由。',
              responseContractId: 'candidate-1',
            }),
          },
        }],
      }));
    const adapter = new OpenAICompatibleAgentTurnAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://provider.invalid/v1',
      fetch,
    });

    // Red-before-green: a global counter treated two distinct bad calls as one retry.
    await expect(adapter.execute({
      ...request,
      executeTool: async (action) => ({
        accepted: true,
        action,
        content: '{"ok":true}',
      }),
    })).resolves.toMatchObject({
      terminalAction: { callId: 'valid-call', name: 'ask_student' },
    });
  });

  it('uses only the in-process lq MCP tools on claude-agent and returns their trace', async () => {
    const registered = new Map<string, (value: unknown) => Promise<unknown>>();
    const queryMock = vi.fn((input: {
      options: Record<string, unknown>;
    }) => (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'claude-profile',
              name: 'mcp__lq__get_profile',
              input: {},
            },
            {
              type: 'tool_use',
              id: 'claude-ask',
              name: 'mcp__lq__ask_student',
              input: {
                text: '下一步是什么？',
                responseContractId: 'candidate-1',
              },
            },
          ],
        },
      };
      await Promise.all([
        registered.get('get_profile')!({}),
        registered.get('ask_student')!({
          text: '下一步是什么？',
          responseContractId: 'candidate-1',
        }),
      ]);
      yield {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 20, output_tokens: 6 },
      };
      expect(input.options).toMatchObject({
        tools: [],
        allowedTools: ['mcp__lq__*'],
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        maxTurns: 12,
      });
    })());
    const sdk = {
      query: queryMock,
      tool: vi.fn((
        name: string,
        _description: string,
        _shape: unknown,
        handler: (value: unknown) => Promise<unknown>,
      ) => {
        registered.set(name, handler);
        return { name, handler };
      }),
      createSdkMcpServer: vi.fn((options: unknown) => ({
        type: 'sdk',
        name: 'lq',
        options,
      })),
    };
    let activeTools = 0;
    let maximumActiveTools = 0;
    const executeTool = vi.fn(async (action) => {
      activeTools += 1;
      maximumActiveTools = Math.max(maximumActiveTools, activeTools);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeTools -= 1;
      return {
        accepted: true,
        action,
        content: JSON.stringify({ ok: true }),
      };
    });
    const adapter = new ClaudeAgentTurnAdapter({
      sdk: sdk as never,
    });

    const result = await adapter.execute({ ...request, executeTool });

    expect(result.orderedActions.map((action) => action.callId)).toEqual([
      'claude-profile',
      'claude-ask',
    ]);
    expect(result.terminalAction).toEqual({
      callId: 'claude-ask',
      name: 'ask_student',
    });
    expect(maximumActiveTools).toBe(1);
    expect(sdk.createSdkMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'lq', alwaysLoad: true }),
    );
  });

  it('uses the Claude SDK native tool-use id when the MCP callback provides it', async () => {
    const registered = new Map<
      string,
      (value: unknown, extra?: unknown) => Promise<unknown>
    >();
    const sdk = {
      query: vi.fn(() => (async function* () {
        await registered.get('ask_student')!(
          {
            text: '下一步是什么？',
            responseContractId: 'candidate-1',
          },
          { toolUseId: 'sdk-native-tool-use' },
        );
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 4, output_tokens: 2 },
        };
      })()),
      tool: vi.fn((
        name: string,
        _description: string,
        _shape: unknown,
        handler: (value: unknown, extra?: unknown) => Promise<unknown>,
      ) => {
        registered.set(name, handler);
        return { name, handler };
      }),
      createSdkMcpServer: vi.fn((options: unknown) => ({
        type: 'sdk',
        name: 'lq',
        options,
      })),
    };
    const adapter = new ClaudeAgentTurnAdapter({ sdk: sdk as never });

    // Red-before-green: the callback used a synthetic claude-tool-N id.
    const result = await adapter.execute({
      ...request,
      executeTool: async (action) => ({
        accepted: true,
        action,
        content: '{"ok":true}',
      }),
    });
    expect(result.terminalAction).toEqual({
      callId: 'sdk-native-tool-use',
      name: 'ask_student',
    });
  });
});
