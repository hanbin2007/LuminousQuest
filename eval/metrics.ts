import type {
  EvalConfig,
  EvalObservation,
  EvalOutcome,
  LabeledEvalCase,
} from './schema';

const outcomes: EvalOutcome[] = ['hit', 'partial', 'miss', 'unanswered', 'needs-review'];
const minimumFormalRuns = 3;

export interface EvalGate {
  id: string;
  label: string;
  direction: 'minimum' | 'maximum';
  format: 'rate' | 'count';
  threshold: number;
  actual: number;
  observed: boolean;
  passed: boolean;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], quantile: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
}

function modalScore(observations: readonly EvalObservation[]) {
  const counts = new Map<EvalOutcome, number>();
  observations.forEach((entry) => counts.set(
    entry.predictedScore,
    (counts.get(entry.predictedScore) ?? 0) + 1,
  ));
  const maximum = Math.max(0, ...counts.values());
  const winners = outcomes.filter((outcome) => (counts.get(outcome) ?? 0) === maximum);
  return winners.length === 1 ? winners[0] : 'needs-review';
}

function gate(input: Omit<EvalGate, 'passed'>): EvalGate {
  return {
    ...input,
    passed: input.observed && (
      input.direction === 'minimum'
        ? input.actual >= input.threshold
        : input.actual <= input.threshold
    ),
  };
}

interface CoverageSummary {
  complete: boolean;
  requirements: {
    minimumCases: number;
    minimumCasesPerNode: number;
    minimumCasesPerMisconception: number;
  };
  casesPerNode: Record<string, number>;
  casesPerMisconception: Record<string, number>;
}

export function computeEvalMetrics(input: {
  cases: readonly LabeledEvalCase[];
  observations: readonly EvalObservation[];
  config: EvalConfig;
  mode?: 'mock' | 'replay' | 'live' | 'holdout';
  evaluationScope?: 'pilot' | 'full';
  coverage?: CoverageSummary;
}) {
  const mode = input.mode ?? 'live';
  const evaluationScope = input.evaluationScope ?? 'full';
  const base = input.observations.filter((entry) => entry.variant === 'base');
  const variants = input.observations.filter((entry) => entry.variant !== 'base');
  const casesById = new Map(input.cases.map((evalCase) => [evalCase.id, evalCase]));
  const baseByCase = new Map(input.cases.map((evalCase) => [
    evalCase.id,
    base.filter((entry) => entry.caseId === evalCase.id),
  ]));
  const caseVotes = input.cases.map((evalCase) => {
    const runs = baseByCase.get(evalCase.id) ?? [];
    return {
      caseId: evalCase.id,
      nodeId: evalCase.questionRef.nodeId,
      expectedScore: evalCase.expectedScore,
      predictedScore: modalScore(runs),
      observed: runs.length > 0,
      runs,
    };
  });
  const observedCaseVotes = caseVotes.filter((entry) => entry.observed);

  const confusionMatrix = Object.fromEntries(outcomes.map((expected) => [
    expected,
    Object.fromEntries(outcomes.map((predicted) => [predicted, 0])) as Record<EvalOutcome, number>,
  ])) as Record<EvalOutcome, Record<EvalOutcome, number>>;
  observedCaseVotes.forEach((entry) => {
    confusionMatrix[entry.expectedScore][entry.predictedScore] += 1;
  });

  const perNode = new Map<string, { correct: number; total: number; accuracy: number }>();
  observedCaseVotes.forEach((entry) => {
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
  const correctCases = observedCaseVotes.filter((entry) =>
    entry.expectedScore === entry.predictedScore).length;

  const groundTruthMisses = observedCaseVotes.filter((entry) => entry.expectedScore === 'miss');
  const severeNumerator = groundTruthMisses.filter((entry) => entry.predictedScore === 'hit').length;
  const manualOpportunityCases = input.cases.filter((evalCase) =>
    evalCase.seriousMisjudgmentOpportunity);
  const severeFalseMastery = {
    numeratorCases: severeNumerator,
    denominatorCases: groundTruthMisses.length,
    rate: ratio(severeNumerator, groundTruthMisses.length),
    manualOpportunityCases: manualOpportunityCases.length,
    unobservedManualOpportunityCases: manualOpportunityCases.filter((evalCase) =>
      (baseByCase.get(evalCase.id)?.length ?? 0) === 0).length,
  };

  const consistencyByCase = caseVotes.map((entry) => {
    const scoreSignatures = new Set(entry.runs.map((run) => run.predictedScore));
    const outputSignatures = new Set(entry.runs.map((run) => run.resultSignature));
    return {
      caseId: entry.caseId,
      totalRuns: entry.runs.length,
      scoreConsistent: entry.runs.length > 0 && scoreSignatures.size === 1,
      outputConsistent: entry.runs.length > 0 && outputSignatures.size === 1,
      minimumRunsMet: entry.runs.length >= minimumFormalRuns,
    };
  });
  const scoreConsistentCases = consistencyByCase.filter((entry) => entry.scoreConsistent).length;
  const outputConsistentCases = consistencyByCase.filter((entry) => entry.outputConsistent).length;
  const completeRunCases = consistencyByCase.filter((entry) => entry.minimumRunsMet).length;
  const scoreConsistency = {
    consistentCases: scoreConsistentCases,
    totalCases: input.cases.length,
    rate: ratio(scoreConsistentCases, input.cases.length),
  };
  const outputConsistency = {
    consistentCases: outputConsistentCases,
    totalCases: input.cases.length,
    rate: ratio(outputConsistentCases, input.cases.length),
  };
  const runCompleteness = {
    completeCases: completeRunCases,
    totalCases: input.cases.length,
    minimumRunsPerCase: minimumFormalRuns,
    rate: ratio(completeRunCases, input.cases.length),
  };

  let metamorphicPassed = 0;
  variants.forEach((entry) => {
    const baseRuns = baseByCase.get(entry.caseId) ?? [];
    if (baseRuns.length > 0 && entry.predictedScore === modalScore(baseRuns)) metamorphicPassed += 1;
  });
  const metamorphic = {
    passed: metamorphicPassed,
    total: variants.length,
    rate: ratio(metamorphicPassed, variants.length),
  };

  const citationHallucinations = base.filter((entry) => entry.citationHallucination).length;
  const schemaFailures = base.filter((entry) => entry.schemaFailure).length;
  const closedSetFailures = base.filter((entry) => entry.closedSetFailure).length;
  const citationHallucinationRate = ratio(citationHallucinations, base.length);
  const schemaFailureRate = ratio(schemaFailures, base.length);
  const closedSetComplianceRate = ratio(base.length - closedSetFailures, base.length);
  const extractionAttempted = base.filter((entry) => entry.extractionAttempted).length;
  const extractionExact = base.filter((entry) => entry.extractionExact).length;
  const extraction = {
    expected: base.length,
    attempted: extractionAttempted,
    exact: extractionExact,
    attemptRate: ratio(extractionAttempted, base.length),
    exactRate: ratio(extractionExact, base.length),
  };
  const diagnosticExact = base.filter((entry) => entry.errorIdsExact).length;
  const diagnostics = {
    expected: base.length,
    exact: diagnosticExact,
    exactRate: ratio(diagnosticExact, base.length),
  };
  const latencies = input.observations.map((entry) => entry.latencyMs);
  const inputTokens = input.observations.reduce((sum, entry) => sum + entry.inputTokens, 0);
  const outputTokens = input.observations.reduce((sum, entry) => sum + entry.outputTokens, 0);
  const reportedCosts = input.observations
    .map((entry) => entry.estimatedCostUsd)
    .filter((value): value is number => value !== null);

  const gates: EvalGate[] = [
    gate({
      id: 'node-macro-accuracy',
      label: '逐节点宏平均命中率',
      direction: 'minimum',
      format: 'rate',
      threshold: input.config.thresholds.nodeMacroAccuracy,
      actual: nodeMacroAccuracy,
      observed: perNode.size > 0,
    }),
    gate({
      id: 'severe-false-mastery',
      label: '全错判掌握率',
      direction: 'maximum',
      format: 'rate',
      threshold: input.config.thresholds.severeFalseMasteryRate,
      actual: severeFalseMastery.rate,
      observed: groundTruthMisses.length > 0,
    }),
    gate({
      id: 'citation-hallucination',
      label: '引用幻觉率',
      direction: 'maximum',
      format: 'rate',
      threshold: input.config.thresholds.citationHallucinationRate,
      actual: citationHallucinationRate,
      observed: base.length > 0,
    }),
    gate({
      id: 'schema-failure',
      label: 'Schema 失败率',
      direction: 'maximum',
      format: 'rate',
      threshold: input.config.thresholds.schemaFailureRate,
      actual: schemaFailureRate,
      observed: base.length > 0,
    }),
    gate({
      id: 'metamorphic-invariance',
      label: '蜕变判分不变率',
      direction: 'minimum',
      format: 'rate',
      threshold: input.config.thresholds.metamorphicInvariantRate,
      actual: metamorphic.rate,
      observed: variants.length > 0,
    }),
    gate({
      id: 'score-consistency',
      label: '判分一致率',
      direction: 'minimum',
      format: 'rate',
      threshold: input.config.thresholds.scoreConsistencyRate,
      actual: scoreConsistency.rate,
      observed: input.cases.length > 0 && base.length > 0,
    }),
    gate({
      id: 'minimum-runs-per-case',
      label: '每 case 至少三次运行',
      direction: 'minimum',
      format: 'rate',
      threshold: 1,
      actual: runCompleteness.rate,
      observed: input.cases.length > 0,
    }),
  ];

  if (evaluationScope === 'pilot') {
    gates.push(gate({
      id: 'closed-set-compliance',
      label: '国产模型闭集遵守率',
      direction: 'minimum',
      format: 'rate',
      threshold: input.config.live.minimumClosedSetComplianceRate,
      actual: closedSetComplianceRate,
      observed: base.length > 0,
    }));
  }

  if (input.coverage) {
    const nodeCounts = Object.values(input.coverage.casesPerNode);
    const misconceptionCounts = Object.values(input.coverage.casesPerMisconception);
    const minimumNodeCases = nodeCounts.length === 0 ? 0 : Math.min(...nodeCounts);
    const minimumMisconceptionCases = misconceptionCounts.length === 0
      ? 0
      : Math.min(...misconceptionCounts);
    gates.push(
      gate({
        id: 'coverage-cases',
        label: '语料 case 数',
        direction: 'minimum',
        format: 'count',
        threshold: input.coverage.requirements.minimumCases,
        actual: input.cases.length,
        observed: true,
      }),
      gate({
        id: 'coverage-per-node',
        label: '每节点最少 case 数',
        direction: 'minimum',
        format: 'count',
        threshold: input.coverage.requirements.minimumCasesPerNode,
        actual: minimumNodeCases,
        observed: Object.keys(input.coverage.casesPerNode).length > 0,
      }),
      gate({
        id: 'coverage-per-misconception',
        label: '每误区最少诊断断言数',
        direction: 'minimum',
        format: 'count',
        threshold: input.coverage.requirements.minimumCasesPerMisconception,
        actual: minimumMisconceptionCases,
        observed: Object.keys(input.coverage.casesPerMisconception).length > 0,
      }),
    );
  }

  const gatesPassed = gates.every((entry) => entry.passed);
  const qualityGateEligible = (mode === 'replay' || mode === 'live')
    && evaluationScope === 'full';
  return {
    caseCount: input.cases.length,
    runCount: base.length,
    accuracy: ratio(correctCases, observedCaseVotes.length),
    nodeMacroAccuracy,
    perNode: Object.fromEntries([...perNode.entries()].sort(([left], [right]) =>
      left.localeCompare(right))),
    confusionMatrix,
    severeFalseMastery,
    citationHallucinations,
    citationHallucinationRate,
    schemaFailures,
    schemaFailureRate,
    closedSetFailures,
    closedSetComplianceRate,
    extraction,
    diagnostics,
    scoreConsistency,
    outputConsistency,
    runCompleteness,
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
    gatesPassed,
    qualityGateEligible,
    passed: qualityGateEligible && gatesPassed,
    unobservedCaseIds: input.cases
      .filter((evalCase) => (baseByCase.get(evalCase.id)?.length ?? 0) === 0)
      .map((evalCase) => evalCase.id),
    unobservedSeriousCaseCount: severeFalseMastery.unobservedManualOpportunityCases,
    unknownObservationCaseIds: [...new Set(input.observations
      .filter((entry) => !casesById.has(entry.caseId))
      .map((entry) => entry.caseId))],
  };
}

export type EvalMetrics = ReturnType<typeof computeEvalMetrics>;
