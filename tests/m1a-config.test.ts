import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  canonicalizeEquation,
  combineHalfReactionsCanonical,
} from '../shared/chemistry/equation';

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
      const actualDefault = readConfigField(config, configField);
      expect(actualDefault).toEqual(expectedDefault);
      expect(decision?.reviewDueAt).toBe(
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

  it('orders the three training cases from configuration and exposes the signed-off materials', async () => {
    const config = await loadAllConfig(process.cwd());

    expect(config.cases.slice(0, 3).map((trainingCase) => trainingCase.id)).toEqual([
      'zinc-copper',
      'aluminum-air',
      'hydrogen-oxygen',
    ]);
    expect(config.cases.slice(0, 3).map((trainingCase) => trainingCase.sequence)).toEqual([1, 2, 3]);
    expect(config.cases.slice(0, 3).every((trainingCase) => trainingCase.caseType === 'training')).toBe(true);
    const transferCases = config.cases.slice(3);
    expect(transferCases.length).toBeLessThanOrEqual(1);
    if (transferCases[0]) {
      expect(transferCases[0]).toMatchObject({
        id: 'methane-fuel',
        sequence: 4,
        caseType: 'transfer',
        medium: 'acidic',
        tutoring: [],
      });
    }
    expect(config.cases.every((trainingCase) => trainingCase.scaffold.length === 3)).toBe(true);
    expect(config.cases.flatMap((trainingCase) => trainingCase.materials)
      .every((material) => material.status === 'ready' && material.materialRef !== null)).toBe(true);
    expect(config.cases.flatMap((trainingCase) => trainingCase.materials)
      .every((material) => Array.isArray(material.revealAfterNodeIds))).toBe(true);
    for (const trainingCase of config.cases) {
      for (const material of trainingCase.materials) {
        expect(material.revealAfterNodeIds.every((nodeId) => trainingCase.targetNodeIds.includes(nodeId)))
          .toBe(true);
        expect(material.kind === 'cross-section' ? material.revealAfterNodeIds : [])
          .toEqual(material.kind === 'cross-section' ? ['P2', 'P3'] : []);
      }
    }
    expect(config.cases.find((trainingCase) => trainingCase.id === 'zinc-copper')?.materials)
      .toHaveLength(1);
    expect(config.pretest.questions).toHaveLength(13);
    expect(config.pretest.questions.map((question: any) => question.dimensionId)).toEqual([
      'principle',
      'principle',
      'energy',
      'device',
      'principle',
      'principle',
      'device',
      'device',
      'principle',
      'device',
      'device',
      'device',
      'principle',
    ]);
  });

  it('configures level one as the D5 four-question probe plus the P2 to P5 ladder', async () => {
    const config = await loadAllConfig(process.cwd());

    for (const trainingCase of config.cases) {
      const levelOne = trainingCase.scaffold.find((entry) => entry.level === 1);
      if (!levelOne || levelOne.level !== 1) throw new Error('missing level-one scaffold');
      expect(levelOne.fields.filter((field) => field.nodeId === 'D5')).toHaveLength(4);
      expect(levelOne.fields
        .filter((field) => ['P2', 'P3', 'P4', 'P5'].includes(field.nodeId))
        .map((field) => field.nodeId)).toEqual(['P2', 'P3', 'P4', 'P5']);
    }
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

  it('transcribes the D4/E3 rulings and removes the contradictory same-material distractor', async () => {
    const config = await loadAllConfig(process.cwd());

    expect(config.knowledgeModel.version).toBe('knowledge-model.v1.2');
    expect(config.rubrics.version).toBe('rubrics.v1.2');
    expect(config.pretest.version).toBe('pretest.v1.4');
    expect(config.scaffoldPolicy.version).toBe('scaffold-policy.v1.5');
    expect(config.scaffoldPolicy.extraction.temperature).toBe(0.1);
    expect(config.cases.every((entry) => entry.version === 'case.v1.5')).toBe(true);
    expect(config.knowledgeModel.nodes.find((node) => node.id === 'D4')?.statement)
      .toContain('惰性电极');
    expect(config.knowledgeModel.nodes.find((node) => node.id === 'D4')?.statement)
      .toContain('普通导体');
    expect(config.knowledgeModel.nodes.find((node) => node.id === 'E3')?.statement)
      .toContain('火力发电');
    expect(config.pretest.builder.components.some((entry) => entry.id === 'same-material-pair'))
      .toBe(false);
  });

  it('uses the adjudicated pretest option-to-node and misconception mappings', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) => entry.id === 'pretest-principle-reactants');
    if (!question || question.type !== 'choice') throw new Error('missing choice pretest');

    expect(question.targetNodeIds).toEqual(['P2', 'D5']);
    expect(question.rubricIds).toEqual(['rubric-p2', 'rubric-d5']);
    expect(question.options.find((entry) => entry.id === 'C')?.misconceptionIds).toContain('D3-M4');
    expect(question.options.find((entry) => entry.id === 'D')?.misconceptionIds)
      .toEqual(expect.arrayContaining(['P4-M1', 'P4-M2']));
  });

  it('transcribes the four K-O2 exam questions and their shared group exactly', async () => {
    const config = await loadAllConfig(process.cwd());
    const exam = config.pretest.questions.filter((question) =>
      question.group?.id === 'exam-q1-k-o2');

    expect(exam).toHaveLength(4);
    for (const question of exam) {
      expect(question.group).toEqual({
        id: 'exam-q1-k-o2',
        title: '高考真题',
        stimulus: '【高考真题】K—O₂ 电池结构如图，a 和 b 为两个电极，其中之一为单质钾片。',
        figure: 'assets/exam/q1-k-o2.png',
      });
    }

    expect(exam[0]).toMatchObject({
      id: 'pretest-exam1-polarity',
      type: 'choice',
      prompt: '该电池中，电极 a、b 分别为什么极？',
      dimensionId: 'device',
      targetNodeIds: ['D1', 'D4'],
      rubricIds: ['rubric-d1', 'rubric-d4'],
      options: [
        { id: 'A', text: 'a 为负极，b 为正极——钾片失电子被氧化，O₂ 得电子被还原。', correct: true, misconceptionIds: [] },
        { id: 'B', text: 'a 为正极，b 为负极。', correct: false, misconceptionIds: ['D1-M1', 'D4-M2'] },
        { id: 'C', text: 'a、b 都可以是负极，取决于外电路接法。', correct: false, misconceptionIds: ['D1-M1'] },
        { id: 'D', text: '无法判断，因为不知道电极材料是否参与反应。', correct: false, misconceptionIds: ['D5-M2'] },
      ],
    });
    expect(exam[1]).toMatchObject({
      id: 'pretest-exam1-electron-flow',
      type: 'choice',
      prompt: '放电时，外电路中电子的流向是？',
      dimensionId: 'principle',
      targetNodeIds: ['P4', 'D4'],
      rubricIds: ['rubric-p4', 'rubric-d4'],
      options: [
        { id: 'A', text: '从 a 极经外电路流向 b 极。', correct: true, misconceptionIds: [] },
        { id: 'B', text: '从 b 极经外电路流向 a 极。', correct: false, misconceptionIds: ['P4-M1'] },
        { id: 'C', text: '从 a 极经隔膜（电解质）流向 b 极。', correct: false, misconceptionIds: ['P4-M2', 'D3-M1'] },
        { id: 'D', text: '外电路和隔膜中都有电子流动。', correct: false, misconceptionIds: ['P4-M2'] },
      ],
    });
    expect(exam[2]).toMatchObject({
      id: 'pretest-exam1-stoichiometry',
      type: 'choice',
      prompt: '该电池放电时（生成 KO₂），消耗 K 与消耗 O₂ 的物质的量之比为？',
      dimensionId: 'principle',
      targetNodeIds: ['P6'],
      rubricIds: ['rubric-p6'],
      options: [
        { id: 'A', text: '1:1——K − e⁻ = K⁺ 与 O₂ + e⁻ = O₂⁻ 各转移 1 个电子。', correct: true, misconceptionIds: [] },
        { id: 'B', text: '2:1。', correct: false, misconceptionIds: ['P6-M2'] },
        { id: 'C', text: '4:1。', correct: false, misconceptionIds: ['P6-M2'] },
        { id: 'D', text: '1:2。', correct: false, misconceptionIds: ['P6-M1'] },
      ],
    });
    expect(exam[3]).toMatchObject({
      id: 'pretest-exam1-membrane',
      type: 'text',
      prompt: '该装置中的隔膜能否通过 O₂？请说明理由。',
      dimensionId: 'device',
      targetNodeIds: ['D3', 'P1'],
      rubricIds: ['rubric-d3', 'rubric-p1'],
      evidencePath: '简答原文 -> 隔膜选择性、半反应分隔理由',
      answerGuidance: [
        '不能。防止 K 与 O₂ 直接反应（两个半反应必须分隔在两个场所）。',
        '另类正确：「不能。若 O₂ 通过隔膜到 a 极，会直接与 K 反应（或在 a 极得电子生成 O²⁻/K₂O 而非 KO₂），电池无法正常工作。」——判 hit。',
        '只答「不能」无理由 → partial；答「能」→ miss。',
      ],
      evidence: [
        {
          nodeId: 'D3',
          description: '判断隔膜不允许 O₂ 通过（离子导体的选择性）。',
          referenceAnswerPoints: ['不能（隔膜不允许 O₂ 通过）。'],
          factRequirements: [{ id: 'o2-passes', acceptedValues: ['false'] }],
        },
        {
          nodeId: 'P1',
          description: '说明理由：防止 K 与 O₂ 直接反应，两个半反应必须分隔。',
          referenceAnswerPoints: ['防止 K 与 O₂ 直接反应（半反应分隔）。'],
          factRequirements: [{ id: 'separation-purpose', acceptedValues: ['prevent-direct-reaction'] }],
        },
      ],
    });
    expect(config.scaffoldPolicy.extraction.factValueAliases.false)
      .toEqual(expect.arrayContaining(['否', '不能']));
    expect(config.scaffoldPolicy.extraction.factValueAliases['prevent-direct-reaction'])
      .toEqual(['直接反应', '直接接触', '不接触', '发生反应', '防止', '直接与', 'K反应']);
  });

  it('transcribes the six glucose-cell exam questions and their shared group exactly', async () => {
    const config = await loadAllConfig(process.cwd());
    const exam = config.pretest.questions.filter((question) =>
      question.group?.id === 'exam-q4-glucose');
    const group = {
      id: 'exam-q4-glucose',
      title: '高考真题',
      stimulus: '【高考真题】一种可植入体内的微型电池工作原理如图所示，通过 CuO 催化消耗血糖发电，从而控制血糖浓度。当传感器检测到血糖浓度高于标准，电池启动；血糖浓度下降至标准，电池停止工作。（血糖浓度以葡萄糖浓度计）',
      figure: 'assets/exam/q4-glucose-implant.png',
    };

    expect(exam).toHaveLength(6);
    expect(exam.every((question) =>
      JSON.stringify(question.group) === JSON.stringify(group))).toBe(true);
    expect(exam[0]).toMatchObject({
      id: 'pretest-exam4-polarity',
      type: 'choice',
      prompt: '该电池中，电极 a、b 分别为什么极？',
      dimensionId: 'device',
      targetNodeIds: ['D1', 'D4'],
      rubricIds: ['rubric-d1', 'rubric-d4'],
      options: [
        { id: 'A', text: '正｜负', correct: true, misconceptionIds: [] },
        { id: 'B', text: '负｜正', correct: false, misconceptionIds: ['D1-M1', 'D4-M2'] },
        { id: 'C', text: '正｜正', correct: false, misconceptionIds: ['D1-M1'] },
        { id: 'D', text: '其他作答', correct: false, misconceptionIds: [] },
      ],
    });
    expect(exam[1]).toMatchObject({
      id: 'pretest-exam4-cathode-equation',
      type: 'text',
      prompt: '写出该电池正极的电极反应式。',
      dimensionId: 'principle',
      targetNodeIds: ['P6'],
      rubricIds: ['rubric-p6'],
      answerGuidance: ['O₂ + 2H₂O + 4e⁻ = 4OH⁻（血液近中性，按碱性式书写，产物为 OH⁻）。'],
      referenceEquations: [{
        caseId: 'aluminum-air',
        equationSetId: 'oxygen-positive',
        equation: 'O₂ + 2H₂O + 4e⁻ = 4OH⁻',
      }],
    });
    expect(exam[2]).toMatchObject({
      id: 'pretest-exam4-material',
      type: 'choice',
      prompt: 'b 电极的电极材料是什么？',
      dimensionId: 'device',
      targetNodeIds: ['D5', 'D1'],
      rubricIds: ['rubric-d5', 'rubric-d1'],
      options: [
        { id: 'A', text: '纳米 CuO/导电聚合物（CuO）', correct: true, misconceptionIds: [] },
        { id: 'B', text: 'Cu₂O/氧化亚铜', correct: false, misconceptionIds: ['D5-M1'] },
        { id: 'C', text: '石墨', correct: false, misconceptionIds: ['D5-M2'] },
        { id: 'D', text: '葡萄糖/C₆H₁₂O₆', correct: false, misconceptionIds: ['D5-M1'] },
        { id: 'E', text: '其他作答', correct: false, misconceptionIds: [] },
      ],
    });
    expect(exam[3]).toMatchObject({
      id: 'pretest-exam4-electron-loser',
      type: 'choice',
      prompt: '在 b 电极上，实际失电子的物质是什么？',
      dimensionId: 'device',
      targetNodeIds: ['D5'],
      rubricIds: ['rubric-d5'],
      options: [
        { id: 'A', text: 'Cu₂O/氧化亚铜', correct: true, misconceptionIds: [] },
        { id: 'B', text: '葡萄糖/C₆H₁₂O₆', correct: false, misconceptionIds: ['D5-M2'] },
        { id: 'C', text: 'CuO/氧化铜', correct: false, misconceptionIds: ['D5-M1'] },
        { id: 'D', text: '葡萄糖酸/C₆H₁₂O₇', correct: false, misconceptionIds: ['D5-M2'] },
        { id: 'E', text: '其他作答', correct: false, misconceptionIds: [] },
      ],
    });
    expect(exam[4]).toMatchObject({
      id: 'pretest-exam4-process',
      type: 'text',
      prompt: '请简单描述 CuO 在 b 电极上参与反应的完整过程，并说明 CuO 在该过程中所起的作用。',
      dimensionId: 'device',
      targetNodeIds: ['D5', 'P2'],
      rubricIds: ['rubric-d5', 'rubric-p2'],
      evidence: [
        {
          nodeId: 'D5',
          description: 'CuO 的角色定性与再生循环。',
          referenceAnswerPoints: ['CuO 氧化葡萄糖后被还原为 Cu₂O，Cu₂O 在电极失电子再生成 CuO，CuO 起催化作用。'],
          factRequirements: [
            {
              id: 'cuo-role',
              acceptedValues: ['catalyst'],
              valueDomain: ['catalyst', 'intermediate', 'oxidant'],
            },
            {
              id: 'cuo-regenerated',
              acceptedValues: ['cuo-regenerated'],
              valueDomain: ['cuo-regenerated'],
            },
          ],
        },
        {
          nodeId: 'P2',
          description: '氧化关系：CuO 将葡萄糖氧化（葡萄糖为还原剂被氧化）。',
          referenceAnswerPoints: ['CuO 将葡萄糖氧化为葡萄糖酸。'],
          factRequirements: [{
            id: 'glucose-oxidized',
            acceptedValues: ['glucose-oxidized'],
            valueDomain: ['glucose-oxidized'],
          }],
        },
      ],
      answerGuidance: [
        'CuO 将葡萄糖氧化为葡萄糖酸，自身被还原为 Cu₂O；Cu₂O 在 b 电极失电子又生成 CuO；CuO 起催化作用。',
        '只定性催化未描述再生循环 → D5 partial；把 CuO 说成中间产物/仅氧化剂 → 照实转录后按规则层判。',
      ],
      referenceEquations: [{
        caseId: 'zinc-copper',
        equationSetId: 'zinc-negative',
        equation: 'Zn - 2e⁻ = Zn²⁺',
      }],
    });
    expect(exam[5]).toMatchObject({
      id: 'pretest-exam4-stoichiometry',
      type: 'choice',
      prompt: '消耗 18 mg 葡萄糖（C₆H₁₂O₆，M=180 g/mol）时，理论上 a 电极有多少 mmol 电子流入？',
      dimensionId: 'principle',
      targetNodeIds: ['P6'],
      rubricIds: ['rubric-p6'],
      options: [
        { id: 'A', text: '0.2', correct: true, misconceptionIds: [] },
        { id: 'B', text: '0.1', correct: false, misconceptionIds: ['P6-M2'] },
        { id: 'C', text: '0.02/2×10⁻²', correct: false, misconceptionIds: ['P6-M1'] },
        { id: 'D', text: '2/200', correct: false, misconceptionIds: ['P6-M1'] },
        { id: 'E', text: '其他作答', correct: false, misconceptionIds: [] },
      ],
    });
    expect(config.scaffoldPolicy.extraction.factValueAliases).toMatchObject({
      catalyst: ['催化剂', '催化作用', '催化'],
      intermediate: ['中间产物'],
      oxidant: ['氧化剂'],
      'cuo-regenerated': ['再生', '又生成', '变回', '重新生成', '回到'],
      'glucose-oxidized': ['氧化葡萄糖', '葡萄糖氧化', '将葡萄糖氧化', '葡萄糖被氧化'],
    });
  });

  it('states the complete alkaline aluminum-air OH- process and drops unsupported E3 targeting', async () => {
    const config = await loadAllConfig(process.cwd());
    const aluminum = config.cases.find((entry) => entry.id === 'aluminum-air')!;
    const answer = aluminum.scaffold.find((entry) => entry.level === 1)!.answerPoints.join(' ');

    expect(answer).toContain('OH^- 在正极生成');
    expect(answer).toContain('向负极迁移');
    expect(answer).toContain('在负极消耗');
    expect(answer).toContain('隔膜只允许离子通过');
    expect(aluminum.targetNodeIds).not.toContain('E3');
  });

  it('defines exactly negative, positive, and overall equation groups whose half reactions merge to the overall corpus', async () => {
    const config = await loadAllConfig(process.cwd());

    for (const trainingCase of config.cases) {
      expect(trainingCase.equationSets.map((entry) => entry.electrode).sort())
        .toEqual(['negative', 'overall', 'positive']);
      const negative = trainingCase.equationSets.find((entry) => entry.electrode === 'negative')!;
      const positive = trainingCase.equationSets.find((entry) => entry.electrode === 'positive')!;
      const overall = trainingCase.equationSets.find((entry) => entry.electrode === 'overall')!;
      const acceptedOverall = new Set(overall.accepted.map(canonicalizeEquation));
      for (const oxidation of negative.accepted) {
        for (const reduction of positive.accepted) {
          expect(acceptedOverall.has(combineHalfReactionsCanonical(
            oxidation,
            reduction,
            trainingCase.medium,
          ).canonical), `${trainingCase.id}: ${oxidation} + ${reduction}`).toBe(true);
        }
      }
    }
  });

  it('keeps case targets evidence-backed and answer evidence policy-evaluable', async () => {
    const config = await loadAllConfig(process.cwd());
    for (const trainingCase of config.cases) {
      const evidenceNodes = new Set(trainingCase.evidencePaths.map((entry) => entry.nodeId));
      expect(trainingCase.targetNodeIds.every((nodeId) => evidenceNodes.has(nodeId))).toBe(true);
      expect(trainingCase.evidencePaths
        .filter((entry) => entry.source === 'answer')
        .every((entry) => entry.factRequirements.length > 0)).toBe(true);
      if (trainingCase.caseType === 'transfer') {
        expect(trainingCase.tutoring).toEqual([]);
      } else {
        expect(trainingCase.tutoring.length).toBeGreaterThan(0);
      }
      expect(trainingCase.tutoring.every((entry) => {
        const evidence = trainingCase.evidencePaths.find((candidate) =>
          candidate.nodeId === entry.nodeId && candidate.source === 'answer');
        return evidence !== undefined
          && evidence.factRequirements.flatMap((requirement) => requirement.acceptedValues).length > 0;
      })).toBe(true);
    }
  });
});
