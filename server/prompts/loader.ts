import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface LoadedPrompt {
  id: string;
  version: string;
  text: string;
}

export class PromptValidationError extends Error {
  constructor(
    readonly file: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${file}: ${field}: ${reason}`);
    this.name = 'PromptValidationError';
  }
}

export async function loadAllPrompts(contentRoot: string): Promise<Record<string, LoadedPrompt>> {
  const promptsRoot = path.join(contentRoot, 'prompts');
  let files: string[];
  try {
    files = (await readdir(promptsRoot))
      .filter((file) => file.endsWith('.md'))
      .sort();
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'directory is missing'
      : `cannot read directory: ${(error as Error).message}`;
    throw new PromptValidationError('prompts', '$', reason);
  }
  if (files.length === 0) {
    throw new PromptValidationError('prompts', '$', 'no prompt markdown files found');
  }

  const prompts: Record<string, LoadedPrompt> = {};
  for (const file of files) {
    const id = path.basename(file, '.md');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new PromptValidationError(`prompts/${file}`, '$', 'filename is not a valid prompt id');
    }
    if (prompts[id]) {
      throw new PromptValidationError(`prompts/${file}`, '$', `duplicate prompt id ${id}`);
    }
    const text = await readFile(path.join(promptsRoot, file), 'utf8');
    if (text.trim().length === 0) {
      throw new PromptValidationError(`prompts/${file}`, '$', 'file is empty');
    }
    prompts[id] = {
      id,
      version: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      text,
    };
  }
  return prompts;
}

export async function loadPrompt(contentRoot: string, id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  return (await loadAllPrompts(contentRoot))[id] ?? null;
}
