import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

export async function createTemporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'luminous-quest-test-'));
}

async function copyRepositoryFile(relativeSource: string, destination: string) {
  const source = await readFile(path.join(repositoryRoot, relativeSource));
  await writeFile(destination, source);
}

export async function writeValidContentTree(root: string) {
  const configRoot = path.join(root, 'config');
  const casesRoot = path.join(configRoot, 'cases');
  const promptsRoot = path.join(root, 'prompts');
  const assetsRoot = path.join(root, 'assets');
  await mkdir(casesRoot, { recursive: true });
  await mkdir(promptsRoot, { recursive: true });
  await mkdir(assetsRoot, { recursive: true });

  await Promise.all([
    ...['knowledge-model.json', 'rubrics.json', 'pretest.json', 'scaffold-policy.json'].map((file) =>
      copyRepositoryFile(path.join('config', file), path.join(configRoot, file)),
    ),
    copyRepositoryFile(
      path.join('config', 'cases', 'zinc-copper.json'),
      path.join(casesRoot, 'zinc-copper.json'),
    ),
    copyRepositoryFile(
      path.join('prompts', 'structured-assessment.md'),
      path.join(promptsRoot, 'structured-assessment.md'),
    ),
    copyRepositoryFile(
      path.join('prompts', 'socratic-tutoring.md'),
      path.join(promptsRoot, 'socratic-tutoring.md'),
    ),
  ]);
  await writeFile(path.join(promptsRoot, 'test.md'), 'Server-owned prompt v1');
}
