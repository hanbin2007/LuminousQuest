import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { importEvalCandidates } from './import-candidates';

export async function runCandidateImportCli(contentRoot = process.cwd()) {
  try {
    const result = await importEvalCandidates({ contentRoot });
    console.log(`Imported ${result.imported.length} pending eval case(s); skipped ${result.skipped.length}.`);
    result.skipped.forEach((entry) => console.error(`Skipped ${entry.file}: ${entry.reason}`));
    return result.skipped.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`Eval candidate import failed: ${(error as Error).message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedDirectly) {
  void runCandidateImportCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
