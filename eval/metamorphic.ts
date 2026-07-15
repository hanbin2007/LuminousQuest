import {
  labeledEvalCaseSchema,
  type LabeledEvalCase,
  type MetamorphicVariantName,
} from './schema';

export interface MetamorphicEvalVariant {
  variant: MetamorphicVariantName;
  case: LabeledEvalCase;
}

const paraphrases = [
  ['认为', '觉得'],
  ['不需要', '无需'],
  ['转化为', '变成'],
  ['流向', '流到'],
  ['来自', '源于'],
  ['并且', '而且'],
  ['所以', '因此'],
] as const;

function replaceFirstKnownParaphrase(value: string) {
  for (const [from, to] of paraphrases) {
    if (value.includes(from)) return value.replace(from, to);
  }
  return value.length === 0 ? ' ' : `换句话说，${value}`;
}

function replaceAllKnownParaphrases(value: string) {
  return paraphrases.reduce((current, [from, to]) => current.replaceAll(from, to), value);
}

function renamedPerson(value: string) {
  const renamed = value
    .replaceAll('小明', '李同学')
    .replaceAll('小红', '李同学')
    .replaceAll('张同学', '李同学')
    .replaceAll('王同学', '李同学');
  if (renamed !== value) return renamed;
  return value.trim().length === 0 ? '李同学没有作答。' : `李同学的原话是：${value}`;
}

function transformQuotes(
  evalCase: LabeledEvalCase,
  transform: (value: string) => string,
) {
  return {
    ...evalCase.expectedExtraction,
    slots: evalCase.expectedExtraction.slots.map((slot) => ({
      ...slot,
      evidenceQuote: transform(slot.evidenceQuote),
    })),
    evidenceQuotes: evalCase.expectedExtraction.evidenceQuotes.map(transform),
  };
}

export function generateMetamorphicVariants(
  evalCase: LabeledEvalCase,
): MetamorphicEvalVariant[] {
  const paraphrase = labeledEvalCaseSchema.parse({
    ...evalCase,
    studentAnswer: replaceFirstKnownParaphrase(evalCase.studentAnswer),
    expectedExtraction: transformQuotes(evalCase, replaceAllKnownParaphrases),
  });
  const noise = labeledEvalCaseSchema.parse({
    ...evalCase,
    studentAnswer: evalCase.studentAnswer.trim().length === 0
      ? '嗯，这和答案无关。'
      : `${evalCase.studentAnswer} 这和答案无关，我只是顺带提一句。`,
  });
  const rename = labeledEvalCaseSchema.parse({
    ...evalCase,
    studentAnswer: renamedPerson(evalCase.studentAnswer),
    expectedExtraction: transformQuotes(evalCase, (quote) => quote
      .replaceAll('小明', '李同学')
      .replaceAll('小红', '李同学')
      .replaceAll('张同学', '李同学')
      .replaceAll('王同学', '李同学')),
  });

  return [
    { variant: 'paraphrase', case: paraphrase },
    { variant: 'noise', case: noise },
    { variant: 'rename-person', case: rename },
  ];
}

