import { randomUUID } from 'node:crypto';

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeAgentTurnAdapter } from '../server/agent/adapters/claude-agent';
import {
  InMemoryAgentTranscriptStore,
  readAgentSessionMessages,
} from '../server/agent/transcript-store';
import { createAgentToolDefinitions } from '../server/agent/tools';
import { defaultModelForProvider } from '../server/llm/configuration';

const adapter = new ClaudeAgentTurnAdapter();
const store = new InMemoryAgentTranscriptStore();
const sessionId = randomUUID();
const model = process.env.LQ_LLM_MODEL ?? defaultModelForProvider('claude-agent');
const definitions = createAgentToolDefinitions();

async function run(input: {
  sequence: number;
  resume: boolean;
  toolName: 'show_question_card' | 'end_case';
  systemPrompt: string | string[];
  userPrompt: string;
}) {
  const tools = definitions.filter((definition) => definition.name === input.toolName);
  if (tools.length !== 1) throw new Error(`Missing Agent tool ${input.toolName}`);
  return adapter.execute({
    requestHash: `sha256:${input.sequence.toString(16).padStart(64, '0')}`,
    model,
    systemPrompt: input.systemPrompt,
    messages: [{ role: 'user', content: input.userPrompt }],
    tools,
    maxTurns: 4,
    sdkSession: {
      sessionId,
      resume: input.resume,
      store,
    },
    executeTool: async (action) => ({
      accepted: action.name === input.toolName,
      action,
      content: JSON.stringify({
        ok: action.name === input.toolName,
        verificationSequence: input.sequence,
      }),
      ...(action.name === input.toolName
        ? {}
        : { errorCategory: 'unexpected-verification-tool' }),
    }),
  });
}

async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is set; unset it to verify the local Claude OAuth path',
    );
  }
  const first = await run({
    sequence: 1,
    resume: false,
    toolName: 'show_question_card',
    systemPrompt: [
      'OAuth verification. Call show_question_card exactly once. '
        + 'Use objectiveId "oauth-session", text "选择继续。", and a single-choice '
        + 'board with option IDs "continue" and "stop". Do not write prose.',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      JSON.stringify({ caseId: 'oauth-case-1', objectiveId: 'oauth-session' }),
    ],
    userPrompt: 'Start the verification case.',
  });
  const second = await run({
    sequence: 2,
    resume: true,
    toolName: 'end_case',
    systemPrompt: [
      'OAuth verification continuation. Call end_case exactly once with a short summary. '
        + 'Do not write prose.',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      JSON.stringify({ caseId: 'oauth-case-1', objectiveId: 'oauth-session' }),
    ],
    userPrompt: 'Continue the same verification case and end it.',
  });
  const messages = await readAgentSessionMessages(sessionId, store);
  if (messages.length < 2) {
    throw new Error('The SDK SessionStore did not retain the resumed transcript');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    auth: 'local-claude-oauth',
    apiKeyUsed: false,
    model,
    sessionId,
    firstTerminal: first.terminalAction.name,
    secondTerminal: second.terminalAction.name,
    resumed: first.sdkSessionId === second.sdkSessionId,
    transcriptEntries: messages.length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `[verify-agent-oauth] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
