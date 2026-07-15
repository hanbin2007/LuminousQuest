import { readdir, readFile } from 'node:fs/promises';
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
    files.map((file) => parseJsonFile(contentRoot, path.join(relativeDirectory, file), caseSchema)),
  );
}

function validateReferences(config: LoadedConfig) {
  const nodeIds = new Set(config.knowledgeModel.nodes.map((node) => node.id));
  const rubricIds = new Set(config.rubrics.rubrics.map((rubric) => rubric.id));

  config.rubrics.rubrics.forEach((rubric, index) => {
    if (!nodeIds.has(rubric.nodeId)) {
      throw new ConfigValidationError(
        'config/rubrics.json',
        `rubrics.${index}.nodeId`,
        `unknown knowledge node ${rubric.nodeId}`,
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
  });

  config.cases.forEach((trainingCase, caseIndex) => {
    trainingCase.targetNodeIds.forEach((nodeId, nodeIndex) => {
      if (!nodeIds.has(nodeId)) {
        throw new ConfigValidationError(
          `config/cases/${trainingCase.id}.json`,
          `targetNodeIds.${nodeIndex}`,
          `unknown knowledge node ${nodeId} in case index ${caseIndex}`,
        );
      }
    });
  });
}

export async function loadAllConfig(contentRoot: string): Promise<LoadedConfig> {
  const [knowledgeModel, rubrics, pretest, cases, scaffoldPolicy] = await Promise.all([
    parseJsonFile(contentRoot, 'config/knowledge-model.json', knowledgeModelSchema),
    parseJsonFile(contentRoot, 'config/rubrics.json', rubricsSchema),
    parseJsonFile(contentRoot, 'config/pretest.json', pretestSchema),
    loadCases(contentRoot),
    parseJsonFile(contentRoot, 'config/scaffold-policy.json', scaffoldPolicySchema),
  ]);

  const config = { knowledgeModel, rubrics, pretest, cases, scaffoldPolicy };
  validateReferences(config);
  return config;
}

