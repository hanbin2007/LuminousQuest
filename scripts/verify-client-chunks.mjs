import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(projectRoot, 'dist', 'client', '.vite', 'manifest.json');
const routeSources = [
  'src/features/pretest/PretestPage.tsx',
  'src/features/training/TrainingPage.tsx',
  'src/features/teacher/TeacherPage.tsx',
  'src/features/model/ModelPage.tsx',
];

export function verifyRouteChunks(manifest) {
  const entry = Object.values(manifest).find((item) => item.isEntry);
  if (!entry) throw new Error('Client manifest does not contain an entry chunk');

  const files = new Set();
  for (const source of routeSources) {
    const chunk = manifest[source];
    if (!chunk) throw new Error(`Client manifest is missing route chunk: ${source}`);
    if (!chunk.isDynamicEntry) throw new Error(`Route is not a dynamic entry: ${source}`);
    if (chunk.file === entry.file) throw new Error(`Route leaked into the main entry chunk: ${source}`);
    if (files.has(chunk.file)) throw new Error(`Routes unexpectedly share one chunk: ${chunk.file}`);
    files.add(chunk.file);
  }
  return { entry: entry.file, routeFiles: [...files] };
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const result = verifyRouteChunks(manifest);
  console.log(`[chunks] Main entry: ${result.entry}`);
  result.routeFiles.forEach((file) => console.log(`[chunks] Route: ${file}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[chunks] ${error.message}`);
    process.exitCode = 1;
  });
}
