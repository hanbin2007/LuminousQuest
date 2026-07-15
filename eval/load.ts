import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { LoadedConfig } from '../shared/config/schemas';
import {
  evalCaseSchema,
  evalConfigSchema,
  evalHoldoutManifestSchema,
  type EvalCase,
  type EvalConfig,
  type LabeledEvalCase,
} from './schema';

export const EVAL_COVERAGE_REQUIREMENTS = Object.freeze({
  minimumCases: 150,
  minimumCasesPerNode: 5,
  minimumCasesPerMisconception: 3,
});

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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function evalCaseContentHash(evalCase: LabeledEvalCase) {
  return createHash('sha256').update(JSON.stringify(canonicalize({
    evaluationPath: evalCase.evaluationPath,
    questionRef: evalCase.questionRef,
    studentAnswer: evalCase.studentAnswer,
  }))).digest('hex');
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

async function loadEvalCaseFiles(files: readonly string[]): Promise<LabeledEvalCase[]> {
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

export async function loadEvalCases(input: {
  contentRoot: string;
  casesDirectory?: string;
}): Promise<LabeledEvalCase[]> {
  const defaultDirectory = path.join(input.contentRoot, 'eval', 'cases');
  const directory = path.resolve(input.casesDirectory ?? defaultDirectory);
  const holdoutDirectory = path.resolve(input.contentRoot, 'eval', 'holdout');
  if (directory === holdoutDirectory || directory.startsWith(`${holdoutDirectory}${path.sep}`)) {
    throw new EvalDataError(directory, '$', 'holdout data requires the dedicated holdout loader');
  }
  return loadEvalCaseFiles(await jsonFiles(directory));
}

export async function loadHoldoutEvalCases(input: {
  contentRoot: string;
  holdoutDirectory?: string;
}) {
  const directory = path.resolve(
    input.holdoutDirectory ?? path.join(input.contentRoot, 'eval', 'holdout'),
  );
  const manifestFile = path.join(directory, 'manifest.json');
  const parsed = evalHoldoutManifestSchema.safeParse(await readJson(manifestFile));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EvalDataError(manifestFile, issue.path.join('.') || '$', issue.message);
  }
  const declaredFiles = parsed.data.files.map((entry) => ({
    ...entry,
    absolute: path.resolve(directory, ...entry.path.split('/')),
  }));
  for (const entry of declaredFiles) {
    if (!entry.absolute.startsWith(`${directory}${path.sep}`)) {
      throw new EvalDataError(manifestFile, 'files.path', `holdout path escapes directory: ${entry.path}`);
    }
    let source: Buffer;
    try {
      source = await readFile(entry.absolute);
    } catch (error) {
      throw new EvalDataError(entry.absolute, '$', `cannot read manifest file: ${(error as Error).message}`);
    }
    const actual = createHash('sha256').update(source).digest('hex');
    if (actual !== entry.sha256) {
      throw new EvalDataError(entry.absolute, '$', `holdout content hash ${actual} != manifest ${entry.sha256}`);
    }
  }

  const casesDirectory = path.join(directory, 'cases');
  let actualFiles: string[] = [];
  try {
    actualFiles = (await jsonFiles(casesDirectory)).map((file) => path.resolve(file));
  } catch (error) {
    if (!(error instanceof EvalDataError && error.reason === 'directory is missing')) throw error;
  }
  const declaredPaths = new Set(declaredFiles.map((entry) => entry.absolute));
  const undeclared = actualFiles.find((file) => !declaredPaths.has(file));
  if (undeclared) throw new EvalDataError(undeclared, '$', 'holdout JSON is absent from the hash manifest');
  const missing = declaredFiles.find((entry) => !actualFiles.includes(entry.absolute));
  if (missing) throw new EvalDataError(missing.absolute, '$', 'manifest entry is not a holdout case file');
  return loadEvalCaseFiles(declaredFiles.map((entry) => entry.absolute));
}

export function assertEvalSetIsolation(input: {
  train: readonly LabeledEvalCase[];
  holdout: readonly LabeledEvalCase[];
}) {
  const trainIds = new Set(input.train.map((entry) => entry.id));
  const trainContents = new Map(input.train.map((entry) => [evalCaseContentHash(entry), entry.id]));
  for (const entry of input.holdout) {
    if (trainIds.has(entry.id)) {
      throw new EvalDataError('eval/holdout', 'id', `holdout id duplicates training case ${entry.id}`);
    }
    const contentHash = evalCaseContentHash(entry);
    const trainingId = trainContents.get(contentHash);
    if (trainingId) {
      throw new EvalDataError(
        'eval/holdout',
        'contentHash',
        `holdout ${entry.id} duplicates training content from ${trainingId}`,
      );
    }
  }
  return { isolated: true as const, trainCases: input.train.length, holdoutCases: input.holdout.length };
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

export function inspectEvalCoverage(input: {
  cases: readonly LabeledEvalCase[];
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
  const rubricReferenceIds = new Set(input.productionConfig.rubrics.rubrics.flatMap((rubric) => [
    ...rubric.rules.map((rule) => rule.id),
    ...rubric.evidenceRequirements.map((requirement) => requirement.id),
  ]));
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
    evalCase.rationale.rubricRefs.forEach((reference) => {
      if (!rubricReferenceIds.has(reference) && !reference.startsWith('rubrics.policy.')) {
        issues.push(`${evalCase.id}: unknown rationale rubric reference ${reference}`);
      }
    });
    const expectedQuotes = [
      ...evalCase.expectedExtraction.evidenceQuotes,
      ...evalCase.expectedExtraction.slots.map((slot) => slot.evidenceQuote),
      ...evalCase.expectedExtraction.anchors.flatMap((anchor) => [
        ...anchor.evidenceQuotes,
        ...anchor.facts.map((fact) => fact.evidenceQuote),
      ]),
    ];
    expectedQuotes.forEach((quote) => {
      if (!evalCase.studentAnswer.includes(quote)) {
        issues.push(`${evalCase.id}: evidence quote ${JSON.stringify(quote)} is absent from the answer`);
      }
    });
    const configuredAnchors = new Map((trainingCase?.followingAnchors ?? []).map((anchor) => [
      anchor.id,
      new Set(anchor.correctValue.split(';').map((entry) => entry.split('=', 1)[0].trim())),
    ]));
    evalCase.expectedExtraction.anchors.forEach((anchor) => {
      const configuredFacts = configuredAnchors.get(anchor.anchorId);
      if (!configuredFacts) {
        issues.push(`${evalCase.id}: unknown expected anchor ${anchor.anchorId}`);
        return;
      }
      anchor.facts.forEach((fact) => {
        if (!configuredFacts.has(fact.id)) {
          issues.push(`${evalCase.id}: unknown expected anchor fact ${anchor.anchorId}.${fact.id}`);
        }
      });
    });
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
    new Set(evalCase.expectedExtraction.errorIds).forEach((misconceptionId) => {
      if (misconceptionId in casesPerMisconception) casesPerMisconception[misconceptionId] += 1;
    });
  }

  if (input.cases.length < EVAL_COVERAGE_REQUIREMENTS.minimumCases) {
    issues.push(`case count ${input.cases.length} < ${EVAL_COVERAGE_REQUIREMENTS.minimumCases}`);
  }
  Object.entries(casesPerNode).forEach(([nodeId, count]) => {
    if (count < EVAL_COVERAGE_REQUIREMENTS.minimumCasesPerNode) {
      issues.push(`${nodeId}: ${count} cases < ${EVAL_COVERAGE_REQUIREMENTS.minimumCasesPerNode}`);
    }
  });
  Object.entries(casesPerMisconception).forEach(([misconceptionId, count]) => {
    if (count < EVAL_COVERAGE_REQUIREMENTS.minimumCasesPerMisconception) {
      issues.push(`${misconceptionId}: ${count} cases < ${EVAL_COVERAGE_REQUIREMENTS.minimumCasesPerMisconception}`);
    }
  });
  return {
    complete: issues.length === 0,
    requirements: EVAL_COVERAGE_REQUIREMENTS,
    issues,
    eligibleNodeIds: eligibleNodes.map((node) => node.id),
    answerExtractionNodeIds: eligibleNodes.filter((node) => answerNodes.has(node.id)).map((node) => node.id),
    deterministicEquationNodeIds: eligibleNodes.filter((node) => equationNodes.has(node.id)).map((node) => node.id),
    excludedDeterministicNodeIds,
    casesPerNode,
    casesPerMisconception,
  };
}

export function validateEvalCoverage(input: {
  cases: readonly LabeledEvalCase[];
  productionConfig: LoadedConfig;
}) {
  const coverage = inspectEvalCoverage(input);
  if (!coverage.complete) throw new EvalCoverageError(coverage.issues);
  return coverage;
}
