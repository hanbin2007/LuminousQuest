import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  buildClassSummary,
  buildTeacherStudentReport,
  importClassSessionFiles,
  MAX_CLASS_SESSION_FILES,
  MAX_CLASS_SESSION_FILE_BYTES,
  readClassSessionFileBatch,
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
      evidence: [{ quote: '电子从铜极经导线流向锌极。', start: 0, end: 13 }],
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

  it('rejects invalid, duplicate, and rubric-version-mismatched files with anonymous per-file messages', async () => {
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
      expect.objectContaining({ name: '批次文件 2', code: 'duplicate-session' }),
      expect.objectContaining({ name: '批次文件 3', code: 'invalid-json' }),
      expect.objectContaining({ name: '批次文件 4', code: 'rubric-version-mismatch' }),
    ]);
    expect(result.rejected.map((item) => item.message).every(Boolean)).toBe(true);
    expect(JSON.stringify(result.rejected)).not.toMatch(/duplicate\.json|invalid\.json|old-rubric\.json|teacher-fixture-session-a/u);
  });

  it('reads a bounded batch with allSettled so one oversized or unreadable file does not block peers', async () => {
    const [valid] = await fixtureFiles();
    const uploads = Array.from({ length: MAX_CLASS_SESSION_FILES + 1 }, (_, index) => ({
      size: index === 1 ? MAX_CLASS_SESSION_FILE_BYTES + 1 : valid.text.length,
      text: async () => {
        if (index === 2) throw new Error('private source path must not escape');
        return valid.text;
      },
    }));

    const batch = await readClassSessionFileBatch(uploads);

    expect(batch.files).toHaveLength(MAX_CLASS_SESSION_FILES - 2);
    expect(batch.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '批次文件 2', code: 'file-too-large' }),
      expect.objectContaining({ name: '批次文件 3', code: 'file-read-failed' }),
      expect.objectContaining({ name: `批次文件 ${MAX_CLASS_SESSION_FILES + 1}`, code: 'too-many-files' }),
    ]));
    expect(JSON.stringify(batch.rejected)).not.toContain('private source path must not escape');
  });

  it('uses the latest session per anonymous student for every class statistic', async () => {
    const config = await loadAllConfig(process.cwd());
    const sources = await fixtureFiles();
    const sessions = sources.map((source) => JSON.parse(source.text) as Record<string, any>);
    const replacement = structuredClone(sessions[2]);
    replacement.id = 'latest-session-for-teach001';
    replacement.anonymousStudentId = sessions[0].anonymousStudentId;
    replacement.updatedAt = '2026-07-16T04:00:00.000Z';

    const summary = buildClassSummary([sessions[0], sessions[1], replacement], config, 3);
    const expected = buildClassSummary([sessions[1], replacement], config, 3);

    expect(summary).toMatchObject({ sessionCount: 2, inputSessionCount: 3 });
    expect(summary.dimensions).toEqual(expected.dimensions);
    expect(summary.nodeErrorRates).toEqual(expected.nodeErrorRates);
    expect(summary.misconceptions).toEqual(expected.misconceptions);
  });

  it('counts misconceptions from the same latest assessment selected for the profile score', async () => {
    const config = await loadAllConfig(process.cwd());
    const [source] = await fixtureFiles();
    const session = JSON.parse(source.text) as Record<string, any>;
    const answer = '电子由锌极经外电路流向铜极，盐桥阴离子移向锌盐一侧。';
    session.events.push({
      schemaVersion: 'event.v2', id: 'latest-answer-p4', sequence: 10,
      occurredAt: '2026-07-16T01:10:00.000Z', caseId: 'zinc-copper', stageId: 'training',
      attemptId: 'latest-p4', kind: 'answer.submitted', pipelineStage: 'answer',
      questionId: 'zinc-copper:analysis', answer: { format: 'text', value: answer },
    }, {
      ...structuredClone(session.events.find((event: any) => event.id === 'a-assessment-p4')),
      id: 'latest-assessment-p4', sequence: 11, occurredAt: '2026-07-16T01:10:01.000Z',
      attemptId: 'latest-p4', sourceAnswerEventId: 'latest-answer-p4', misconceptionIds: [],
      objectiveOutcome: 'hit',
      extraction: {
        status: 'assessed', evidence: [{ quote: answer, start: 0, end: answer.length }],
        model: 'fixture-v1',
        provenance: { promptId: 'structured-assessment', promptVersion: 'fixture-prompt.v1', cacheKey: 'latest-p4' },
      },
      ruleDecision: {
        status: 'hit', ruleId: 'p4-hit', reason: '电子与离子路径方向正确。',
        engine: { id: 'rubric-policy', version: 'rubric-policy.v2' },
      },
      score: { status: 'scored', earned: 2, possible: 2, annotations: [], outcome: 'hit' },
    });
    session.updatedAt = '2026-07-16T01:10:01.000Z';

    const summary = buildClassSummary([session], config);

    expect(summary.nodeErrorRates.find((item) => item.nodeId === 'P4')).toMatchObject({
      errorCount: 0,
      assessedCount: 1,
    });
    expect(summary.misconceptions.some((item) => item.id === 'P4-M1')).toBe(false);
  });
});
