import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('Source Han Serif SC offline subset', () => {
  it('covers the current rubric, case, and interface corpus', () => {
    const output = execFileSync(process.execPath, ['scripts/subset-font.mjs', '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(output).toMatch(/Font subset covers \d+ code points locally/);
  });
});
