import path from 'node:path';
import { isSea } from 'node:sea';

export function resolveContentRoot(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.LQ_CONTENT_DIR) return path.resolve(environment.LQ_CONTENT_DIR);
  return isSea() ? path.dirname(process.execPath) : process.cwd();
}

export function resolveClientRoot(contentRoot: string) {
  return path.join(contentRoot, 'dist', 'client');
}

