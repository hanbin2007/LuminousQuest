import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createProviderRegistry } from '../server/llm/providers';
import type { LLMProvider } from '../server/llm/types';
import { runEvalHarness, type EvalMode } from './harness';
import { loadEvalCases, loadEvalConfig, validateEvalCoverage } from './load';
import { renderEvalMarkdownReport } from './report';
import { loadAllConfig } from '../server/config/loader';

const keyByProvider: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  tongyi: 'TONGYI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
};

export class WaitingForApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaitingForApiKeyError';
  }
}

export function resolveLiveEvalProvider(input: {
  providerId: string;
  model: string;
  environment: NodeJS.ProcessEnv;
}): { provider: LLMProvider; providerId: string; model: string } {
  const keyName = keyByProvider[input.providerId];
  if (keyName && !input.environment[keyName]) {
    throw new WaitingForApiKeyError(`等待 API key: 请设置 ${keyName}`);
  }
  const provider = createProviderRegistry(input.environment).get(input.providerId);
  if (!provider) {
    throw new WaitingForApiKeyError(
      keyName
        ? `等待 API key: 请设置 ${keyName}`
        : `等待 API key: provider ${input.providerId} 尚未配置`,
    );
  }
  return { provider, providerId: input.providerId, model: input.model };
}

function parseArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const [name, inline] = argument.split('=', 2);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    values.set(name, value);
  }
  const mode = values.get('--mode') ?? 'mock';
  if (!['mock', 'replay', 'live'].includes(mode)) throw new Error(`Unknown eval mode ${mode}`);
  const runsText = values.get('--runs');
  const runs = runsText === undefined ? undefined : Number(runsText);
  if (runs !== undefined && (!Number.isInteger(runs) || runs < 1 || runs > 20)) {
    throw new Error('--runs must be an integer from 1 to 20');
  }
  return {
    mode: mode as EvalMode,
    provider: values.get('--provider'),
    model: values.get('--model'),
    report: values.get('--report'),
    recordings: values.get('--recordings'),
    runs,
  };
}

export async function runEvalCli(input: {
  argv?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  contentRoot?: string;
  output?: Pick<Console, 'log' | 'error'>;
} = {}) {
  const argv = input.argv ?? process.argv.slice(2);
  const environment = input.environment ?? process.env;
  const contentRoot = input.contentRoot ?? process.cwd();
  const output = input.output ?? console;
  try {
    const args = parseArguments(argv);
    const [cases, evalConfig, productionConfig] = await Promise.all([
      loadEvalCases({ contentRoot }),
      loadEvalConfig(contentRoot),
      loadAllConfig(contentRoot),
    ]);
    validateEvalCoverage({ cases, evalConfig, productionConfig });
    const providerId = args.provider ?? environment.LQ_EVAL_PROVIDER ?? evalConfig.live.provider;
    const model = args.model ?? environment.LQ_EVAL_MODEL ?? evalConfig.live.model;
    const live = args.mode === 'live'
      ? resolveLiveEvalProvider({ providerId, model, environment })
      : null;
    const recordingsRoot = args.recordings
      ?? path.join(contentRoot, 'eval', 'recordings');
    const result = await runEvalHarness({
      contentRoot,
      cases,
      config: evalConfig,
      mode: args.mode,
      providerId: args.mode === 'mock' ? 'eval-mock' : providerId,
      model: args.mode === 'mock' ? 'eval-mock-v1' : model,
      ...(live ? { provider: live.provider } : {}),
      recordingsRoot,
      ...(args.runs ? { runOverride: args.runs } : {}),
    });
    const report = renderEvalMarkdownReport({ metrics: result.metrics, metadata: result.metadata });
    const reportFile = args.report
      ?? path.join(contentRoot, 'eval', 'reports', `latest-${args.mode}.md`);
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, report, 'utf8');
    output.log(
      `M1c eval ${result.metrics.passed ? 'PASS' : 'FAIL'}: `
      + `${result.metrics.caseCount} cases, macro=${(result.metrics.nodeMacroAccuracy * 100).toFixed(2)}%, `
      + `report=${reportFile}`,
    );
    return result.metrics.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof WaitingForApiKeyError) {
      output.error(error.message);
      return 2;
    }
    output.error(`Eval failed: ${(error as Error).message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedDirectly) {
  void runEvalCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
