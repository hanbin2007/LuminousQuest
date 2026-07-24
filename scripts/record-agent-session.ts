import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { RecordingStore } from '../server/llm/recording-store';
import { inflateStudentSessionProjection } from '../shared/session/projections';
import type {
  AgentAnswerSubmission,
  AgentTurnCompletedEvent,
  StudentSession,
} from '../shared/session/schema';
import { sessionServerSequence } from '../shared/session/sync';

interface CliOptions {
  baseUrl: string;
  contentRoot: string;
  sessionFile: string;
  caseId: string;
  triggerEventId?: string;
  answers: string[];
  answersFile?: string;
  accessToken?: string;
}

class ScriptHttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptHttpError';
  }
}

function usage() {
  return [
    'Usage: pnpm record:agent-session -- --session <session.json> --case-id <case>',
    '       [--answer <text> ...] [--answers-file <answers.json>]',
    '       [--trigger-event-id <event>] [--base-url http://127.0.0.1:4173]',
    '       [--content-root <repo>] [--access-token <token>]',
    '',
    'The integrated server must already be running. This command does not start one.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: Partial<CliOptions> & { answers: string[] } = { answers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    const value = argv[index + 1];
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    index += 1;
    switch (flag) {
      case '--base-url':
        options.baseUrl = value;
        break;
      case '--content-root':
        options.contentRoot = value;
        break;
      case '--session':
        options.sessionFile = value;
        break;
      case '--case-id':
        options.caseId = value;
        break;
      case '--trigger-event-id':
        options.triggerEventId = value;
        break;
      case '--answer':
        options.answers.push(value);
        break;
      case '--answers-file':
        options.answersFile = value;
        break;
      case '--access-token':
        options.accessToken = value;
        break;
      default:
        throw new Error(`Unknown option ${flag}`);
    }
  }
  if (!options.sessionFile || !options.caseId) throw new Error(usage());
  return {
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:4173',
    contentRoot: path.resolve(options.contentRoot ?? process.cwd()),
    sessionFile: path.resolve(options.sessionFile),
    caseId: options.caseId,
    answers: options.answers,
    ...(options.triggerEventId ? { triggerEventId: options.triggerEventId } : {}),
    ...(options.answersFile ? { answersFile: path.resolve(options.answersFile) } : {}),
    ...(options.accessToken ? { accessToken: options.accessToken } : {}),
  };
}

async function responseJson<T>(response: Response) {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new ScriptHttpError(
      response.status,
      value,
      `${response.status} ${value.error ?? response.statusText}`,
    );
  }
  return value;
}

function latestTurn(session: StudentSession, caseId: string) {
  return [...session.events].reverse().find(
    (event): event is AgentTurnCompletedEvent =>
      event.kind === 'agent.turn.completed' && event.caseId === caseId,
  );
}

function answerForTurn(
  turn: AgentTurnCompletedEvent,
  rawAnswer: string,
): AgentAnswerSubmission['answer'] {
  const terminal = turn.orderedActions.find(
    (action) => action.callId === turn.terminalAction.callId,
  );
  if (terminal?.name !== 'show_question_card') {
    return { format: 'text', value: rawAnswer };
  }
  switch (terminal.arguments.board.kind) {
    case 'single-choice': {
      const option = terminal.arguments.board.options.find(
        (candidate) =>
          candidate.id === rawAnswer || candidate.label === rawAnswer,
      );
      if (!option) {
        throw new Error(
          `Answer "${rawAnswer}" is not a valid option. Use one of: ${
            terminal.arguments.board.options
              .map((candidate) => `${candidate.id} (${candidate.label})`)
              .join(', ')
          }`,
        );
      }
      return { format: 'choice', optionId: option.id };
    }
    case 'equation-fill':
      return { format: 'equation', value: rawAnswer };
    case 'short-fill':
      if (rawAnswer.length > terminal.arguments.board.maxLength) {
        throw new Error(
          `Answer exceeds the ${terminal.arguments.board.maxLength}-character board limit`,
        );
      }
      return { format: 'text', value: rawAnswer };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const recordingId = Date.now().toString(36);
  const requestHashes: string[] = [];
  const initialUrl = new URL('/api/config', options.baseUrl);
  if (options.accessToken) initialUrl.searchParams.set('access_token', options.accessToken);
  const configResponse = await fetch(initialUrl);
  const apiToken = configResponse.headers.get('x-lq-api-token');
  const cookie = configResponse.headers.get('set-cookie')?.split(';', 1)[0];
  const publicConfig = await responseJson<{ configVersion: string }>(configResponse);
  if (!apiToken) throw new Error('Server did not issue an API token');
  const headers = {
    'content-type': 'application/json',
    'x-lq-api-token': apiToken,
    ...(cookie ? { cookie } : {}),
  };
  const post = async <T>(route: string, body: unknown) => responseJson<T>(
    await fetch(new URL(route, options.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );

  await post('/api/runtime/execution-mode', { executionMode: 'live' });
  const rawSession = JSON.parse(await readFile(options.sessionFile, 'utf8')) as unknown;
  let session = inflateStudentSessionProjection(rawSession);
  const fileAnswers = options.answersFile
    ? JSON.parse(await readFile(options.answersFile, 'utf8')) as unknown
    : [];
  if (
    !Array.isArray(fileAnswers)
    || !fileAnswers.every((answer) => typeof answer === 'string')
  ) {
    throw new Error('--answers-file must contain a JSON array of strings');
  }
  const answers = [...options.answers, ...fileAnswers];

  let sync;
  try {
    sync = await post<{
      sequence: number;
      session: StudentSession;
    }>('/api/session/sync', {
      session,
      expectedSequence: 0,
      idempotencyKey: `record:${recordingId}:sync`,
    });
  } catch (error) {
    const actualSequence = error instanceof ScriptHttpError
      && error.status === 409
      && error.payload
      && typeof error.payload === 'object'
      && 'actualSequence' in error.payload
      && typeof error.payload.actualSequence === 'number'
      ? error.payload.actualSequence
      : null;
    if (actualSequence === null) throw error;
    sync = await post<{
      sequence: number;
      session: StudentSession;
    }>('/api/session/sync', {
      session,
      expectedSequence: actualSequence,
      idempotencyKey: `record:${recordingId}:sync-retry`,
    });
  }
  session = inflateStudentSessionProjection(sync.session);
  const trigger = options.triggerEventId
    ? session.events.find((event) => event.id === options.triggerEventId)
    : session.events.at(-1);
  if (!trigger) throw new Error('The recording session has no trigger event');

  let result = await post<{
    session: StudentSession;
    degraded: boolean;
  }>('/api/agent/turn', {
    sessionId: session.id,
    caseId: options.caseId,
    triggerEventId: trigger.id,
    expectedSequence: sync.sequence,
    idempotencyKey: `record:${recordingId}:turn:0`,
  });
  session = inflateStudentSessionProjection(result.session);
  let answerIndex = 0;
  for (let turnIndex = 0; turnIndex < 20; turnIndex += 1) {
    const turn = latestTurn(session, options.caseId);
    if (!turn) throw new Error('Agent route returned no completed turn');
    requestHashes.push(turn.requestHash);
    process.stdout.write(
      `[record] turn ${turnIndex + 1}: ${turn.orderedActions.map((action) => action.name).join(', ')}\n`,
    );
    if (turn.source === 'fallback' || result.degraded) {
      throw new Error('Provider degraded to fallback; no complete live recording was published');
    }
    if (
      turn.terminalAction.name === 'end_case'
      || turn.terminalAction.name === 'end_session'
    ) break;
    const answer = answers[answerIndex];
    if (answer === undefined) {
      throw new Error(`Agent is waiting for answer ${answerIndex + 1}; provide another --answer`);
    }
    answerIndex += 1;
    result = await post<{
      session: StudentSession;
      degraded: boolean;
    }>('/api/agent/answer', {
      sessionId: session.id,
      turnId: turn.turnId,
      answer: answerForTurn(turn, answer),
      expectedSequence: sessionServerSequence(session),
      idempotencyKey: `record:${recordingId}:answer:${answerIndex}`,
    });
    session = inflateStudentSessionProjection(result.session);
    if (turnIndex === 19) throw new Error('Agent session exceeded the 20-turn recording limit');
  }
  const terminal = latestTurn(session, options.caseId);
  if (
    terminal?.terminalAction.name !== 'end_case'
    && terminal?.terminalAction.name !== 'end_session'
  ) {
    throw new Error('Agent case did not reach end_case');
  }

  const store = new RecordingStore(options.contentRoot);
  const published = await store.publishAgentDemoRecordings(requestHashes);
  await store.validateDemoAssets({ configVersion: publicConfig.configVersion });
  process.stdout.write(
    `[record] published ${published.cacheKeys.length} agent turns to recordings/demo-script.json\n`,
  );
  published.cacheKeys.forEach((cacheKey) => process.stdout.write(`${cacheKey}\n`));
}

main().catch((error) => {
  process.stderr.write(`[record] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
