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

export async function writeValidContentTree(
  root: string,
  options: { includeTransfer?: boolean } = {},
) {
  const configRoot = path.join(root, 'config');
  const casesRoot = path.join(configRoot, 'cases');
  const promptsRoot = path.join(root, 'prompts');
  const assetsRoot = path.join(root, 'assets');
  const examAssetsRoot = path.join(assetsRoot, 'exam');
  const zincAssetsRoot = path.join(assetsRoot, 'cases', 'zinc-copper');
  const aluminumAssetsRoot = path.join(assetsRoot, 'cases', 'aluminum-air');
  const methaneAssetsRoot = path.join(assetsRoot, 'cases', 'methane-fuel');
  await mkdir(casesRoot, { recursive: true });
  await mkdir(promptsRoot, { recursive: true });
  await mkdir(examAssetsRoot, { recursive: true });
  await mkdir(zincAssetsRoot, { recursive: true });
  await mkdir(aluminumAssetsRoot, { recursive: true });
  if (options.includeTransfer) await mkdir(methaneAssetsRoot, { recursive: true });

  await Promise.all([
    ...['knowledge-model.json', 'rubrics.json', 'pretest.json', 'scaffold-policy.json'].map((file) =>
      copyRepositoryFile(path.join('config', file), path.join(configRoot, file)),
    ),
    copyRepositoryFile(
      path.join('config', 'cases', 'zinc-copper.json'),
      path.join(casesRoot, 'zinc-copper.json'),
    ),
    copyRepositoryFile(
      path.join('config', 'cases', 'aluminum-air.json'),
      path.join(casesRoot, 'aluminum-air.json'),
    ),
    copyRepositoryFile(
      path.join('assets', 'cases', 'zinc-copper', 'schematic.png'),
      path.join(zincAssetsRoot, 'schematic.png'),
    ),
    copyRepositoryFile(
      path.join('assets', 'exam', 'q1-k-o2.png'),
      path.join(examAssetsRoot, 'q1-k-o2.png'),
    ),
    copyRepositoryFile(
      path.join('assets', 'exam', 'q4-glucose-implant.png'),
      path.join(examAssetsRoot, 'q4-glucose-implant.png'),
    ),
    copyRepositoryFile(
      path.join('assets', 'cases', 'aluminum-air', 'schematic.png'),
      path.join(aluminumAssetsRoot, 'schematic.png'),
    ),
    copyRepositoryFile(
      path.join('assets', 'cases', 'aluminum-air', 'cross-section.png'),
      path.join(aluminumAssetsRoot, 'cross-section.png'),
    ),
    ...(options.includeTransfer ? [
      copyRepositoryFile(
        path.join('config', 'cases', 'methane-fuel.json'),
        path.join(casesRoot, 'methane-fuel.json'),
      ),
      copyRepositoryFile(
        path.join('assets', 'cases', 'methane-fuel', 'schematic.png'),
        path.join(methaneAssetsRoot, 'schematic.png'),
      ),
    ] : []),
    copyRepositoryFile(
      path.join('prompts', 'structured-assessment.md'),
      path.join(promptsRoot, 'structured-assessment.md'),
    ),
    copyRepositoryFile(
      path.join('prompts', 'direct-assessment.md'),
      path.join(promptsRoot, 'direct-assessment.md'),
    ),
    copyRepositoryFile(
      path.join('prompts', 'socratic-tutoring.md'),
      path.join(promptsRoot, 'socratic-tutoring.md'),
    ),
  ]);
  await writeFile(path.join(promptsRoot, 'test.md'), 'Server-owned prompt v1');
}
