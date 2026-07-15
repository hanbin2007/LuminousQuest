import {
  labeledEvalCaseSchema,
  type LabeledEvalCase,
  type MetamorphicVariantName,
} from './schema';

export interface MetamorphicEvalVariant {
  variant: MetamorphicVariantName;
  case: LabeledEvalCase;
  semanticReview: { reviewer: string; rationale: string };
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

function replaceAllKnownParaphrases(value: string) {
  return paraphrases.reduce((current, [from, to]) => current.replaceAll(from, to), value);
}

function paraphrasedAnswer(value: string) {
  const transformed = replaceAllKnownParaphrases(value);
  if (transformed !== value) return transformed;
  return value.length === 0 ? ' ' : `换句话说，${value}`;
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
    anchors: evalCase.expectedExtraction.anchors.map((anchor) => ({
      ...anchor,
      facts: anchor.facts.map((fact) => ({
        ...fact,
        evidenceQuote: transform(fact.evidenceQuote),
      })),
      evidenceQuotes: anchor.evidenceQuotes.map(transform),
    })),
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
  const reviewed = (
    variant: MetamorphicVariantName,
    generated: LabeledEvalCase,
  ): MetamorphicEvalVariant | null => {
    const review = evalCase.metamorphicReview.variants[variant];
    if (review.status !== 'approved' || generated.studentAnswer === evalCase.studentAnswer) return null;
    return {
      variant,
      case: generated,
      semanticReview: {
        reviewer: evalCase.metamorphicReview.reviewer,
        rationale: review.rationale,
      },
    };
  };

  if (evalCase.evaluationPath === 'equation') {
    const rewritten = (value: string) => value.includes('->')
      ? value.replace('->', '=')
      : value.replace('=', '->');
    const paraphrase = labeledEvalCaseSchema.parse({
      ...evalCase,
      studentAnswer: rewritten(evalCase.studentAnswer),
      expectedExtraction: {
        ...transformQuotes(evalCase, rewritten),
        slots: evalCase.expectedExtraction.slots.map((slot) => ({
          ...slot,
          value: slot.id === 'equation' ? rewritten(slot.value) : slot.value,
          evidenceQuote: rewritten(slot.evidenceQuote),
        })),
      },
    });
    return [
      reviewed('paraphrase', paraphrase),
    ].filter((entry): entry is MetamorphicEvalVariant => entry !== null);
  }
  const paraphrase = labeledEvalCaseSchema.parse({
    ...evalCase,
    studentAnswer: paraphrasedAnswer(evalCase.studentAnswer),
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
    reviewed('paraphrase', paraphrase),
    reviewed('noise', noise),
    reviewed('rename-person', rename),
  ].filter((entry): entry is MetamorphicEvalVariant => entry !== null);
}
