import { describe, expect, it } from 'vitest';

import {
  AgentTurnAdapterNotImplementedError,
  type AgentTurnAdapterRequest,
  type AgentTurnAdapterResult,
} from '../server/agent/adapters/adapter';
import { ClaudeAgentTurnAdapter } from '../server/agent/adapters/claude-agent';
import { OpenAICompatibleAgentTurnAdapter } from '../server/agent/adapters/openai-compatible';

const request = {
  requestHash: `sha256:${'f'.repeat(64)}`,
  model: 'frozen-model',
  systemPrompt: 'Server-only system prompt',
  messages: [{ role: 'user', content: 'Student answer' }],
  tools: [{
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
  }],
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

describe('provider-neutral AgentTurnAdapter foundations', () => {
  it('freezes a normalized tool-call trace and usage result independent of provider payloads', () => {
    expect(normalizedResult).toEqual({
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
    });
  });

  it.each([
    ['openai-compatible', new OpenAICompatibleAgentTurnAdapter()],
    ['claude-agent', new ClaudeAgentTurnAdapter()],
  ] as const)('provides a non-calling %s skeleton', async (id, adapter) => {
    expect(adapter.id).toBe(id);
    await expect(adapter.execute(request)).rejects.toBeInstanceOf(
      AgentTurnAdapterNotImplementedError,
    );
  });
});
