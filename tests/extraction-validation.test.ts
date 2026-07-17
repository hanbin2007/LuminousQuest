import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  ExtractionValidationError,
  quoteExpressesFactValue,
  validateAssessmentExtraction,
} from '../shared/workflows/extraction-validation';

async function fixture() {
  return loadAllConfig(process.cwd());
}

function extraction(
  quote: string,
  start = 0,
  end = quote.length,
) {
  return {
    anchors: [] as Array<{
      anchorId: string;
      facts: Array<{
        id: string;
        value: string;
        evidence: { quote: string; start: number; end: number };
      }>;
      evidence: Array<{ quote: string; start: number; end: number }>;
    }>,
    assessments: [{
      nodeId: 'P4',
      errorIds: ['P4-M1'],
      facts: {
        response: 'substantive',
        terminology: 'model',
        syllabus: 'within',
        contradiction: false,
        typo: 'none',
        classificationEvidence: {},
        slots: [] as Array<{
          id: string;
          value: string;
          evidence: { quote: string; start: number; end: number };
        }>,
      },
      evidence: [{ quote, start, end }],
      assistance: { kind: 'none', rounds: 0 },
    }],
  };
}

function groundedExtraction(input: {
  answer: string;
  from: { value: string; quote: string; start: number; end: number };
  to: { value: string; quote: string; start: number; end: number };
}) {
  const value = extraction(input.answer, 0, input.answer.length);
  value.assessments[0].facts.slots = [
    {
      id: 'electron-from',
      value: input.from.value,
      evidence: {
        quote: input.from.quote,
        start: input.from.start,
        end: input.from.end,
      },
    },
    {
      id: 'electron-to',
      value: input.to.value,
      evidence: {
        quote: input.to.quote,
        start: input.to.start,
        end: input.to.end,
      },
    },
  ];
  return value;
}

function booleanFactExtraction(input: {
  answer: string;
  nodeId: string;
  slotId: string;
  slotValue: 'true' | 'false';
  quote: string;
}) {
  const value = extraction(input.answer, 0, input.answer.length);
  const start = input.answer.indexOf(input.quote);
  if (start < 0) throw new Error(`Quote ${input.quote} is not present in the test answer`);
  value.assessments[0].nodeId = input.nodeId;
  value.assessments[0].errorIds = [];
  value.assessments[0].facts.slots = [{
    id: input.slotId,
    value: input.slotValue,
    evidence: { quote: input.quote, start, end: start + input.quote.length },
  }];
  return value;
}

describe('closed-set extraction validation', () => {
  it('uses the canonical fact value when no extra aliases are configured', () => {
    expect(quoteExpressesFactValue({
      quote: '电子由 Zn 极流出',
      value: 'Zn',
      aliases: {},
      commonTypos: {},
    })).toBe(true);
  });

  it('repairs citations after full-width, whitespace, and configured typo normalization', async () => {
    const config = await fixture();
    const answer = '  电子由负级流向正极，Ｚｎ被氧化。';
    const result = validateAssessmentExtraction({
      extraction: extraction('电子由负极流向正极, Zn被氧化', 99, 120),
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    });

    expect(result.assessments[0].evidence[0]).toEqual({
      quote: '电子由负级流向正极，Ｚｎ被氧化',
      start: 2,
      end: answer.length - 1,
    });
  });

  it('rejects node and error ids outside the configured per-node closed set', async () => {
    const config = await fixture();
    const invalid = extraction('电子由负极流向正极');
    invalid.assessments[0].nodeId = 'NOT-A-NODE';
    invalid.assessments[0].errorIds = ['P2-M1'];

    expect(() => validateAssessmentExtraction({
      extraction: invalid,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(ExtractionValidationError);

    try {
      validateAssessmentExtraction({
        extraction: invalid,
        answer: '电子由负极流向正极',
        caseId: 'zinc-copper',
        targetNodeIds: ['P4'],
        config,
      });
    } catch (error) {
      expect(error).toMatchObject({ category: 'closed-set', retryable: true });
    }
  });

  it('rejects an error id that belongs to a different configured node', async () => {
    const config = await fixture();
    const invalid = extraction('电子由负极流向正极');
    invalid.assessments[0].errorIds = ['P2-M1'];

    expect(() => validateAssessmentExtraction({
      extraction: invalid,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set', retryable: true }));
  });

  it('rejects unknown cases, target sets, and anchor ids as closed-set failures', async () => {
    const config = await fixture();
    const value = extraction('电子由负极流向正极');
    expect(() => validateAssessmentExtraction({
      extraction: value,
      answer: '电子由负极流向正极',
      caseId: 'missing-case',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set' }));
    expect(() => validateAssessmentExtraction({
      extraction: value,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P2'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set' }));

    const unknownAnchor = structuredClone(value);
    unknownAnchor.anchors = [{
      anchorId: 'missing-anchor',
      facts: [{
        id: 'negative',
        value: 'Zn',
        evidence: { quote: '负极', start: 3, end: 5 },
      }],
      evidence: [{ quote: '负极', start: 3, end: 5 }],
    }];
    expect(() => validateAssessmentExtraction({
      extraction: unknownAnchor,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set' }));
  });

  it('requires assessment evidence when substantive fact slots are declared', async () => {
    const config = await fixture();
    const answer = '电子由Zn极流向Cu极。';
    const missingEvidence = groundedExtraction({
      answer,
      from: { value: 'Zn', quote: 'Zn', start: 3, end: 5 },
      to: { value: 'Cu', quote: 'Cu', start: 8, end: 10 },
    });
    missingEvidence.assessments[0].errorIds = [];
    missingEvidence.assessments[0].evidence = [];
    expect(() => validateAssessmentExtraction({
      extraction: missingEvidence,
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'citation-mismatch' }));

    const blank = extraction('placeholder');
    blank.assessments[0].errorIds = [];
    blank.assessments[0].facts.response = 'blank';
    blank.assessments[0].facts.slots = [];
    blank.assessments[0].evidence = [];
    expect(validateAssessmentExtraction({
      extraction: blank,
      answer: '',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    }).assessments[0].evidence).toEqual([]);
  });

  it('requires evidence for declared error ids even when fact slots are empty', async () => {
    const config = await fixture();
    const answer = '电子由负极流向正极';
    const missingEvidence = extraction(answer);
    missingEvidence.assessments[0].facts.slots = [];
    missingEvidence.assessments[0].errorIds = ['P4-M1'];
    missingEvidence.assessments[0].evidence = [];

    expect(() => validateAssessmentExtraction({
      extraction: missingEvidence,
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'citation-mismatch',
      retryable: true,
    }));
  });

  it('overrides the provider response label with deterministic server classification', async () => {
    const config = await fixture();
    const substantive = extraction('电子由负极流向正极');
    substantive.assessments[0].facts.response = 'blank';
    expect(validateAssessmentExtraction({
      extraction: substantive,
      answer: '电子由负极流向正极',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    }).assessments[0].facts.response).toBe('substantive');

    for (const [answer, expected] of [['  。！？ ', 'blank'], ['不知道！', 'non-answer']] as const) {
      const nonResponse = extraction('placeholder');
      nonResponse.assessments[0].facts.response = 'substantive';
      nonResponse.assessments[0].facts.slots = [];
      nonResponse.assessments[0].evidence = [];
      expect(validateAssessmentExtraction({
        extraction: nonResponse,
        answer,
        caseId: 'zinc-copper',
        targetNodeIds: ['P4'],
        config,
      }).assessments[0].facts.response).toBe(expected);
    }
  });

  it('grounds each adverse classification quote and emits server-owned verified flags', async () => {
    const config = await fixture();
    const answer = '电子从锌跑到铜，写成负级；还提到电极电势，前后说法矛盾。';
    const value = extraction(answer);
    const bound = (quote: string) => {
      const start = answer.indexOf(quote);
      return { quote, start, end: start + quote.length };
    };
    value.assessments[0].facts.terminology = 'colloquial';
    value.assessments[0].facts.syllabus = 'beyond';
    value.assessments[0].facts.contradiction = true;
    value.assessments[0].facts.typo = 'unambiguous';
    value.assessments[0].facts.classificationEvidence = {
      terminology: bound('电子从锌跑到铜'),
      syllabus: bound('电极电势'),
      contradiction: bound('前后说法矛盾'),
      typo: bound('负级'),
    };

    const result = validateAssessmentExtraction({
      extraction: value,
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    });

    expect(result.assessments[0].facts.verified).toEqual({
      colloquial: true,
      beyondSyllabus: true,
      contradiction: true,
      typo: 'unambiguous',
    });
    expect(result.assessments[0].facts.classificationEvidence.typo)
      .toEqual(bound('负级'));
  });

  it('classifies a near citation above the configured threshold as normalization-insufficient', async () => {
    const config = await fixture();
    config.scaffoldPolicy.extraction.citation.maxEditDistanceRatio = 0.05;
    const answer = '电子从负机流向正极';

    expect(() => validateAssessmentExtraction({
      extraction: extraction('电子从负极流向正极'),
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'normalization-insufficient',
      retryable: false,
    }));
  });

  it.each([
    ['below', 'abXdefghijYlmnopqrstuvwxy'],
    ['at', 'abXdefghijYlmnopqrsZuvwxy'],
    ['above', 'abXdefghijYlmnopqrsZuvWxy'],
  ])('never auto-accepts an unlisted edit %s the real 0.12 threshold', async (_position, answer) => {
    const config = await fixture();
    expect(config.scaffoldPolicy.extraction.citation.maxEditDistanceRatio).toBe(0.12);

    expect(() => validateAssessmentExtraction({
      extraction: extraction('abcdefghijklmnopqrstuvwxy'),
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'normalization-insufficient',
      retryable: false,
    }));
  });

  it.each([
    ['否定词', '电极不消耗', '电极消耗'],
    ['正负极', '电子由负极流向正极', '电子由正极流向负极'],
    ['氧化还原', 'Zn发生氧化反应', 'Zn发生还原反应'],
    ['流入流出', '电子流出Zn极', '电子流入Zn极'],
    ['化学式', 'Cu^2+得到电子', 'Cu+得到电子'],
  ])('routes a changed semantic token (%s) to review', async (_kind, answer, modelQuote) => {
    const config = await fixture();

    expect(() => validateAssessmentExtraction({
      extraction: extraction(modelQuote),
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'normalization-insufficient',
      retryable: false,
    }));
  });

  it('grounds every fact slot in its own quote using canonical and colloquial aliases', async () => {
    const config = await fixture();
    const answer = '电子从锌片流向铜电极。';
    const result = validateAssessmentExtraction({
      extraction: groundedExtraction({
        answer,
        from: { value: 'Zn', quote: '锌片', start: 3, end: 5 },
        to: { value: 'Cu', quote: '铜电极', start: 7, end: 10 },
      }),
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    });

    expect(result.assessments[0].facts.slots).toEqual([
      expect.objectContaining({ id: 'electron-from', value: 'Zn', evidence: { quote: '锌片', start: 3, end: 5 } }),
      expect.objectContaining({ id: 'electron-to', value: 'Cu', evidence: { quote: '铜电极', start: 7, end: 10 } }),
    ]);
  });

  it('grounds methane D1, P4, P5, and polarity facts in real Chinese quotations', async () => {
    const config = await fixture();
    const answer = [
      '甲烷侧的铂电极只提供失电子反应场所且自身不消耗。',
      '电子从甲烷侧的铂电极沿外电路流向氧气侧的铂电极，H+经质子交换膜移向氧气侧。',
      'CH4和O2被消耗，生成CO2和H2O。',
    ].join('');
    const evidence = (quote: string) => {
      const start = answer.indexOf(quote);
      if (start < 0) throw new Error(`missing quote ${quote}`);
      return { quote, start, end: start + quote.length };
    };
    const facts = (
      slots: Array<{ id: string; value: string; quote: string }>,
    ) => ({
      response: 'substantive',
      terminology: 'model',
      syllabus: 'within',
      contradiction: false,
      typo: 'none',
      slots: slots.map(({ quote, ...slot }) => ({ ...slot, evidence: evidence(quote) })),
    });
    const result = validateAssessmentExtraction({
      extraction: {
        anchors: [{
          anchorId: 'case-polarity',
          facts: [
            { id: 'negative', value: 'methane-side', evidence: evidence('甲烷侧') },
            { id: 'positive', value: 'oxygen-side', evidence: evidence('氧气侧') },
          ],
          evidence: [evidence('甲烷侧的铂电极'), evidence('氧气侧的铂电极')],
        }],
        assessments: [
          {
            nodeId: 'D1',
            errorIds: [],
            facts: facts([
              { id: 'oxidation-site', value: 'methane-Pt', quote: '甲烷侧的铂电极' },
              { id: 'site-consumed', value: 'false', quote: '自身不消耗' },
            ]),
            evidence: [evidence('甲烷侧的铂电极只提供失电子反应场所且自身不消耗')],
            assistance: { kind: 'none', rounds: 0 },
          },
          {
            nodeId: 'P4',
            errorIds: [],
            facts: facts([
              { id: 'electron-from', value: 'methane-Pt', quote: '甲烷侧的铂电极' },
              { id: 'electron-to', value: 'oxygen-Pt', quote: '氧气侧的铂电极' },
              { id: 'permitted-ion', value: 'H+', quote: 'H+' },
              { id: 'ion-toward', value: 'oxygen-Pt', quote: '氧气侧' },
            ]),
            evidence: [evidence('电子从甲烷侧的铂电极沿外电路流向氧气侧的铂电极，H+经质子交换膜移向氧气侧')],
            assistance: { kind: 'none', rounds: 0 },
          },
          {
            nodeId: 'P5',
            errorIds: [],
            facts: facts([
              { id: 'consumed', value: 'CH4+O2', quote: 'CH4和O2' },
              { id: 'generated', value: 'CO2+H2O', quote: 'CO2和H2O' },
            ]),
            evidence: [evidence('CH4和O2被消耗，生成CO2和H2O')],
            assistance: { kind: 'none', rounds: 0 },
          },
        ],
      },
      answer,
      caseId: 'methane-fuel',
      targetNodeIds: ['D1', 'P4', 'P5'],
      config,
    });

    expect(result.anchors[0].facts.map((fact) => fact.value)).toEqual(['methane-side', 'oxygen-side']);
    expect(result.assessments.map((assessment) => assessment.nodeId)).toEqual(['D1', 'P4', 'P5']);
  });

  it.each([
    ['spontaneous', 'zinc-copper', 'P1', 'spontaneous', '反应不能自发进行', '自发'],
    ['half-reactions-separated', 'zinc-copper', 'P1', 'half-reactions-separated', '两个半反应不分处两极', '分处'],
    ['complete-conversion', 'zinc-copper', 'E3', 'complete-conversion', '能量转化未发生', '发生'],
    ['site-consumed', 'hydrogen-oxygen', 'D1', 'site-consumed', 'Pt不会消耗', '会'],
  ])('routes a negated %s=true declaration to fact-grounding review', async (
    _kind,
    caseId,
    nodeId,
    slotId,
    answer,
    quote,
  ) => {
    const config = await fixture();

    expect(() => validateAssessmentExtraction({
      extraction: booleanFactExtraction({ answer, nodeId, slotId, slotValue: 'true', quote }),
      answer,
      caseId,
      targetNodeIds: [nodeId],
      config,
    })).toThrow(expect.objectContaining({
      category: 'fact-grounding',
      retryable: false,
      detail: expect.objectContaining({ slotId, slotValue: 'true' }),
    }));
  });

  it.each([
    ['spontaneous', 'zinc-copper', 'P1', 'spontaneous', '反应可以自发进行', '自发'],
    ['half-reactions-separated', 'zinc-copper', 'P1', 'half-reactions-separated', '两个半反应分处两极', '分处'],
    ['complete-conversion', 'zinc-copper', 'E3', 'complete-conversion', '能量会完全转化', '会'],
    ['site-consumed', 'hydrogen-oxygen', 'D1', 'site-consumed', 'Pt会消耗', '会'],
  ])('accepts an affirmative %s=true declaration', async (
    _kind,
    caseId,
    nodeId,
    slotId,
    answer,
    quote,
  ) => {
    const config = await fixture();

    expect(validateAssessmentExtraction({
      extraction: booleanFactExtraction({ answer, nodeId, slotId, slotValue: 'true', quote }),
      answer,
      caseId,
      targetNodeIds: [nodeId],
      config,
    }).assessments[0].facts.slots[0]).toMatchObject({ id: slotId, value: 'true' });
  });

  it.each([
    ['spontaneous', 'zinc-copper', 'P1', 'spontaneous', '反应不能自发进行', '不能自发'],
    ['half-reactions-separated', 'zinc-copper', 'P1', 'half-reactions-separated', '两个半反应不分处两极', '不分处'],
    ['complete-conversion', 'zinc-copper', 'E3', 'complete-conversion', '能量转化未发生', '未发生'],
    ['site-consumed', 'hydrogen-oxygen', 'D1', 'site-consumed', 'Pt不会消耗', '不会消耗'],
  ])('accepts a negated %s=false declaration', async (
    _kind,
    caseId,
    nodeId,
    slotId,
    answer,
    quote,
  ) => {
    const config = await fixture();

    expect(validateAssessmentExtraction({
      extraction: booleanFactExtraction({ answer, nodeId, slotId, slotValue: 'false', quote }),
      answer,
      caseId,
      targetNodeIds: [nodeId],
      config,
    }).assessments[0].facts.slots[0]).toMatchObject({ id: slotId, value: 'false' });
  });

  it('rejects a correct slot value whose bound quote does not express that value', async () => {
    const config = await fixture();
    const answer = '盐桥维持电中性；电子从锌片流向铜片。';
    const invalid = groundedExtraction({
      answer,
      from: { value: 'Zn', quote: '盐桥', start: 0, end: 2 },
      to: { value: 'Cu', quote: '盐桥', start: 0, end: 2 },
    });

    expect(() => validateAssessmentExtraction({
      extraction: invalid,
      answer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'fact-grounding',
      retryable: false,
      detail: expect.objectContaining({ slotId: 'electron-from', slotValue: 'Zn' }),
    }));
  });

  it.each([
    ['duplicate', [
      { id: 'electron-from', value: 'Zn', evidence: { quote: 'Zn', start: 3, end: 5 } },
      { id: 'electron-from', value: 'Zn', evidence: { quote: 'Zn', start: 3, end: 5 } },
    ]],
    ['unknown', [
      { id: 'invented-slot', value: 'Zn', evidence: { quote: 'Zn', start: 3, end: 5 } },
    ]],
  ])('rejects %s fact slots outside the node-specific closed schema', async (_kind, slots) => {
    const config = await fixture();
    const invalid = extraction('电子由Zn极流向Cu极。');
    invalid.assessments[0].facts.slots = slots;

    expect(() => validateAssessmentExtraction({
      extraction: invalid,
      answer: '电子由Zn极流向Cu极。',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({ category: 'closed-set' }));
  });

  it('rejects answers over the configured limit before fuzzy citation work', async () => {
    const config = await fixture();
    const maximum = config.scaffoldPolicy.extraction.maximumAnswerCharacters;

    expect(() => validateAssessmentExtraction({
      extraction: extraction('a'),
      answer: 'a'.repeat(maximum + 1),
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'answer-too-long',
      retryable: false,
    }));
  });

  it('classifies an unrelated citation as a retryable model hallucination', async () => {
    const config = await fixture();

    expect(() => validateAssessmentExtraction({
      extraction: extraction('电子从负极流向正极'),
      answer: '我不会',
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      config,
    })).toThrow(expect.objectContaining({
      category: 'citation-mismatch',
      retryable: true,
    }));
  });
});
