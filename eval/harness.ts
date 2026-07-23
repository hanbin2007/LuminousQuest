import path from 'node:path';

import type { StructuredAssessmentResponse } from '../shared/workflows/assessment';
import {
  recordNeedsReviewTextAssessment,
  recordStructuredTextAssessment,
} from '../shared/workflows/assessment';
import { recordEquationAssessment } from '../shared/workflows/engine-assessment';
import { createSession, sessionConfigVersions } from '../shared/session/session';
import { loadAllConfig } from '../server/config/loader';
import type {
  EvalCandidateWriter,
  ExtractionEvalCandidate,
} from '../server/llm/eval-candidate-store';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMProvider } from '../server/llm/types';
import { loadPrompt } from '../server/prompts/loader';
import { runAssessmentExtraction } from '../server/workflows/assessment-extraction';
import { computeEvalMetrics } from './metrics';
import { inspectEvalCoverage } from './load';
import { generateMetamorphicVariants } from './metamorphic';
import {
  evalRecordingFile,
  GoldenEvalProvider,
  loadEvalRecording,
  ReplayEvalProvider,
  saveEvalRecording,
  TrackingEvalProvider,
  type EvalVariant,
} from './providers';
import {
  evalObservationSchema,
  type EvalConfig,
  type EvalObservation,
  type EvalOutcome,
  type LabeledEvalCase,
} from './schema';

export type EvalMode = 'mock' | 'replay' | 'live' | 'holdout';

class MemoryCandidateWriter implements EvalCandidateWriter {
  readonly candidates: ExtractionEvalCandidate[] = [];

  async record(candidate: ExtractionEvalCandidate) {
    this.candidates.push(structuredClone(candidate));
    return `memory://${this.candidates.length}`;
  }
}

function canonicalExtraction(extraction: StructuredAssessmentResponse | null) {
  if (!extraction) return null;
  const assessment = extraction.assessments[0];
  if (!assessment) return null;
  return {
    anchors: extraction.anchors
      .map((anchor) => ({
        anchorId: anchor.anchorId,
        facts: anchor.facts
          .map((fact) => ({ id: fact.id, value: fact.value }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }))
      .sort((left, right) => left.anchorId.localeCompare(right.anchorId)),
    response: assessment.facts.response,
    terminology: assessment.facts.terminology,
    syllabus: assessment.facts.syllabus,
    contradiction: assessment.facts.contradiction,
    typo: assessment.facts.typo,
    errorIds: [...assessment.errorIds].sort(),
    slots: assessment.facts.slots
      .map((slot) => ({ id: slot.id, value: slot.value }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function expectedExtraction(evalCase: LabeledEvalCase) {
  return {
    anchors: evalCase.expectedExtraction.anchors
      .map((anchor) => ({
        anchorId: anchor.anchorId,
        facts: anchor.facts
          .map((fact) => ({ id: fact.id, value: fact.value }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }))
      .sort((left, right) => left.anchorId.localeCompare(right.anchorId)),
    response: evalCase.expectedExtraction.response,
    terminology: evalCase.expectedExtraction.terminology,
    syllabus: evalCase.expectedExtraction.syllabus,
    contradiction: evalCase.expectedExtraction.contradiction,
    typo: evalCase.expectedExtraction.typo,
    errorIds: [...evalCase.expectedExtraction.errorIds].sort(),
    slots: evalCase.expectedExtraction.slots
      .map((slot) => ({ id: slot.id, value: slot.value }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function outcomeFromRecorded(
  session: ReturnType<typeof createSession>,
  nodeId: string,
): EvalOutcome {
  const event = [...session.events].reverse().find((entry) =>
    entry.kind === 'assessment.completed' && entry.nodeId === nodeId);
  if (!event || event.kind !== 'assessment.completed') return 'needs-review';
  if (event.extraction.status === 'needs-review') return 'needs-review';
  if (event.score.status === 'unanswered') return 'unanswered';
  if (event.score.status !== 'scored') return 'needs-review';
  return event.score.outcome === 'hit-with-help' ? 'hit' : (event.score.outcome ?? 'needs-review');
}

function estimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: EvalConfig['pricing'],
) {
  if (
    pricing.inputUsdPerMillionTokens === null
    || pricing.outputUsdPerMillionTokens === null
  ) return null;
  return (
    inputTokens * pricing.inputUsdPerMillionTokens
    + outputTokens * pricing.outputUsdPerMillionTokens
  ) / 1_000_000;
}

function schemaFailure(reason: string | undefined) {
  return reason !== undefined && ['invalid-json', 'schema-invalid', 'schema-definition'].includes(reason);
}

function providerForRun(input: {
  mode: EvalMode;
  evalCase: LabeledEvalCase;
  providerId: string;
  model: string;
  recordingFile?: string;
  liveProvider?: LLMProvider;
}) {
  if (input.mode === 'mock') {
    return Promise.resolve<LLMProvider>(new GoldenEvalProvider(
      input.providerId,
      input.evalCase,
      input.model,
    ));
  }
  if (input.mode === 'live' || input.mode === 'holdout') {
    if (!input.liveProvider) throw new Error(`Live eval provider ${input.providerId} is not configured`);
    if (input.liveProvider.id !== input.providerId) {
      throw new Error(`Live eval provider id ${input.liveProvider.id} does not match ${input.providerId}`);
    }
    return Promise.resolve(input.liveProvider);
  }
  if (!input.recordingFile) throw new Error('Replay mode requires an eval recordings root');
  return loadEvalRecording(input.recordingFile).then((recording) =>
    new ReplayEvalProvider(input.providerId, recording));
}

export interface EvalHarnessOptions {
  contentRoot: string;
  cases: readonly LabeledEvalCase[];
  config: EvalConfig;
  mode: EvalMode;
  providerId: string;
  model: string;
  provider?: LLMProvider;
  recordingsRoot?: string;
  recordingPolicy?: 'replayable' | 'none';
  runOverride?: number;
  concurrency?: number;
  includeMetamorphic?: boolean;
  evaluationScope?: 'pilot' | 'full';
  caseVisibility?: 'detailed' | 'aggregate-only';
  now?: () => Date;
}

export async function runEvalHarness(options: EvalHarnessOptions) {
  const [productionConfig, prompt] = await Promise.all([
    loadAllConfig(options.contentRoot),
    loadPrompt(options.contentRoot, 'structured-assessment'),
  ]);
  if (!prompt) throw new Error('Required prompt structured-assessment is missing');
  const observations: EvalObservation[] = [];
  const recordingFiles: string[] = [];

  const runOnce = async (
    evalCase: LabeledEvalCase,
    variant: EvalVariant,
    iteration: number,
  ) => {
    if (evalCase.evaluationPath === 'equation') {
      const timestamp = '2026-07-15T00:00:00.000Z';
      const session = createSession({
        id: `eval-${evalCase.id}-${variant}-${iteration}`,
        now: timestamp,
        configVersions: sessionConfigVersions(productionConfig),
      });
      const started = performance.now();
      const recorded = recordEquationAssessment({
        session,
        config: productionConfig,
        equationSetId: evalCase.questionRef.equationSetId!,
        answer: {
          id: `answer-${evalCase.id}-${variant}-${iteration}`,
          occurredAt: timestamp,
          caseId: evalCase.questionRef.caseId!,
          stageId: 'eval-equation',
          attemptId: `${variant}-${iteration}`,
          questionId: `${evalCase.questionRef.caseId}:${evalCase.questionRef.equationSetId}`,
          value: evalCase.studentAnswer,
        },
        assistance: { kind: 'none', rounds: 0 },
        assessmentEventIdPrefix: `assessment-${evalCase.id}-${variant}-${iteration}`,
        assessedAt: timestamp,
      });
      const predictedScore = outcomeFromRecorded(recorded.session, evalCase.questionRef.nodeId);
      const equationSlot = evalCase.expectedExtraction.slots.find((slot) => slot.id === 'equation');
      const nodeDecision = recorded.assessment.nodeDecisions.find((entry) =>
        entry.nodeId === evalCase.questionRef.nodeId);
      const expectedErrorIds = [...evalCase.expectedExtraction.errorIds].sort();
      const predictedErrorIds = [...(nodeDecision?.errorIds ?? [])].sort();
      const errorIdsExact = JSON.stringify(predictedErrorIds) === JSON.stringify(expectedErrorIds);
      observations.push(evalObservationSchema.parse({
        caseId: evalCase.id,
        nodeId: evalCase.questionRef.nodeId,
        variant,
        iteration,
        expectedScore: evalCase.expectedScore,
        predictedScore,
        expectedErrorIds,
        predictedErrorIds,
        errorIdsExact,
        extractionAttempted: true,
        extractionExact:
          equationSlot?.value.trim() === evalCase.studentAnswer.trim() && errorIdsExact,
        resultSignature: JSON.stringify({
          predictedScore,
          predictedErrorIds,
          engine: recorded.assessment.ruleId,
        }),
        source: 'deterministic-engine',
        latencyMs: performance.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: estimatedCost(0, 0, options.config.pricing),
        citationHallucination: false,
        schemaFailure: false,
        closedSetFailure: false,
      }));
      return;
    }
    const recordingFile = options.recordingPolicy !== 'none' && options.recordingsRoot
      ? evalRecordingFile({
          recordingsRoot: options.recordingsRoot,
          providerId: options.providerId,
          caseId: evalCase.id,
          variant,
          iteration,
        })
      : undefined;
    const provider = await providerForRun({
      mode: options.mode,
      evalCase,
      providerId: options.providerId,
      model: options.model,
      ...(recordingFile ? { recordingFile } : {}),
      ...(options.provider ? { liveProvider: options.provider } : {}),
    });
    const tracking = new TrackingEvalProvider(provider);
    const candidates = new MemoryCandidateWriter();
    const service = new LLMService({
      providers: new Map([[tracking.id, tracking]]),
      recordings: new RecordingStore(options.contentRoot),
      logger: {
        error: (message: string) => console.error(`[eval:${evalCase.id}] ${message}`),
        warn() {},
      },
    });
    const question = evalCase.questionRef.questionId
      ? productionConfig.pretest.questions.find((entry) =>
          entry.id === evalCase.questionRef.questionId && entry.type === 'text')
      : undefined;
    if (evalCase.questionRef.questionId && (!question || question.type !== 'text')) {
      throw new Error(`Eval case ${evalCase.id} references unknown text question ${evalCase.questionRef.questionId}`);
    }
    const referenceCaseId = evalCase.questionRef.caseId
      ?? (question && question.type === 'text' ? question.referenceEquations[0]!.caseId : '');
    const started = performance.now();
    const result = await runAssessmentExtraction({
      service,
      evalCandidates: candidates,
      config: productionConfig,
      prompt,
      answer: evalCase.studentAnswer,
      caseId: referenceCaseId,
      targetNodeIds: [evalCase.questionRef.nodeId],
      ...(question && question.type === 'text' && question.evidence
        ? { questionEvidence: question.evidence }
        : {}),
      assistance: { kind: 'none', rounds: 0 },
      executionMode: 'live',
      provider: tracking.id,
      model: options.model,
      logger: { warn() {} },
    });
    const latencyMs = performance.now() - started;
    const timestamp = '2026-07-15T00:00:00.000Z';
    const session = createSession({
      id: `eval-${evalCase.id}-${variant}-${iteration}`,
      now: timestamp,
      configVersions: sessionConfigVersions(productionConfig),
    });
    const answer = {
      id: `answer-${evalCase.id}-${variant}-${iteration}`,
      occurredAt: timestamp,
      caseId: evalCase.questionRef.questionId ? 'pretest' : evalCase.questionRef.caseId!,
      stageId: 'eval',
      attemptId: `${variant}-${iteration}`,
      questionId: evalCase.questionRef.questionId
        ?? `${evalCase.questionRef.caseId}:${evalCase.questionRef.nodeId}`,
      value: evalCase.studentAnswer,
    };
    const provenance = {
      promptId: prompt.id,
      promptVersion: prompt.version,
      cacheKey: result.cacheKey,
      model: result.model,
    };
    const recorded = result.status === 'extracted'
      ? recordStructuredTextAssessment({
          session,
          config: productionConfig,
          answer,
          extraction: result.extraction,
          provenance,
          assessmentEventIdPrefix: `assessment-${evalCase.id}-${variant}-${iteration}`,
          assessedAt: timestamp,
          ...(evalCase.questionRef.questionId ? { referenceCaseId } : {}),
          ...(question && question.type === 'text' && question.evidence
            ? { questionEvidence: question.evidence }
            : {}),
        })
      : recordNeedsReviewTextAssessment({
          session,
          config: productionConfig,
          answer,
          nodeId: evalCase.questionRef.nodeId,
          assistance: { kind: 'none', rounds: 0 },
          reason: result.reason,
          provenance,
          assessmentEventId: `assessment-${evalCase.id}-${variant}-${iteration}`,
          assessedAt: timestamp,
        });
    const predictedScore = outcomeFromRecorded(recorded.session, evalCase.questionRef.nodeId);
    const actualExtraction = result.status === 'extracted' ? canonicalExtraction(result.extraction) : null;
    const extractionAttempted = actualExtraction !== null;
    const extractionExact = actualExtraction !== null
      && JSON.stringify(actualExtraction) === JSON.stringify(expectedExtraction(evalCase));
    const expectedErrorIds = [...evalCase.expectedExtraction.errorIds].sort();
    const predictedErrorIds = actualExtraction?.errorIds ?? [];
    const errorIdsExact = actualExtraction !== null
      && JSON.stringify(predictedErrorIds) === JSON.stringify(expectedErrorIds);
    const inputTokens = tracking.responses.reduce(
      (sum, response) => sum + (response.usage?.inputTokens ?? 0),
      0,
    );
    const outputTokens = tracking.responses.reduce(
      (sum, response) => sum + (response.usage?.outputTokens ?? 0),
      0,
    );
    const failureReason = result.status === 'needs-review' ? result.reason : undefined;
    const observation = evalObservationSchema.parse({
      caseId: evalCase.id,
      nodeId: evalCase.questionRef.nodeId,
      variant,
      iteration,
      expectedScore: evalCase.expectedScore,
      predictedScore,
      expectedErrorIds,
      predictedErrorIds,
      errorIdsExact,
      extractionAttempted,
      extractionExact,
      resultSignature: JSON.stringify({
        predictedScore,
        extraction: actualExtraction,
        failureReason,
      }),
      source: result.source,
      ...(failureReason ? { failureReason } : {}),
      latencyMs,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimatedCost(inputTokens, outputTokens, options.config.pricing),
      citationHallucination: candidates.candidates.some((candidate) =>
        candidate.category === 'citation-mismatch'
        || candidate.category === 'normalization-insufficient'),
      schemaFailure: schemaFailure(failureReason),
      closedSetFailure: failureReason === 'closed-set',
    });
    observations.push(observation);

    if (options.mode === 'live' && recordingFile) {
      const saved = await saveEvalRecording({
        file: recordingFile,
        evalCase,
        variant,
        iteration,
        providerId: options.providerId,
        model: options.model,
        temperature: productionConfig.scaffoldPolicy.extraction.temperature,
        requests: tracking.requests,
        responses: tracking.responses,
        ...(options.now ? { now: options.now } : {}),
      });
      if (saved) recordingFiles.push(saved);
    }
  };

  const tasks: Array<() => Promise<void>> = [];
  for (const evalCase of options.cases) {
    const runs = options.runOverride ?? evalCase.runs ?? options.config.defaultRuns;
    for (let iteration = 1; iteration <= runs; iteration += 1) {
      tasks.push(() => runOnce(evalCase, 'base', iteration));
    }
  }

  const includeMetamorphic = options.includeMetamorphic ?? options.config.metamorphic.enabled;
  if (includeMetamorphic) {
    for (const evalCase of options.cases) {
      for (const generated of generateMetamorphicVariants(evalCase)) {
        if (options.config.metamorphic.variants.includes(generated.variant)) {
          tasks.push(() => runOnce(generated.case, generated.variant, 1));
        }
      }
    }
  }

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  if (concurrency <= 1) {
    for (const task of tasks) await task();
  } else {
    let nextTaskIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (nextTaskIndex < tasks.length) {
          const index = nextTaskIndex;
          nextTaskIndex += 1;
          await tasks[index]();
        }
      }),
    );
  }

  const evaluationScope = options.evaluationScope ?? 'full';
  const coverage = inspectEvalCoverage({
    cases: options.cases,
    productionConfig,
  });
  const metrics = computeEvalMetrics({
    cases: options.cases,
    observations,
    config: options.config,
    mode: options.mode,
    evaluationScope,
    coverage,
  });
  const harnessSelfCheck = {
    passed: observations.filter((entry) => entry.variant === 'base').length > 0
      && metrics.unobservedCaseIds.length === 0
      && metrics.unknownObservationCaseIds.length === 0
      && metrics.schemaFailures === 0
      && metrics.extraction.expected === metrics.extraction.attempted
      && metrics.extraction.expected === metrics.extraction.exact
      && metrics.diagnostics.expected === metrics.diagnostics.exact
      && metrics.scoreConsistency.rate === 1
      && metrics.outputConsistency.rate === 1,
  };
  const pilotCheck = {
    passed: evaluationScope === 'pilot'
      && metrics.closedSetComplianceRate >= options.config.live.minimumClosedSetComplianceRate
      && metrics.schemaFailureRate <= options.config.thresholds.schemaFailureRate
      && metrics.runCount > 0,
  };
  return {
    observations,
    metrics,
    coverage,
    harnessSelfCheck,
    pilotCheck,
    recordingFiles,
    metadata: {
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      mode: options.mode,
      provider: options.providerId,
      model: options.model,
      prompt: { id: prompt.id, version: prompt.version },
      configVersion: productionConfig.configVersion,
      rubricVersion: productionConfig.rubrics.version,
      temperature: productionConfig.scaffoldPolicy.extraction.temperature,
      corpusStage: options.config.corpus.stage,
      evaluationScope,
      caseVisibility: options.caseVisibility ?? 'detailed',
      harnessSelfCheckPassed: harnessSelfCheck.passed,
      qualityGateEligible: metrics.qualityGateEligible,
      cases: options.cases.length,
      baseRuns: observations.filter((entry) => entry.variant === 'base').length,
      metamorphicRuns: observations.filter((entry) => entry.variant !== 'base').length,
      recordingsRoot: options.recordingsRoot ?? path.join(options.contentRoot, 'eval', 'recordings'),
    },
  };
}

export type EvalHarnessResult = Awaited<ReturnType<typeof runEvalHarness>>;
