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

export function renderEvalMarkdownReport(input: {
  metrics: EvalMetrics;
  metadata: EvalReportMetadata;
}) {
  const { metrics, metadata } = input;
  const lines = [
    '# M1c Eval Report',
    '',
    `- Generated: ${metadata.generatedAt}`,
    `- Mode: ${metadata.mode}`,
    `- Provider/model: ${metadata.provider} / ${metadata.model}`,
    `- Prompt: ${metadata.prompt.id} @ ${metadata.prompt.version}`,
    `- Config/rubric: ${metadata.configVersion} / ${metadata.rubricVersion}`,
    `- Temperature: ${metadata.temperature}`,
    `- Cases/base runs/metamorphic runs: ${metadata.cases} / ${metadata.baseRuns} / ${metadata.metamorphicRuns}`,
    '',
    '## Gate Summary',
    '',
    '| Gate | Direction | Threshold | Actual | Status |',
    '| --- | ---: | ---: | ---: | --- |',
    ...metrics.gates.map((entry) =>
      `| ${entry.label} | ${entry.direction === 'minimum' ? '>=' : '<='} | ${percent(entry.threshold)} | ${percent(entry.actual)} | ${entry.passed ? 'PASS' : 'FAIL'} |`),
    '',
    `Overall: **${metrics.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '## Quality Metrics',
    '',
    `- Accuracy: ${percent(metrics.accuracy)}`,
    `- 逐节点宏平均命中率: ${percent(metrics.nodeMacroAccuracy)}`,
    `- Extraction exact rate: ${percent(metrics.extractionExactRate)}`,
    `- Consistency: ${percent(metrics.consistencyRate)}`,
    `- Citation hallucination: ${metrics.citationHallucinations}/${metrics.runCount} (${percent(metrics.citationHallucinationRate)})`,
    `- Schema failure: ${metrics.schemaFailures}/${metrics.runCount} (${percent(metrics.schemaFailureRate)})`,
    `- 全错判掌握率: ${metrics.severeFalseMastery.numeratorCases}/${metrics.severeFalseMastery.denominatorCases} (${percent(metrics.severeFalseMastery.rate)}); denominatorCases=有严重误判机会的 case 数`,
    `- Metamorphic invariance: ${metrics.metamorphic.passed}/${metrics.metamorphic.total} (${percent(metrics.metamorphic.rate)})`,
    '',
    '## Per-node Accuracy',
    '',
    '| Node | Correct | Runs | Accuracy |',
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
    '## Case Consistency',
    '',
    '| Case | Dominant runs | Runs | Rate |',
    '| --- | ---: | ---: | ---: |',
    ...metrics.consistencyByCase.map((entry) =>
      `| ${entry.caseId} | ${entry.consistentRuns} | ${entry.totalRuns} | ${percent(entry.rate)} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

