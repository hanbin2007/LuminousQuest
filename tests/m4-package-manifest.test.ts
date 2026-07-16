import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error The packaging helper is intentionally executable plain Node ESM.
import { writeSha256Manifest } from '../scripts/release-manifest.mjs';

describe('M4 release manifest', () => {
  it('writes a sorted SHA-256 inventory for the executable and external content tree', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'lq-release-manifest-'));
    const releaseRoot = path.join(temporary, 'release', 'darwin-arm64');
    const manifest = path.join(temporary, 'dist', 'release-darwin-arm64.sha256');
    await mkdir(path.join(releaseRoot, 'config'), { recursive: true });
    await writeFile(path.join(releaseRoot, 'LuminousQuest'), 'sea executable');
    await writeFile(path.join(releaseRoot, 'config', 'rubrics.json'), '{"version":"v1"}\n');

    const entries = await writeSha256Manifest({
      root: releaseRoot,
      outputFile: manifest,
      pathPrefix: 'release/darwin-arm64',
    });

    expect(entries.map((entry: { path: string }) => entry.path)).toEqual([
      'release/darwin-arm64/LuminousQuest',
      'release/darwin-arm64/config/rubrics.json',
    ]);
    const source = await readFile(manifest, 'utf8');
    expect(source).toMatch(/^[a-f0-9]{64}  release\/darwin-arm64\/LuminousQuest$/m);
    expect(source).toMatch(/^[a-f0-9]{64}  release\/darwin-arm64\/config\/rubrics\.json$/m);
  });
});
