import type {
  EvalConfig,
  EvalObservation,
  EvalOutcome,
  LabeledEvalCase,
} from './schema';

const outcomes: EvalOutcome[] = ['hit', 'partial', 'miss', 'unanswered', 'needs-review'];

export interface EvalGate {
  id: string;
  label: string;
  direction: 'minimum' | 'maximum';
  threshold: number;
  actual: number;
  passed: boolean;
}

function ratio(numerator: number, denominator: number, empty = 0) {
  return denominator === 0 ? empty : numerator / denominator;
}

function percentile(values: readonly number[], quantile: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
}

function modalScore(observations: readonly EvalObservation[]) {
  const counts = new Map<EvalOutcome, number>();
  observations.forEach((entry) => counts.set(entry.predictedScore, (counts.get(entry.predictedScore) ?? 0) + 1));
  return outcomes.reduce((best, outcome) =>
    (counts.get(outcome) ?? 0) > (counts.get(best) ?? 0) ? outcome : best, outcomes[0]);
}

function gate(
  id: string,
  label: string,
  direction: EvalGate['direction'],
  threshold: number,
  actual: number,
): EvalGate {
  return {
    id,
    label,
    direction,
    threshold,
    actual,
    passed: direction === 'minimum' ? actual >= threshold : actual <= threshold,
  };
}

export function computeEvalMetrics(input: {
  cases: readonly LabeledEvalCase[];
  observations: readonly EvalObservation[];
  config: EvalConfig;
}) {
  const base = input.observations.filter((entry) => entry.variant === 'base');
  const variants = input.observations.filter((entry) => entry.variant !== 'base');
  const casesById = new Map(input.cases.map((evalCase) => [evalCase.id, evalCase]));
  const confusionMatrix = Object.fromEntries(outcomes.map((expected) => [
    expected,
    Object.fromEntries(outcomes.map((predicted) => [predicted, 0])) as Record<EvalOutcome, number>,
  ])) as Record<EvalOutcome, Record<EvalOutcome, number>>;
  base.forEach((entry) => {
    confusionMatrix[entry.expectedScore][entry.predictedScore] += 1;
  });

  const perNode = new Map<string, { correct: number; total: number; accuracy: number }>();
  base.forEach((entry) => {
    const current = perNode.get(entry.nodeId) ?? { correct: 0, total: 0, accuracy: 0 };
    current.total += 1;
    if (entry.expectedScore === entry.predictedScore) current.correct += 1;
    current.accuracy = ratio(current.correct, current.total);
    perNode.set(entry.nodeId, current);
  });
  const nodeMacroAccuracy = ratio(
    [...perNode.values()].reduce((sum, node) => sum + node.accuracy, 0),
    perNode.size,
  );
  const correct = base.filter((entry) => entry.expectedScore === entry.predictedScore).length;

  const seriousCases = input.cases.filter((evalCase) => evalCase.seriousMisjudgmentOpportunity);
  const severeNumerator = seriousCases.filter((evalCase) =>
    base.some((entry) => entry.caseId === evalCase.id && entry.predictedScore === 'hit')).length;
  const severeFalseMastery = {
    numeratorCases: severeNumerator,
    denominatorCases: seriousCases.length,
    rate: ratio(severeNumerator, seriousCases.length),
  };

  const consistencyByCase = input.cases.map((evalCase) => {
    const runs = base.filter((entry) => entry.caseId === evalCase.id);
    const signatures = new Map<string, number>();
    runs.forEach((entry) => signatures.set(
      entry.resultSignature,
      (signatures.get(entry.resultSignature) ?? 0) + 1,
    ));
    const dominant = Math.max(0, ...signatures.values());
    return { caseId: evalCase.id, consistentRuns: dominant, totalRuns: runs.length, rate: ratio(dominant, runs.length, 1) };
  });
  const consistencyRate = ratio(
    consistencyByCase.reduce((sum, entry) => sum + entry.rate, 0),
    consistencyByCase.length,
    1,
  );

  let metamorphicPassed = 0;
  variants.forEach((entry) => {
    const baseRuns = base.filter((candidate) => candidate.caseId === entry.caseId);
    if (baseRuns.length > 0 && entry.predictedScore === modalScore(baseRuns)) metamorphicPassed += 1;
  });
  const metamorphic = {
    passed: metamorphicPassed,
    total: variants.length,
    rate: ratio(metamorphicPassed, variants.length, 1),
  };

  const citationHallucinations = base.filter((entry) => entry.citationHallucination).length;
  const schemaFailures = base.filter((entry) => entry.schemaFailure).length;
  const citationHallucinationRate = ratio(citationHallucinations, base.length);
  const schemaFailureRate = ratio(schemaFailures, base.length);
  const extractionComparable = base.filter((entry) => entry.extractionExact !== null);
  const extractionExactRate = ratio(
    extractionComparable.filter((entry) => entry.extractionExact).length,
    extractionComparable.length,
    1,
  );
  const latencies = input.observations.map((entry) => entry.latencyMs);
  const inputTokens = input.observations.reduce((sum, entry) => sum + entry.inputTokens, 0);
  const outputTokens = input.observations.reduce((sum, entry) => sum + entry.outputTokens, 0);
  const reportedCosts = input.observations
    .map((entry) => entry.estimatedCostUsd)
    .filter((value): value is number => value !== null);

  const gates = [
    gate(
      'node-macro-accuracy',
      '逐节点宏平均命中率',
      'minimum',
      input.config.thresholds.nodeMacroAccuracy,
      nodeMacroAccuracy,
    ),
    gate(
      'severe-false-mastery',
      '全错判掌握率',
      'maximum',
      input.config.thresholds.severeFalseMasteryRate,
      severeFalseMastery.rate,
    ),
    gate(
      'citation-hallucination',
      '引用幻觉率',
      'maximum',
      input.config.thresholds.citationHallucinationRate,
      citationHallucinationRate,
    ),
    gate(
      'schema-failure',
      'Schema 失败率',
      'maximum',
      input.config.thresholds.schemaFailureRate,
      schemaFailureRate,
    ),
    gate(
      'metamorphic-invariance',
      '蜕变判分不变率',
      'minimum',
      input.config.thresholds.metamorphicInvariantRate,
      metamorphic.rate,
    ),
  ];

  return {
    caseCount: input.cases.length,
    runCount: base.length,
    accuracy: ratio(correct, base.length),
    nodeMacroAccuracy,
    perNode: Object.fromEntries([...perNode.entries()].sort(([left], [right]) => left.localeCompare(right))),
    confusionMatrix,
    severeFalseMastery,
    citationHallucinations,
    citationHallucinationRate,
    schemaFailures,
    schemaFailureRate,
    extractionExactRate,
    consistencyRate,
    consistencyByCase,
    metamorphic,
    latency: {
      meanMs: ratio(latencies.reduce((sum, value) => sum + value, 0), latencies.length),
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      maxMs: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
    tokenUsage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costReportedRuns: reportedCosts.length,
      estimatedCostUsd: reportedCosts.length === 0
        ? null
        : reportedCosts.reduce((sum, value) => sum + value, 0),
    },
    gates,
    passed: gates.every((entry) => entry.passed),
    unobservedCaseIds: input.cases
      .filter((evalCase) => !base.some((entry) => entry.caseId === evalCase.id))
      .map((evalCase) => evalCase.id),
    unknownObservationCaseIds: [...new Set(input.observations
      .filter((entry) => !casesById.has(entry.caseId))
      .map((entry) => entry.caseId))],
  };
}

export type EvalMetrics = ReturnType<typeof computeEvalMetrics>;

