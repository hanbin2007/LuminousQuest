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
import { normalizeComparisonText } from '../../shared/fact-value-normalization';
import {
  analyzeEquation,
  canonicalizeEquation,
  combineHalfReactionsCanonical,
  equationGrammarVersion,
  equationScoringEngineVersion,
  scoreEquation,
} from '../../shared/chemistry/equation';
import { rubricPolicyEngineVersion } from '../../shared/scoring/rubric';
import { topologyEngineVersion } from '../../shared/scoring/topology';

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
  const sequences = new Set<number>();
  for (const trainingCase of cases) {
    if (seen.has(trainingCase.value.id)) {
      throw new ConfigValidationError(
        trainingCase.file,
        'id',
        `duplicate case id ${trainingCase.value.id}`,
      );
    }
    seen.add(trainingCase.value.id);
    if (sequences.has(trainingCase.value.sequence)) {
      throw new ConfigValidationError(
        trainingCase.file,
        'sequence',
        `duplicate case sequence ${trainingCase.value.sequence}`,
      );
    }
    sequences.add(trainingCase.value.sequence);
  }
}

async function validateAssetRef(
  contentRoot: string,
  relativeConfigFile: string,
  field: string,
  assetRef: string,
  referenceName: string,
) {
  if (assetRef.includes('\\')) {
    throw new ConfigValidationError(relativeConfigFile, field, `${referenceName} must use an assets/ path`);
  }
  const normalized = path.posix.normalize(assetRef);
  if (!normalized.startsWith('assets/') || normalized === 'assets/') {
    throw new ConfigValidationError(relativeConfigFile, field, `${referenceName} must stay inside assets/`);
  }
  const assetsRoot = path.resolve(contentRoot, 'assets');
  const absoluteFile = path.resolve(contentRoot, ...normalized.split('/'));
  if (!absoluteFile.startsWith(`${assetsRoot}${path.sep}`)) {
    throw new ConfigValidationError(relativeConfigFile, field, `${referenceName} must stay inside assets/`);
  }
  try {
    const [resolvedAssetsRoot, resolvedFile] = await Promise.all([
      realpath(assetsRoot),
      realpath(absoluteFile),
    ]);
    if (!resolvedFile.startsWith(`${resolvedAssetsRoot}${path.sep}`)) {
      throw new Error(`${referenceName} escapes assets/`);
    }
    const info = await stat(resolvedFile);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw new ConfigValidationError(relativeConfigFile, field, `${referenceName} is missing: ${assetRef}`);
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
  const factValueAliases = config.scaffoldPolicy.extraction.factValueAliases;
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
    } else {
      question.evidence?.forEach((evidence, evidenceIndex) => {
        if (!question.targetNodeIds.includes(evidence.nodeId)) {
          throw new ConfigValidationError(
            'config/pretest.json',
            `questions.${questionIndex}.evidence.${evidenceIndex}.nodeId`,
            `evidence node ${evidence.nodeId} must be a question target`,
          );
        }
        evidence.factRequirements.forEach((requirement, requirementIndex) => {
          requirement.acceptedValues.forEach((acceptedValue, acceptedValueIndex) => {
            if (Object.hasOwn(factValueAliases, acceptedValue)) return;
            throw new ConfigValidationError(
              'config/pretest.json',
              `questions.${questionIndex}.evidence.${evidenceIndex}.factRequirements.${requirementIndex}.acceptedValues.${acceptedValueIndex}`,
              `accepted value ${acceptedValue} is not defined in factValueAliases`,
            );
          });
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
      if (entry.level === 1) {
        entry.fields.forEach((field, fieldIndex) => {
          const node = config.knowledgeModel.nodes.find((candidate) => candidate.id === field.nodeId);
          if (!node) {
            throw new ConfigValidationError(
              relativeCaseFile,
              `scaffold.${scaffoldIndex}.fields.${fieldIndex}.nodeId`,
              `unknown knowledge node ${field.nodeId}`,
            );
          }
          if (node.dimensionId !== field.dimensionId) {
            throw new ConfigValidationError(
              relativeCaseFile,
              `scaffold.${scaffoldIndex}.fields.${fieldIndex}.dimensionId`,
              `must match ${field.nodeId} dimension ${node.dimensionId}`,
            );
          }
        });
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
      equationSet.crossMediumAccepted.forEach((family, familyIndex) => {
        if (family.medium === equationSet.medium) {
          throw new ConfigValidationError(
            relativeCaseFile,
            `equationSets.${equationIndex}.crossMediumAccepted.${familyIndex}.medium`,
            'cross-medium family must use a different medium',
          );
        }
        family.accepted.forEach((accepted, acceptedIndex) => {
          const analysis = analyzeEquation(accepted, {
            kind: equationSet.electrode === 'overall' ? 'overall' : 'half',
            medium: family.medium,
            expectedElectronSide: equationSet.expectedElectronSide,
          });
          if (analysis.status !== 'parsed' || !analysis.valid) {
            throw new ConfigValidationError(
              relativeCaseFile,
              `equationSets.${equationIndex}.crossMediumAccepted.${familyIndex}.accepted.${acceptedIndex}`,
              'cross-medium equation must parse and satisfy conservation in its declared medium',
            );
          }
        });
      });
    });
    const negative = trainingCase.equationSets.find((entry) => entry.electrode === 'negative')!;
    const positive = trainingCase.equationSets.find((entry) => entry.electrode === 'positive')!;
    const overall = trainingCase.equationSets.find((entry) => entry.electrode === 'overall')!;
    const overallCanonical = new Set(overall.accepted.map(canonicalizeEquation));
    for (const oxidation of negative.accepted) {
      for (const reduction of positive.accepted) {
        const combined = combineHalfReactionsCanonical(
          oxidation,
          reduction,
          trainingCase.medium,
        );
        if (!overallCanonical.has(combined.canonical)) {
          throw new ConfigValidationError(
            relativeCaseFile,
            'equationSets',
            `combined half reactions do not match an accepted overall equation: ${oxidation} + ${reduction}`,
          );
        }
      }
    }
  });

  config.pretest.questions.forEach((question, questionIndex) => {
    if (question.type !== 'text') return;
    question.referenceEquations.forEach((reference, referenceIndex) => {
      const trainingCase = config.cases.find((entry) => entry.id === reference.caseId);
      const equationSet = trainingCase?.equationSets.find((entry) => entry.id === reference.equationSetId);
      if (!trainingCase || !equationSet) {
        throw new ConfigValidationError(
          'config/pretest.json',
          `questions.${questionIndex}.referenceEquations.${referenceIndex}.equationSetId`,
          `unknown equation set ${reference.caseId}/${reference.equationSetId}`,
        );
      }
      if (scoreEquation(reference.equation, equationSet, config.rubrics.policy).outcome !== 'hit') {
        throw new ConfigValidationError(
          'config/pretest.json',
          `questions.${questionIndex}.referenceEquations.${referenceIndex}.equation`,
          'official reference equation must be accepted by its configured grammar corpus',
        );
      }
    });
  });

  if (contentRoot) {
    await Promise.all(
      [
        ...config.cases.flatMap((trainingCase, caseIndex) =>
          trainingCase.materials.flatMap((material, materialIndex) =>
            material.materialRef === null
              ? []
              : [
                  validateAssetRef(
                    contentRoot,
                    caseFiles[caseIndex] ?? `config/cases/${trainingCase.id}.json`,
                    `materials.${materialIndex}.materialRef`,
                    material.materialRef,
                    'materialRef',
                  ),
                ],
          ),
        ),
        ...config.pretest.questions.flatMap((question, questionIndex) =>
          question.group
            ? [validateAssetRef(
                contentRoot,
                'config/pretest.json',
                `questions.${questionIndex}.group.figure`,
                question.group.figure,
                'figure',
              )]
            : []),
      ],
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

function warnFactValueAliasCollisions(scaffoldPolicy: LoadedConfig['scaffoldPolicy']) {
  const aliases = scaffoldPolicy.extraction.factValueAliases;
  const commonTypos = scaffoldPolicy.extraction.citation.commonTypos;
  const canonicalValuesByToken = new Map<string, Set<string>>();

  for (const [canonicalValue, configuredAliases] of Object.entries(aliases)) {
    for (const value of [canonicalValue, ...configuredAliases]) {
      const token = normalizeComparisonText(value, commonTypos);
      if (token.length === 0) continue;
      const canonicalValues = canonicalValuesByToken.get(token) ?? new Set<string>();
      canonicalValues.add(canonicalValue);
      canonicalValuesByToken.set(token, canonicalValues);
    }
  }

  for (const [token, canonicalValues] of canonicalValuesByToken) {
    if (canonicalValues.size < 2) continue;
    console.warn(
      `[config] factValueAliases normalized token ${JSON.stringify(token)} maps to multiple canonical values: ${[...canonicalValues].sort().join(', ')}`,
    );
  }
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
    const orderedCases = [...loadedCases].sort((left, right) =>
      left.value.sequence - right.value.sequence);
    const cases = orderedCases.map((entry) => entry.value);
    const config = {
      configVersion,
      runtimeVersions: {
        cases: Object.fromEntries(cases.map((trainingCase) => [trainingCase.id, trainingCase.version])),
        grammar: equationGrammarVersion,
        engines: {
          rubric: rubricPolicyEngineVersion,
          topology: topologyEngineVersion,
          equation: equationScoringEngineVersion,
        },
      },
      knowledgeModel,
      rubrics,
      pretest,
      cases,
      scaffoldPolicy,
    };
    await validateReferences(config, contentRoot, orderedCases.map((entry) => entry.file));
    if (await deriveConfigVersion(contentRoot) === configVersion) {
      warnFactValueAliasCollisions(scaffoldPolicy);
      return config;
    }
  }
  throw new ConfigValidationError('config', '$', 'files changed while loading; retry the request');
}
