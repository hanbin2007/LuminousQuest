import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ZodType } from 'zod';
import { ZodError } from 'zod';

import {
  caseSchema,
  knowledgeModelSchema,
  type LoadedConfig,
  pretestSchema,
  rubricsSchema,
  scaffoldPolicySchema,
} from '../../shared/config/schemas';
import { analyzeEquation } from '../../shared/chemistry/equation';

export class ConfigValidationError extends Error {
  readonly file: string;
  readonly field: string;
  readonly reason: string;

  constructor(file: string, field: string, reason: string) {
    super(`${file}: ${field}: ${reason}`);
    this.name = 'ConfigValidationError';
    this.file = file;
    this.field = field;
    this.reason = reason;
  }
}

async function parseJsonFile<T>(contentRoot: string, relativeFile: string, schema: ZodType<T>) {
  const absoluteFile = path.join(contentRoot, relativeFile);
  let source: string;

  try {
    source = await readFile(absoluteFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'file is missing' : `cannot read file: ${(error as Error).message}`;
    throw new ConfigValidationError(relativeFile, '$', reason);
  }

  if (source.trim().length === 0) {
    throw new ConfigValidationError(relativeFile, '$', 'file is empty');
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ConfigValidationError(relativeFile, '$', `invalid JSON: ${(error as Error).message}`);
  }

  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const field = issue.path.length > 0 ? issue.path.join('.') : '$';
      throw new ConfigValidationError(relativeFile, field, issue.message);
    }
    throw error;
  }
}

async function loadCases(contentRoot: string) {
  const relativeDirectory = path.join('config', 'cases');
  let files: string[];
  try {
    files = (await readdir(path.join(contentRoot, relativeDirectory)))
      .filter((file) => file.endsWith('.json'))
      .sort();
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'directory is missing'
      : `cannot read directory: ${(error as Error).message}`;
    throw new ConfigValidationError('config/cases', '$', reason);
  }

  if (files.length === 0) {
    throw new ConfigValidationError('config/cases', '$', 'no case JSON files found');
  }

  return Promise.all(
    files.map(async (file) => ({
      file: path.join(relativeDirectory, file),
      value: await parseJsonFile(contentRoot, path.join(relativeDirectory, file), caseSchema),
    })),
  );
}

function assertUniqueCaseIds(cases: Awaited<ReturnType<typeof loadCases>>) {
  const seen = new Set<string>();
  for (const trainingCase of cases) {
    if (seen.has(trainingCase.value.id)) {
      throw new ConfigValidationError(
        trainingCase.file,
        'id',
        `duplicate case id ${trainingCase.value.id}`,
      );
    }
    seen.add(trainingCase.value.id);
  }
}

async function validateMaterialRef(
  contentRoot: string,
  relativeCaseFile: string,
  field: string,
  materialRef: string,
) {
  if (materialRef.includes('\\')) {
    throw new ConfigValidationError(relativeCaseFile, field, 'materialRef must use an assets/ path');
  }
  const normalized = path.posix.normalize(materialRef);
  if (!normalized.startsWith('assets/') || normalized === 'assets/') {
    throw new ConfigValidationError(relativeCaseFile, field, 'materialRef must stay inside assets/');
  }
  const assetsRoot = path.resolve(contentRoot, 'assets');
  const absoluteFile = path.resolve(contentRoot, ...normalized.split('/'));
  if (!absoluteFile.startsWith(`${assetsRoot}${path.sep}`)) {
    throw new ConfigValidationError(relativeCaseFile, field, 'materialRef must stay inside assets/');
  }
  try {
    const [resolvedAssetsRoot, resolvedFile] = await Promise.all([
      realpath(assetsRoot),
      realpath(absoluteFile),
    ]);
    if (!resolvedFile.startsWith(`${resolvedAssetsRoot}${path.sep}`)) {
      throw new Error('materialRef escapes assets/');
    }
    const info = await stat(resolvedFile);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw new ConfigValidationError(relativeCaseFile, field, `materialRef is missing: ${materialRef}`);
  }
}

export async function validateReferences(
  config: LoadedConfig,
  contentRoot?: string,
  caseFiles: readonly string[] = config.cases.map((trainingCase) => `config/cases/${trainingCase.id}.json`),
) {
  const nodeIds = new Set(config.knowledgeModel.nodes.map((node) => node.id));
  const misconceptionIds = new Set(
    config.knowledgeModel.nodes.flatMap((node) =>
      node.misconceptions.map((misconception) => misconception.id),
    ),
  );
  const rubricIds = new Set(config.rubrics.rubrics.map((rubric) => rubric.id));
  const followingAnchorIds = new Set(config.rubrics.followingAnchors.map((anchor) => anchor.id));
  const scaffoldLevels = new Set(config.scaffoldPolicy.levels.map((level) => level.level));
  const rubricNodeIds = new Set<string>();

  config.rubrics.rubrics.forEach((rubric, index) => {
    if (!nodeIds.has(rubric.nodeId)) {
      throw new ConfigValidationError(
        'config/rubrics.json',
        `rubrics.${index}.nodeId`,
        `unknown knowledge node ${rubric.nodeId}`,
      );
    }
    if (rubricNodeIds.has(rubric.nodeId)) {
      throw new ConfigValidationError(
        'config/rubrics.json',
        `rubrics.${index}.nodeId`,
        `duplicate rubric for knowledge node ${rubric.nodeId}`,
      );
    }
    rubricNodeIds.add(rubric.nodeId);
    if (rubric.followingAnchorId && !followingAnchorIds.has(rubric.followingAnchorId)) {
      throw new ConfigValidationError(
        'config/rubrics.json',
        `rubrics.${index}.followingAnchorId`,
        `unknown following anchor ${rubric.followingAnchorId}`,
      );
    }
  });

  for (const nodeId of nodeIds) {
    if (!rubricNodeIds.has(nodeId)) {
      throw new ConfigValidationError(
        'config/rubrics.json',
        'rubrics',
        `missing rubric for knowledge node ${nodeId}`,
      );
    }
  }

  const feedbackNodeId = config.rubrics.policy.equation.feedbackNodeId;
  if (!nodeIds.has(feedbackNodeId)) {
    throw new ConfigValidationError(
      'config/rubrics.json',
      'policy.equation.feedbackNodeId',
      `unknown knowledge node ${feedbackNodeId}`,
    );
  }
  for (const nodeId of Object.keys(config.rubrics.policy.weighting.nodeOverrides)) {
    if (!nodeIds.has(nodeId)) {
      throw new ConfigValidationError(
        'config/rubrics.json',
        `policy.weighting.nodeOverrides.${nodeId}`,
        `unknown knowledge node ${nodeId}`,
      );
    }
  }

  const configFields = config as unknown as Record<string, unknown>;
  config.rubrics.adjudications.forEach((decision, index) => {
    const value = decision.configField.split('.').reduce<unknown>((current, segment) => {
      if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
      return (current as Record<string, unknown>)[segment];
    }, configFields);
    if (value === undefined) {
      throw new ConfigValidationError(
        'config/rubrics.json',
        `adjudications.${index}.configField`,
        `unknown config field ${decision.configField}`,
      );
    }
  });

  config.pretest.questions.forEach((question, questionIndex) => {
    question.rubricIds.forEach((rubricId, rubricIndex) => {
      if (!rubricIds.has(rubricId)) {
        throw new ConfigValidationError(
          'config/pretest.json',
          `questions.${questionIndex}.rubricIds.${rubricIndex}`,
          `unknown rubric ${rubricId}`,
        );
      }
    });
    question.targetNodeIds.forEach((nodeId, nodeIndex) => {
      if (!nodeIds.has(nodeId)) {
        throw new ConfigValidationError(
          'config/pretest.json',
          `questions.${questionIndex}.targetNodeIds.${nodeIndex}`,
          `unknown knowledge node ${nodeId}`,
        );
      }
    });
    if (question.type === 'choice') {
      question.options.forEach((option, optionIndex) => {
        option.misconceptionIds.forEach((misconceptionId, misconceptionIndex) => {
          if (!misconceptionIds.has(misconceptionId)) {
            throw new ConfigValidationError(
              'config/pretest.json',
              `questions.${questionIndex}.options.${optionIndex}.misconceptionIds.${misconceptionIndex}`,
              `unknown misconception ${misconceptionId}`,
            );
          }
        });
      });
    }
  });

  config.pretest.builder.components.forEach((component, componentIndex) => {
    component.distractor?.misconceptionIds.forEach((misconceptionId, misconceptionIndex) => {
      if (!misconceptionIds.has(misconceptionId)) {
        throw new ConfigValidationError(
          'config/pretest.json',
          `builder.components.${componentIndex}.distractor.misconceptionIds.${misconceptionIndex}`,
          `unknown misconception ${misconceptionId}`,
        );
      }
    });
  });

  config.cases.forEach((trainingCase, caseIndex) => {
    const relativeCaseFile = caseFiles[caseIndex] ?? `config/cases/${trainingCase.id}.json`;
    trainingCase.targetNodeIds.forEach((nodeId, nodeIndex) => {
      if (!nodeIds.has(nodeId)) {
        throw new ConfigValidationError(
          relativeCaseFile,
          `targetNodeIds.${nodeIndex}`,
          `unknown knowledge node ${nodeId} in case index ${caseIndex}`,
        );
      }
    });
    trainingCase.scaffold.forEach((entry, scaffoldIndex) => {
      if (!scaffoldLevels.has(entry.level)) {
        throw new ConfigValidationError(
          relativeCaseFile,
          `scaffold.${scaffoldIndex}.level`,
          `unknown scaffold policy level ${entry.level}`,
        );
      }
    });
    trainingCase.evidencePaths.forEach((evidencePath, evidenceIndex) => {
      if (!nodeIds.has(evidencePath.nodeId)) {
        throw new ConfigValidationError(
          relativeCaseFile,
          `evidencePaths.${evidenceIndex}.nodeId`,
          `unknown knowledge node ${evidencePath.nodeId}`,
        );
      }
    });
    trainingCase.followingAnchors.forEach((anchor, anchorIndex) => {
      if (!followingAnchorIds.has(anchor.id)) {
        throw new ConfigValidationError(
          relativeCaseFile,
          `followingAnchors.${anchorIndex}.id`,
          `unknown following anchor ${anchor.id}`,
        );
      }
    });
    trainingCase.equationSets.forEach((equationSet, equationIndex) => {
      if (equationSet.medium !== trainingCase.medium) {
        throw new ConfigValidationError(
          relativeCaseFile,
          `equationSets.${equationIndex}.medium`,
          `must match case medium ${trainingCase.medium}`,
        );
      }
      equationSet.accepted.forEach((accepted, acceptedIndex) => {
        const analysis = analyzeEquation(accepted, {
          kind: equationSet.electrode === 'overall' ? 'overall' : 'half',
          medium: equationSet.medium,
          expectedElectronSide: equationSet.expectedElectronSide,
        });
        if (analysis.status === 'parse-error') {
          throw new ConfigValidationError(
            relativeCaseFile,
            `equationSets.${equationIndex}.accepted.${acceptedIndex}`,
            `equation-parse-miss: ${analysis.error.message}`,
          );
        }
        if (!analysis.valid) {
          throw new ConfigValidationError(
            relativeCaseFile,
            `equationSets.${equationIndex}.accepted.${acceptedIndex}`,
            'configured equation must satisfy atom, charge, electron, and medium checks',
          );
        }
      });
    });
  });

  if (contentRoot) {
    await Promise.all(
      config.cases.flatMap((trainingCase, caseIndex) =>
        trainingCase.materials.flatMap((material, materialIndex) =>
          material.materialRef === null
            ? []
            : [
                validateMaterialRef(
                  contentRoot,
                  caseFiles[caseIndex] ?? `config/cases/${trainingCase.id}.json`,
                  `materials.${materialIndex}.materialRef`,
                  material.materialRef,
                ),
              ],
        ),
      ),
    );
  }
}

async function listConfigFiles(directory: string, relativeDirectory = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativeFile = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await listConfigFiles(directory, relativeFile)));
    else if (entry.isFile()) files.push(relativeFile);
  }
  return files.sort();
}

async function deriveConfigVersion(contentRoot: string) {
  const configRoot = path.join(contentRoot, 'config');
  const hash = createHash('sha256');
  let files: string[];
  try {
    files = await listConfigFiles(configRoot);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'directory is missing'
      : `cannot read directory: ${(error as Error).message}`;
    throw new ConfigValidationError('config', '$', reason);
  }
  for (const relativeFile of files) {
    const contents = await readFile(path.join(configRoot, relativeFile));
    const normalizedPath = relativeFile.split(path.sep).join('/');
    hash.update(`${Buffer.byteLength(normalizedPath)}:${normalizedPath}:${contents.length}:`);
    hash.update(contents);
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function loadAllConfig(contentRoot: string): Promise<LoadedConfig> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const configVersion = await deriveConfigVersion(contentRoot);
    const knowledgeModel = await parseJsonFile(
      contentRoot,
      'config/knowledge-model.json',
      knowledgeModelSchema,
    );
    const rubrics = await parseJsonFile(contentRoot, 'config/rubrics.json', rubricsSchema);
    const pretest = await parseJsonFile(contentRoot, 'config/pretest.json', pretestSchema);
    const loadedCases = await loadCases(contentRoot);
    const scaffoldPolicy = await parseJsonFile(
      contentRoot,
      'config/scaffold-policy.json',
      scaffoldPolicySchema,
    );

    assertUniqueCaseIds(loadedCases);
    const cases = loadedCases.map((entry) => entry.value);
    const config = { configVersion, knowledgeModel, rubrics, pretest, cases, scaffoldPolicy };
    await validateReferences(config, contentRoot, loadedCases.map((entry) => entry.file));
    if (await deriveConfigVersion(contentRoot) === configVersion) return config;
  }
  throw new ConfigValidationError('config', '$', 'files changed while loading; retry the request');
}
