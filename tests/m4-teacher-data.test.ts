import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  buildClassSummary,
  buildTeacherStudentReport,
  importClassSessionFiles,
} from '../src/features/teacher/teacher-data';

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'teacher');

async function fixtureFiles() {
  return Promise.all(['session-a.json', 'session-b.json', 'session-c.json'].map(async (name) => ({
    name,
    text: await readFile(path.join(fixtureRoot, name), 'utf8'),
  })));
}

describe('M4 teacher evidence and class aggregation', () => {
  it('builds a traceable student report with training, scaffold, and review queues', async () => {
    const config = await loadAllConfig(process.cwd());
    const imported = importClassSessionFiles(await fixtureFiles(), config);

    expect(imported.rejected).toEqual([]);
    const report = buildTeacherStudentReport(imported.accepted[0].session, config);

    expect(report.anonymousStudentId).toBe('anon-TEACH001');
    expect(report.evidence.find((item) => item.nodeId === 'P4')).toMatchObject({
      rubricId: 'rubric-p4',
      rubricVersion: config.rubrics.version,
      ruleId: 'p4-miss',
      originalAnswer: '电子从铜极经导线流向锌极。',
      evidenceQuotes: ['电子从铜极经导线流向锌极。'],
    });
    expect(report.trainingRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: 'zinc-copper', nodeId: 'P4', outcome: 'miss' }),
    ]));
    expect(report.scaffoldTrajectory).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'P4', level: '苏格拉底第 1 轮' }),
    ]));
    expect(report.needsReview).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'P6', reason: '回放证据与原文无法可靠对齐' }),
    ]));
  });

  it('aggregates three anonymous sessions into mean/distribution radar, error bars, and misconception top N', async () => {
    const config = await loadAllConfig(process.cwd());
    const imported = importClassSessionFiles(await fixtureFiles(), config);
    const summary = buildClassSummary(imported.accepted.map((item) => item.session), config, 3);

    expect(summary.sessionCount).toBe(3);
    expect(summary.anonymousStudentIds).toEqual([
      'anon-TEACH001',
      'anon-TEACH002',
      'anon-TEACH003',
    ]);
    expect(summary.dimensions.map((item) => item.dimensionId)).toEqual([
      'device',
      'principle',
      'energy',
    ]);
    expect(summary.dimensions.every((item) =>
      item.mean !== null && item.quartileLow !== null && item.quartileHigh !== null)).toBe(true);
    expect(summary.nodeErrorRates[0]).toMatchObject({
      nodeId: 'P4',
      dimensionId: 'principle',
      assessedCount: 3,
      errorCount: 3,
      rate: 1,
    });
    expect(summary.misconceptions[0]).toMatchObject({
      id: 'P4-M1',
      count: 2,
    });
  });

  it('rejects invalid, duplicate, and rubric-version-mismatched files with per-file messages', async () => {
    const config = await loadAllConfig(process.cwd());
    const [valid] = await fixtureFiles();
    const mismatched = JSON.parse(valid.text) as Record<string, any>;
    mismatched.id = 'session-mismatched-rubric';
    mismatched.configVersions.rubrics = 'rubrics.v999';

    const result = importClassSessionFiles([
      valid,
      { name: 'duplicate.json', text: valid.text },
      { name: 'invalid.json', text: '{not-json' },
      { name: 'old-rubric.json', text: JSON.stringify(mismatched) },
    ], config);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([
      expect.objectContaining({ name: 'duplicate.json', code: 'duplicate-session' }),
      expect.objectContaining({ name: 'invalid.json', code: 'invalid-json' }),
      expect.objectContaining({ name: 'old-rubric.json', code: 'rubric-version-mismatch' }),
    ]);
    expect(result.rejected.map((item) => item.message).every(Boolean)).toBe(true);
  });
});
