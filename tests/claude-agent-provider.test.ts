import { afterEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAgentProvider } from '../server/llm/providers/claude-agent';
import type { LLMRequest } from '../server/llm/types';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function request(timeoutMs?: number): LLMRequest {
  return {
    executionMode: 'live',
    capability: 'chat',
    provider: 'claude-agent',
    model: 'claude-sonnet-4-5',
    prompt: { id: 'test', version: 'prompt.v1', text: 'System instructions' },
    schemaVersion: 'schema.v1',
    configVersion: 'config.v1',
    input: { answer: 'student answer' },
    images: [],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

describe('Claude Agent provider', () => {
  it('aborts the SDK query at the exact request timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let options: Record<string, unknown> | undefined;
    queryMock.mockImplementation((input: { options: { abortController: AbortController } }) => {
      options = input.options;
      signal = input.options.abortController.signal;
      return (async function* waitForAbort() {
        await new Promise<never>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
      })();
    });
    const completion = new ClaudeAgentProvider().chat(request(25));
    const rejection = expect(completion).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(24);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const abortedAtDeadline = signal?.aborted;
    if (!abortedAtDeadline) await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(abortedAtDeadline).toBe(true);
    expect(options).toMatchObject({
      maxTurns: 1,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    });
    expect(options).not.toHaveProperty('allowedTools');
  });
});
