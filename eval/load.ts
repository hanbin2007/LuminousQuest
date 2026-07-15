import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { LoadedConfig } from '../shared/config/schemas';
import {
  evalCaseSchema,
  evalConfigSchema,
  type EvalCase,
  type EvalConfig,
  type LabeledEvalCase,
} from './schema';

export class EvalDataError extends Error {
  constructor(readonly file: string, readonly field: string, readonly reason: string) {
    super(`${file}: ${field}: ${reason}`);
    this.name = 'EvalDataError';
  }
}

export class EvalCoverageError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Eval coverage failed: ${issues.join('; ')}`);
    this.name = 'EvalCoverageError';
  }
}

async function jsonFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'directory is missing'
      : (error as Error).message;
    throw new EvalDataError(directory, '$', reason);
  }
  const nested = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return jsonFiles(file);
      return entry.isFile() && entry.name.endsWith('.json') ? [file] : [];
    }));
  return nested.flat();
}

async function readJson(file: string) {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new EvalDataError(file, '$', `cannot read file: ${(error as Error).message}`);
  }
  if (source.trim().length === 0) throw new EvalDataError(file, '$', 'file is empty');
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new EvalDataError(file, '$', `invalid JSON: ${(error as Error).message}`);
  }
}

function parseCase(file: string, value: unknown, index?: number) {
  const parsed = evalCaseSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const prefix = index === undefined ? '' : `${index}.`;
    throw new EvalDataError(file, `${prefix}${issue.path.join('.') || '$'}`, issue.message);
  }
  return parsed.data;
}

export async function loadEvalCases(input: {
  contentRoot: string;
  casesDirectory?: string;
}): Promise<LabeledEvalCase[]> {
  const directory = input.casesDirectory ?? path.join(input.contentRoot, 'eval', 'cases');
  const files = await jsonFiles(directory);
  const all: Array<{ file: string; value: EvalCase }> = [];
  for (const file of files) {
    const value = await readJson(file);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => all.push({ file, value: parseCase(file, entry, index) }));
    } else {
      all.push({ file, value: parseCase(file, value) });
    }
  }
  const ids = new Map<string, string>();
  for (const entry of all) {
    const previous = ids.get(entry.value.id);
    if (previous) {
      throw new EvalDataError(entry.file, 'id', `duplicate eval case id ${entry.value.id} (first in ${previous})`);
    }
    ids.set(entry.value.id, entry.file);
  }
  return all
    .filter((entry): entry is { file: string; value: LabeledEvalCase } =>
      entry.value.annotationStatus === 'labeled')
    .map((entry) => entry.value)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadEvalConfig(contentRoot: string): Promise<EvalConfig> {
  const file = path.join(contentRoot, 'eval', 'config.json');
  const value = await readJson(file);
  const parsed = evalConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EvalDataError(file, issue.path.join('.') || '$', issue.message);
  }
  return parsed.data;
}

export function validateEvalCoverage(input: {
  cases: readonly LabeledEvalCase[];
  evalConfig: EvalConfig;
  productionConfig: LoadedConfig;
}) {
  const answerNodes = new Set(input.productionConfig.cases.flatMap((trainingCase) =>
    trainingCase.evidencePaths
      .filter((evidencePath) => evidencePath.source === 'answer')
      .map((evidencePath) => evidencePath.nodeId)));
  const equationNodes = new Set(input.productionConfig.cases.flatMap((trainingCase) =>
    trainingCase.evidencePaths
      .filter((evidencePath) => evidencePath.source === 'equation')
      .map((evidencePath) => evidencePath.nodeId)));
  const eligibleNodes = input.productionConfig.knowledgeModel.nodes
    .filter((node) => answerNodes.has(node.id) || equationNodes.has(node.id));
  const excludedDeterministicNodeIds = input.productionConfig.knowledgeModel.nodes
    .filter((node) => !answerNodes.has(node.id) && !equationNodes.has(node.id))
    .map((node) => node.id);
  const casesPerNode = Object.fromEntries(eligibleNodes.map((node) => [node.id, 0]));
  const casesPerMisconception = Object.fromEntries(eligibleNodes.flatMap((node) =>
    node.misconceptions.map((misconception) => [misconception.id, 0] as const)));
  const issues: string[] = [];

  for (const evalCase of input.cases) {
    const trainingCase = input.productionConfig.cases.find((entry) =>
      entry.id === evalCase.questionRef.caseId);
    const node = input.productionConfig.knowledgeModel.nodes.find((entry) =>
      entry.id === evalCase.questionRef.nodeId);
    const expectedSource = evalCase.evaluationPath === 'equation' ? 'equation' : 'answer';
    const evidencePath = trainingCase?.evidencePaths.find((entry) =>
      entry.source === expectedSource && entry.nodeId === evalCase.questionRef.nodeId);
    if (!trainingCase) issues.push(`${evalCase.id}: unknown case ${evalCase.questionRef.caseId}`);
    if (!node) issues.push(`${evalCase.id}: unknown node ${evalCase.questionRef.nodeId}`);
    if (trainingCase && !evidencePath) {
      issues.push(`${evalCase.id}: node ${evalCase.questionRef.nodeId} is not on the production ${expectedSource} path`);
    }
    if (
      evalCase.evaluationPath === 'equation'
      && !trainingCase?.equationSets.some((entry) => entry.id === evalCase.questionRef.equationSetId)
    ) {
      issues.push(`${evalCase.id}: unknown equation set ${evalCase.questionRef.equationSetId ?? '(missing)'}`);
    }
    if (evalCase.rubricVersion !== input.productionConfig.rubrics.version) {
      issues.push(`${evalCase.id}: rubric ${evalCase.rubricVersion} != ${input.productionConfig.rubrics.version}`);
    }
    if (evidencePath && evalCase.evaluationPath === 'structured-assessment') {
      const slots = new Set(evidencePath.factRequirements.map((requirement) => requirement.id));
      evalCase.expectedExtraction.slots.forEach((slot) => {
        if (!slots.has(slot.id)) issues.push(`${evalCase.id}: unknown expected slot ${slot.id}`);
      });
    }
    if (
      evalCase.evaluationPath === 'equation'
      && evalCase.expectedExtraction.slots.some((slot) => slot.id !== 'equation')
    ) issues.push(`${evalCase.id}: equation path only accepts the equation extraction slot`);
    if (node) {
      const misconceptions = new Set(node.misconceptions.map((entry) => entry.id));
      evalCase.misconceptionIds.forEach((misconceptionId) => {
        if (!misconceptions.has(misconceptionId)) {
          issues.push(`${evalCase.id}: misconception ${misconceptionId} does not belong to ${node.id}`);
        }
      });
      evalCase.expectedExtraction.errorIds.forEach((errorId) => {
        if (!misconceptions.has(errorId)) {
          issues.push(`${evalCase.id}: error ${errorId} does not belong to ${node.id}`);
        }
      });
    }
    if (evalCase.questionRef.nodeId in casesPerNode) {
      casesPerNode[evalCase.questionRef.nodeId] += 1;
    }
    new Set(evalCase.misconceptionIds).forEach((misconceptionId) => {
      if (misconceptionId in casesPerMisconception) casesPerMisconception[misconceptionId] += 1;
    });
  }

  if (input.cases.length < input.evalConfig.coverage.minimumCases) {
    issues.push(`case count ${input.cases.length} < ${input.evalConfig.coverage.minimumCases}`);
  }
  Object.entries(casesPerNode).forEach(([nodeId, count]) => {
    if (count < input.evalConfig.coverage.minimumCasesPerNode) {
      issues.push(`${nodeId}: ${count} cases < ${input.evalConfig.coverage.minimumCasesPerNode}`);
    }
  });
  Object.entries(casesPerMisconception).forEach(([misconceptionId, count]) => {
    if (count < input.evalConfig.coverage.minimumCasesPerMisconception) {
      issues.push(`${misconceptionId}: ${count} cases < ${input.evalConfig.coverage.minimumCasesPerMisconception}`);
    }
  });
  if (issues.length > 0) throw new EvalCoverageError(issues);
  return {
    complete: true as const,
    eligibleNodeIds: eligibleNodes.map((node) => node.id),
    answerExtractionNodeIds: eligibleNodes.filter((node) => answerNodes.has(node.id)).map((node) => node.id),
    deterministicEquationNodeIds: eligibleNodes.filter((node) => equationNodes.has(node.id)).map((node) => node.id),
    excludedDeterministicNodeIds,
    casesPerNode,
    casesPerMisconception,
  };
}
