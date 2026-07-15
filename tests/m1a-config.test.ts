import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';

const expectedNodeIds = [
  'D1', 'D2', 'D3', 'D4', 'D5',
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7',
  'E1', 'E2', 'E3',
];

const expectedAdjudications = [
  ['1', 'rubrics.policy.outcomeScale.mode', 'three-state', 'teacher-confirmed'],
  ['2', 'rubrics.policy.followingError.strategy', 'score-logical-chain', 'teacher-confirmed'],
  ['3', 'rubrics.policy.terminology.colloquialCorrectOutcome', 'hit', 'teacher-tuning'],
  ['4', 'rubrics.policy.beyondSyllabus.correctOutcome', 'hit', 'teacher-confirmed'],
  ['5', 'rubrics.policy.contradiction.outcome', 'miss', 'teacher-tuning'],
  ['6', 'rubrics.policy.nonResponse.status', 'unanswered', 'teacher-confirmed'],
  ['7', 'rubrics.policy.typos.unambiguousStrategy', 'warn-no-penalty', 'teacher-tuning'],
  ['8', 'rubrics.policy.equation.mediumMismatchOutcome', 'partial', 'teacher-tuning'],
  ['9', 'rubrics.policy.equation.acceptEqualsSign', true, 'teacher-confirmed'],
  ['10', 'rubrics.policy.weighting.dimensionMode', 'equal', 'teacher-tuning'],
  ['11', 'rubrics.policy.weakness.threshold', 0.6, 'teacher-tuning'],
  ['12', 'rubrics.policy.repeatedAnswers.strategy', 'latest', 'teacher-confirmed'],
  ['13', 'scaffoldPolicy.promotion.consecutiveHits', 2, 'teacher-tuning'],
  ['14', 'scaffoldPolicy.passing.minimumRatio', 0.75, 'teacher-tuning'],
  ['15', 'scaffoldPolicy.assistance.correctOutcome', 'hit-with-help', 'teacher-tuning'],
  ['16', 'scaffoldPolicy.socratic.correctedOutcome', 'hit-with-help', 'teacher-tuning'],
  ['17', 'rubrics.policy.dimensionAssignments.spontaneousRedox', 'principle', 'teacher-tuning'],
  ['18', 'rubrics.policy.dimensionAssignments.saltBridge', 'D3', 'teacher-confirmed'],
  ['18b', 'rubrics.policy.dimensionAssignments.siteReactantDistinction', 'D5-cross-axis', 'teacher-confirmed'],
  ['18c', 'rubrics.policy.weighting.nodeOverrides.P5', 1, 'teacher-tuning'],
  ['19', 'pretest.builder.assessment.generalModel.saltBridgeRequired', false, 'teacher-tuning'],
  ['19b', 'pretest.builder.assessment.abstraction.concreteBindingOutcome', 'partial', 'teacher-tuning'],
  ['20', 'rubrics.policy.presentation.studentRadar', 'score-and-level', 'teacher-tuning'],
] as const;

function readConfigField(root: unknown, field: string): unknown {
  return field.split('.').reduce<unknown>((value, segment) => {
    if (typeof value !== 'object' || value === null || !(segment in value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

describe('M1a external teaching configuration', () => {
  it('transcribes all 15 authoritative rubric nodes and one rubric per node', async () => {
    const config = await loadAllConfig(process.cwd());

    expect(config.knowledgeModel.nodes.map((node) => node.id)).toEqual(expectedNodeIds);
    expect(config.rubrics.rubrics).toHaveLength(15);
    expect(new Set(config.rubrics.rubrics.map((rubric) => rubric.nodeId))).toEqual(
      new Set(expectedNodeIds),
    );
    expect(config.knowledgeModel.edges).toContainEqual(
      expect.objectContaining({ from: 'D5', to: 'P2', kind: 'cross-axis' }),
    );
  });

  it.each(expectedAdjudications)(
    'covers adjudication §%s with the frozen default and review status',
    async (id, configField, expectedDefault, status) => {
      const config = await loadAllConfig(process.cwd());
      const rubrics = config.rubrics as typeof config.rubrics & {
        adjudications: Array<{ id: string; configField: string; status: string; reviewDueAt: string | null }>;
      };
      const decision = rubrics.adjudications.find((entry) => entry.id === id);

      expect(decision).toMatchObject({ id, configField, status });
      expect(readConfigField(config, configField)).toEqual(expectedDefault);
      expect(status === 'teacher-confirmed' ? decision?.reviewDueAt : decision?.reviewDueAt).toBe(
        status === 'teacher-confirmed' ? null : '2026-07-17T23:59:59+08:00',
      );
    },
  );

  it('contains exactly the 23 adjudication entries with no untracked policy', async () => {
    const config = await loadAllConfig(process.cwd());
    const adjudications = (config.rubrics as typeof config.rubrics & {
      adjudications: Array<{ id: string }>;
    }).adjudications;

    expect(adjudications.map((entry) => entry.id)).toEqual(
      expectedAdjudications.map(([id]) => id),
    );
  });

  it('defines three cases, three scaffold levels, and three non-builder pretest questions', async () => {
    const config = await loadAllConfig(process.cwd());

    expect(config.cases.map((trainingCase) => trainingCase.id)).toEqual([
      'aluminum-air',
      'hydrogen-oxygen',
      'zinc-copper',
    ]);
    expect(config.cases.every((trainingCase) => trainingCase.scaffold.length === 3)).toBe(true);
    expect(config.pretest.questions).toHaveLength(3);
    expect(config.pretest.questions.map((question: any) => question.dimensionId)).toEqual([
      'principle',
      'principle',
      'energy',
    ]);
  });

  it('maps every configured pretest distractor option to a declared misconception id', async () => {
    const config = await loadAllConfig(process.cwd());
    const misconceptionIds = new Set(
      config.knowledgeModel.nodes.flatMap((node: any) =>
        node.misconceptions.map((misconception: any) => misconception.id),
      ),
    );
    const mappedIds = (config.pretest.questions as any[]).flatMap((question) =>
      (question.options ?? []).flatMap((option: any) => option.misconceptionIds),
    );

    expect(mappedIds.length).toBeGreaterThan(0);
    expect(mappedIds.every((id: string) => misconceptionIds.has(id))).toBe(true);
  });
});
