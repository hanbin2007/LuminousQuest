import type { EvalMetrics } from './metrics';

export interface EvalReportMetadata {
  generatedAt: string;
  mode: string;
  provider: string;
  model: string;
  prompt: { id: string; version: string };
  configVersion: string;
  rubricVersion: string;
  temperature: number;
  corpusStage: 'seed' | 'complete';
  evaluationScope: 'pilot' | 'full';
  caseVisibility: 'detailed' | 'aggregate-only';
  harnessSelfCheckPassed: boolean;
  qualityGateEligible: boolean;
  cases: number;
  baseRuns: number;
  metamorphicRuns: number;
  recordingsRoot: string;
}

function percent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function number(value: number) {
  return value.toFixed(2);
}

function gateValue(value: number, format: 'rate' | 'count') {
  return format === 'rate' ? percent(value) : String(value);
}

export function renderEvalMarkdownReport(input: {
  metrics: EvalMetrics;
  metadata: EvalReportMetadata;
}) {
  const { metrics, metadata } = input;
  const modeNotice = metadata.mode === 'mock'
    ? '**自洽性检查,非质量门禁**: mock 只验证 harness、生产链路和指标自洽性。'
    : metadata.evaluationScope === 'pilot'
      ? '**国产模型闭集小批核对,非完整质量门禁**: 通过后方可显式运行 full。'
      : null;
  const qualityStatus = metadata.qualityGateEligible
    ? (metrics.passed ? 'PASS' : 'FAIL')
    : 'NOT APPLICABLE';
  const lines = [
    '# M1c Eval Report',
    '',
    ...(modeNotice ? [`> ${modeNotice}`, ''] : []),
    `- Generated: ${metadata.generatedAt}`,
    `- Mode/scope: ${metadata.mode} / ${metadata.evaluationScope}`,
    `- Corpus stage: ${metadata.corpusStage}`,
    `- Provider/model: ${metadata.provider} / ${metadata.model}`,
    `- Prompt: ${metadata.prompt.id} @ ${metadata.prompt.version}`,
    `- Config/rubric: ${metadata.configVersion} / ${metadata.rubricVersion}`,
    `- Temperature: ${metadata.temperature}`,
    `- Cases/base runs/metamorphic runs: ${metadata.cases} / ${metadata.baseRuns} / ${metadata.metamorphicRuns}`,
    `- Harness self-check: ${metadata.harnessSelfCheckPassed ? 'PASS' : 'FAIL'}`,
    '',
    '## Gate Summary',
    '',
    '| Gate | Direction | Threshold | Actual | Status |',
    '| --- | ---: | ---: | ---: | --- |',
    ...metrics.gates.map((entry) =>
      `| ${entry.label} | ${entry.direction === 'minimum' ? '>=' : '<='} | ${gateValue(entry.threshold, entry.format)} | ${entry.observed ? gateValue(entry.actual, entry.format) : 'N/A'} | ${entry.passed ? 'PASS' : 'FAIL'} |`),
    '',
    `Quality gate: **${qualityStatus}**`,
    '',
    '## Quality Metrics',
    '',
    `- Case-vote accuracy: ${percent(metrics.accuracy)}`,
    `- 逐节点宏平均命中率 (case 多数票): ${percent(metrics.nodeMacroAccuracy)}`,
    `- Extraction expected/attempted/exact: ${metrics.extraction.expected} / ${metrics.extraction.attempted} / ${metrics.extraction.exact}; exact rate=${percent(metrics.extraction.exactRate)}`,
    `- Diagnostic errorIds expected/exact: ${metrics.diagnostics.expected} / ${metrics.diagnostics.exact} (${percent(metrics.diagnostics.exactRate)})`,
    `- 判分一致率 / 输出一致率: ${percent(metrics.scoreConsistency.rate)} / ${percent(metrics.outputConsistency.rate)}`,
    `- Minimum-run completeness: ${metrics.runCompleteness.completeCases}/${metrics.runCompleteness.totalCases} cases have >=${metrics.runCompleteness.minimumRunsPerCase} runs`,
    `- Citation hallucination: ${metrics.citationHallucinations}/${metrics.runCount} (${percent(metrics.citationHallucinationRate)})`,
    `- Schema failure: ${metrics.schemaFailures}/${metrics.runCount} (${percent(metrics.schemaFailureRate)})`,
    `- Closed-set compliance: ${metrics.runCount - metrics.closedSetFailures}/${metrics.runCount} (${percent(metrics.closedSetComplianceRate)})`,
    `- 全错判掌握率: ${metrics.severeFalseMastery.numeratorCases}/${metrics.severeFalseMastery.denominatorCases} (${percent(metrics.severeFalseMastery.rate)}); denominatorCases=ground-truth miss case 多数票`,
    `- 手工 serious 标志 case / 未观测 serious case: ${metrics.severeFalseMastery.manualOpportunityCases} / ${metrics.unobservedSeriousCaseCount}`,
    `- Metamorphic invariance (applicable variants only): ${metrics.metamorphic.passed}/${metrics.metamorphic.total} (${percent(metrics.metamorphic.rate)})`,
    '',
    '## Per-node Accuracy',
    '',
    '| Node | Correct cases | Observed cases | Accuracy |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(metrics.perNode).map(([nodeId, entry]) =>
      `| ${nodeId} | ${entry.correct} | ${entry.total} | ${percent(entry.accuracy)} |`),
    '',
    '## Confusion Matrix',
    '',
    '| expected \\ predicted | hit | partial | miss | unanswered | needs-review |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...(['hit', 'partial', 'miss', 'unanswered', 'needs-review'] as const).map((expected) => {
      const row = metrics.confusionMatrix[expected];
      return `| ${expected} | ${row.hit} | ${row.partial} | ${row.miss} | ${row.unanswered} | ${row['needs-review']} |`;
    }),
    '',
    '## Performance And Token Cost',
    '',
    `- Latency mean/P50/P95/max: ${number(metrics.latency.meanMs)} / ${number(metrics.latency.p50Ms)} / ${number(metrics.latency.p95Ms)} / ${number(metrics.latency.maxMs)} ms`,
    `- Token input/output/total: ${metrics.tokenUsage.inputTokens} / ${metrics.tokenUsage.outputTokens} / ${metrics.tokenUsage.totalTokens}`,
    `- Estimated token cost: ${metrics.tokenUsage.estimatedCostUsd === null ? 'N/A (pricing not configured)' : `$${metrics.tokenUsage.estimatedCostUsd.toFixed(6)}`}`,
    '',
    ...(metadata.caseVisibility === 'aggregate-only' ? [] : [
      '## Case Consistency',
      '',
      '| Case | Runs | Score identical | Output identical | >=3 runs |',
      '| --- | ---: | --- | --- | --- |',
      ...metrics.consistencyByCase.map((entry) =>
        `| ${entry.caseId} | ${entry.totalRuns} | ${entry.scoreConsistent ? 'yes' : 'no'} | ${entry.outputConsistent ? 'yes' : 'no'} | ${entry.minimumRunsMet ? 'yes' : 'no'} |`),
      '',
    ]),
  ];
  return `${lines.join('\n')}\n`;
}
