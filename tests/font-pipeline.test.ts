import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('Source Han Serif SC offline subset', () => {
  it('covers the bundled interface corpus', () => {
    const output = execFileSync(process.execPath, ['scripts/subset-font.mjs', '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(output).toMatch(/Font subset covers \d+ code points locally/);
  });

  it('does not couple a frozen client build to hot-loaded case configuration', () => {
    const output = execFileSync(process.execPath, ['scripts/subset-font.mjs', '--list-corpus'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const files = output.trim().split('\n');

    expect(files.some((file) => file.includes('/src/'))).toBe(true);
    expect(files.some((file) => file.includes('/config/'))).toBe(false);
  });

  it('still includes the baseline rubric and cases when generating a fresh build', () => {
    const output = execFileSync(process.execPath, ['scripts/subset-font.mjs', '--list-build-corpus'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const files = output.trim().split('\n');

    expect(files.some((file) => file.includes('/src/'))).toBe(true);
    expect(files.some((file) => file.includes('/config/cases/'))).toBe(true);
    expect(files.some((file) => file.endsWith('/config/rubrics.json'))).toBe(true);
  });
});
