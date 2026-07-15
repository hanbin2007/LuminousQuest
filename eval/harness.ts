import path from 'node:path';

import type { StructuredAssessmentResponse } from '../shared/workflows/assessment';
import {
  recordNeedsReviewTextAssessment,
  recordStructuredTextAssessment,
} from '../shared/workflows/assessment';
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

export type EvalMode = 'mock' | 'replay' | 'live';

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
  if (input.mode === 'live') {
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
  runOverride?: number;
  includeMetamorphic?: boolean;
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
    const recordingFile = options.recordingsRoot
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
      logger: { error() {}, warn() {} },
    });
    const started = performance.now();
    const result = await runAssessmentExtraction({
      service,
      evalCandidates: candidates,
      config: productionConfig,
      prompt,
      answer: evalCase.studentAnswer,
      caseId: evalCase.questionRef.caseId,
      targetNodeIds: [evalCase.questionRef.nodeId],
      assistance: { kind: 'none', rounds: 0 },
      executionMode: 'live',
      provider: tracking.id,
      model: options.model,
      temperature: options.config.temperature,
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
      caseId: evalCase.questionRef.caseId,
      stageId: 'eval',
      attemptId: `${variant}-${iteration}`,
      questionId: `${evalCase.questionRef.caseId}:${evalCase.questionRef.nodeId}`,
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
    const extractionExact = actualExtraction === null
      ? null
      : JSON.stringify(actualExtraction) === JSON.stringify(expectedExtraction(evalCase));
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
        temperature: options.config.temperature,
        requests: tracking.requests,
        responses: tracking.responses,
        ...(options.now ? { now: options.now } : {}),
      });
      if (saved) recordingFiles.push(saved);
    }
  };

  for (const evalCase of options.cases) {
    const runs = options.runOverride ?? evalCase.runs ?? options.config.defaultRuns;
    for (let iteration = 1; iteration <= runs; iteration += 1) {
      await runOnce(evalCase, 'base', iteration);
    }
  }

  const includeMetamorphic = options.includeMetamorphic ?? options.config.metamorphic.enabled;
  if (includeMetamorphic) {
    for (const evalCase of options.cases) {
      for (const generated of generateMetamorphicVariants(evalCase)) {
        if (options.config.metamorphic.variants.includes(generated.variant)) {
          await runOnce(generated.case, generated.variant, 1);
        }
      }
    }
  }

  const metrics = computeEvalMetrics({ cases: options.cases, observations, config: options.config });
  return {
    observations,
    metrics,
    recordingFiles,
    metadata: {
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      mode: options.mode,
      provider: options.providerId,
      model: options.model,
      prompt: { id: prompt.id, version: prompt.version },
      configVersion: productionConfig.configVersion,
      rubricVersion: productionConfig.rubrics.version,
      temperature: options.config.temperature,
      cases: options.cases.length,
      baseRuns: observations.filter((entry) => entry.variant === 'base').length,
      metamorphicRuns: observations.filter((entry) => entry.variant !== 'base').length,
      recordingsRoot: options.recordingsRoot ?? path.join(options.contentRoot, 'eval', 'recordings'),
    },
  };
}

export type EvalHarnessResult = Awaited<ReturnType<typeof runEvalHarness>>;
