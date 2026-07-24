import { z } from 'zod';

import {
  AGENT_CONTEXT_BUILDER_VERSION,
  AGENT_CONTRACT_REVISION,
  AGENT_TOOLSET_DIGEST,
  agentEventProvenanceSchema,
  agentRequestHashSchema,
  agentVerdictSchema,
  comparableAgentVerdictSchema,
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
  terminalAgentActionRefSchema,
} from '../agent/contracts';
import {
  studentMemoryIndexV1Schema,
  studentMemoryNodeUpdateSchema,
  studentMemorySnapshotV1Schema,
} from '../agent/memory';
import { functionalRoleSchema } from '../config/schemas';

const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().trim().min(1);

const workflowIdentityShape = {
  caseId: identifierSchema,
  stageId: identifierSchema,
  attemptId: identifierSchema,
};

const sessionCommandNameSchema = z.enum([
  'choice',
  'extract',
  'equation',
  'tutor',
  'agent-turn',
  'agent-answer',
  'agent-case-start',
  'agent-case-answer',
]);

const sessionCommandMetadataSchema = z
  .object({
    commandName: sessionCommandNameSchema,
    idempotencyKey: identifierSchema,
    expectedSequence: z.number().int().nonnegative(),
    resultingSequence: z.number().int().positive(),
    requestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const eventBaseShape = {
  schemaVersion: z.literal('event.v2'),
  id: identifierSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  ...workflowIdentityShape,
  command: sessionCommandMetadataSchema.optional(),
};

export const answerPayloadSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('text'), value: z.string() }).strict(),
  z.object({ format: z.literal('choice'), optionId: identifierSchema }).strict(),
  z.object({ format: z.literal('equation'), value: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      format: z.literal('builder'),
      value: z
        .object({
          components: z.array(
            z
              .object({
                instanceId: identifierSchema,
                componentId: identifierSchema,
                x: z.number().finite(),
                y: z.number().finite(),
                label: z.string().optional(),
                assignedRole: functionalRoleSchema.optional(),
                materialBinding: z
                  .object({
                    materialId: identifierSchema,
                    specificity: z.enum(['generic', 'specific']),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          ),
          connections: z.array(
            z
              .object({
                id: identifierSchema.optional(),
                from: identifierSchema,
                to: identifierSchema,
                kind: z.enum(['electron-path', 'ion-path']),
                carrier: z.enum(['electron', 'cation', 'anion']).optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      format: z.literal('canvas'),
      value: z
        .object({
          dataUrl: z.string().startsWith('data:image/'),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
]);

export const agentAnswerSubmissionSchema = z
  .object({
    turnId: identifierSchema,
    answer: answerPayloadSchema,
  })
  .strict();

export const answerSubmittedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('answer.submitted'),
    pipelineStage: z.literal('answer'),
    questionId: identifierSchema,
    answer: answerPayloadSchema,
    responseToAgentTurnId: identifierSchema.optional(),
    responseContractId: identifierSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.responseToAgentTurnId === undefined) !== (event.responseContractId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: event.responseToAgentTurnId === undefined
          ? ['responseToAgentTurnId']
          : ['responseContractId'],
        message: 'agent response turn and response contract must be recorded together',
      });
    }
  });

const extractionProvenanceSchema = z
  .object({
    promptId: identifierSchema,
    promptVersion: identifierSchema,
    cacheKey: identifierSchema,
  })
  .strict();

const evidenceSchema = z
  .object({
    quote: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((evidence) => evidence.end >= evidence.start, {
    path: ['end'],
    message: 'evidence end cannot precede start',
  });

const assistanceMetadataSchema = z
  .object({
    kind: z.enum(['none', 'hint', 'socratic']),
    rounds: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'none' && value.rounds !== 0) {
      context.addIssue({ code: 'custom', path: ['rounds'], message: 'unassisted assessment requires zero rounds' });
    }
    if (value.kind !== 'none' && value.rounds === 0) {
      context.addIssue({ code: 'custom', path: ['rounds'], message: 'assisted assessment requires at least one round' });
    }
  });

const assessedExtractionSchema = z
  .object({
    status: z.literal('assessed'),
    evidence: z.array(evidenceSchema),
    model: identifierSchema,
    provenance: extractionProvenanceSchema,
    judgment: z
      .object({
        confidence: z.number().min(0).max(1),
        voteCount: z.literal(3),
        agreeingVotes: z.union([z.literal(2), z.literal(3)]),
        scopeVersion: identifierSchema,
        rationale: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const needsReviewExtractionSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
    model: identifierSchema,
    provenance: extractionProvenanceSchema,
  })
  .strict();

const unassessedExtractionSchema = z
  .object({
    status: z.literal('unassessed'),
    reason: z.string().trim().min(1),
    model: identifierSchema.optional(),
    provenance: extractionProvenanceSchema,
  })
  .strict();

const assessedRuleDecisionSchema = z
  .object({
    status: z.enum(['hit', 'hit-with-help', 'partial', 'miss']),
    ruleId: identifierSchema,
    reason: z.string().trim().min(1),
    engine: z
      .object({
        id: identifierSchema,
        version: identifierSchema,
        sourceRuleId: identifierSchema.optional(),
      })
      .strict()
      .default({ id: 'legacy-rule', version: 'legacy.v1' }),
  })
  .strict();

const needsReviewRuleDecisionSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
  })
  .strict();

const unassessedRuleDecisionSchema = z
  .object({
    status: z.literal('unassessed'),
    reason: z.string().trim().min(1),
  })
  .strict();

const unansweredRuleDecisionSchema = z
  .object({
    status: z.literal('unanswered'),
    reason: z.string().trim().min(1),
    promptRetry: z.boolean(),
    includeInDiagnosis: z.boolean(),
  })
  .strict();

const assessedFollowingSchema = z
  .object({
    status: z.enum(['followed', 'not-followed']),
    anchorNodeId: identifierSchema.nullable(),
    anchorOutcome: z.enum(['hit', 'partial', 'miss']).nullable().default(null),
    policy: z
      .enum(['score-logical-chain', 'score-objective-fact'])
      .default('score-logical-chain'),
  })
  .strict();

const needsReviewFollowingSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
  })
  .strict();

const unassessedFollowingSchema = z.object({ status: z.literal('unassessed') }).strict();

const scoredSchema = z
  .object({
    status: z.literal('scored'),
    earned: z.number().nonnegative(),
    possible: z.number().positive(),
    annotations: z.array(z.enum(['following', 'hit-with-help'])).default([]),
    outcome: z.enum(['hit', 'hit-with-help', 'partial', 'miss']).optional(),
  })
  .strict()
  .refine((score) => score.earned <= score.possible, {
    message: 'earned score cannot exceed possible score',
    path: ['earned'],
  });

const needsReviewScoreSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
  })
  .strict();

const unassessedScoreSchema = z.object({ status: z.literal('unassessed') }).strict();
const unansweredScoreSchema = z
  .object({
    status: z.literal('unanswered'),
    promptRetry: z.boolean(),
    includeInDiagnosis: z.boolean(),
  })
  .strict();

const assessmentPipelineStageSchema = z.enum(['extraction', 'rule', 'following', 'score']);

export const assessmentCompletedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('assessment.completed'),
    pipelineStage: assessmentPipelineStageSchema,
    sourceAnswerEventId: identifierSchema,
    nodeId: identifierSchema,
    misconceptionIds: z.array(identifierSchema).optional(),
    rubric: z.object({ id: identifierSchema, version: identifierSchema }).strict(),
    assistance: assistanceMetadataSchema.default({ kind: 'none', rounds: 0 }),
    objectiveOutcome: z.enum(['hit', 'partial', 'miss']).optional(),
    extraction: z.union([
      assessedExtractionSchema,
      needsReviewExtractionSchema,
      unassessedExtractionSchema,
    ]),
    ruleDecision: z.union([
      assessedRuleDecisionSchema,
      needsReviewRuleDecisionSchema,
      unassessedRuleDecisionSchema,
      unansweredRuleDecisionSchema,
    ]),
    following: z.union([
      assessedFollowingSchema,
      needsReviewFollowingSchema,
      unassessedFollowingSchema,
    ]),
    score: z.union([
      scoredSchema,
      needsReviewScoreSchema,
      unassessedScoreSchema,
      unansweredScoreSchema,
    ]),
  })
  .strict()
  .superRefine((event, context) => {
    const issue = (field: 'extraction' | 'ruleDecision' | 'following' | 'score', message: string) => {
      context.addIssue({ code: 'custom', path: [field, 'status'], message });
    };
    const extractionAssessed = event.extraction.status === 'assessed';
    const ruleAssessed = ['hit', 'hit-with-help', 'partial', 'miss', 'unanswered']
      .includes(event.ruleDecision.status);
    const followingAssessed = ['followed', 'not-followed'].includes(event.following.status);

    if (event.pipelineStage === 'extraction') {
      if (event.ruleDecision.status !== 'unassessed') issue('ruleDecision', 'must remain unassessed at extraction stage');
      if (event.following.status !== 'unassessed') issue('following', 'must remain unassessed at extraction stage');
      if (event.score.status !== 'unassessed') issue('score', 'must remain unassessed at extraction stage');
      return;
    }

    if (!extractionAssessed) {
      issue('extraction', `must be assessed before ${event.pipelineStage} stage`);
    }

    if (event.pipelineStage === 'rule') {
      if (event.ruleDecision.status === 'unassessed') issue('ruleDecision', 'must be decided or need review at rule stage');
      if (event.following.status !== 'unassessed') issue('following', 'must remain unassessed at rule stage');
      if (event.score.status !== 'unassessed') issue('score', 'must remain unassessed at rule stage');
      return;
    }

    if (!ruleAssessed) {
      issue('ruleDecision', `must be assessed before ${event.pipelineStage} stage`);
    }

    if (event.pipelineStage === 'following') {
      if (event.following.status === 'unassessed') issue('following', 'must be decided or need review at following stage');
      if (event.score.status !== 'unassessed') issue('score', 'must remain unassessed at following stage');
      return;
    }

    if (!followingAssessed) issue('following', 'must be assessed before score stage');
    if (event.score.status === 'unassessed') issue('score', 'must be scored or need review at score stage');
    if (event.score.status === 'scored' && followingAssessed) {
      const hasFollowingAnnotation = event.score.annotations.includes('following');
      if (event.following.status === 'followed') {
        if (event.following.anchorNodeId === null || event.following.anchorOutcome === null) {
          issue('following', 'followed status requires an anchor and anchor outcome');
        }
        if (!hasFollowingAnnotation) issue('score', 'followed status requires following annotation');
      } else if (hasFollowingAnnotation) {
        issue('score', 'following annotation requires followed status');
      }
      if (
        event.score.annotations.includes('hit-with-help')
        && !['hit', 'hit-with-help'].includes(event.ruleDecision.status)
      ) {
        issue('score', 'hit-with-help annotation requires a hit rule decision');
      }
    }
  });

const directAuditVerdictSchema = z.enum([
  'hit',
  'partial',
  'miss',
  'unanswered',
  'needs-review',
]);

export const assessmentAuditCompletedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('assessment.audit.completed'),
    pipelineStage: z.literal('audit'),
    sourceAnswerEventId: identifierSchema,
    questionId: identifierSchema,
    nodeId: identifierSchema,
    verdict: directAuditVerdictSchema,
    misconceptionIds: z.array(identifierSchema).optional(),
    rationale: z.string().trim().min(1),
    evidence: z.array(evidenceSchema),
    engine: z
      .object({
        id: identifierSchema,
        version: identifierSchema,
      })
      .strict(),
    provenance: z
      .object({
        promptId: identifierSchema,
        promptVersion: identifierSchema,
        cacheKey: identifierSchema,
        model: identifierSchema,
      })
      .strict(),
  })
  .strict();

const comparableDirectAuditVerdictSchema = z.enum(['hit', 'partial', 'miss']);

export const assessmentDivergenceChangedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('assessment.divergence.changed'),
    pipelineStage: z.literal('audit'),
    sourceAnswerEventId: identifierSchema,
    nodeId: identifierSchema,
    primaryAssessmentEventId: identifierSchema,
    auditEventId: identifierSchema,
    primaryVerdict: comparableDirectAuditVerdictSchema,
    auditVerdict: comparableDirectAuditVerdictSchema,
    status: z.enum(['detected', 'matched']),
    comparisonPolicyVersion: identifierSchema,
  })
  .strict();

export const polarityAssessedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('polarity.assessed'),
    pipelineStage: z.literal('rule'),
    sourceAnswerEventId: identifierSchema,
    anchorId: identifierSchema,
    facts: z.array(z.object({
      id: identifierSchema,
      value: z.string().trim().min(1),
      evidence: evidenceSchema.optional(),
    }).strict()).min(1),
    extractedValue: z.string().trim().min(1),
    correctValue: z.string().trim().min(1),
    outcome: z.enum(['hit', 'miss']),
    evidence: z.array(evidenceSchema).min(1),
    engine: z.object({ id: identifierSchema, version: identifierSchema }).strict(),
  })
  .strict();

export const polarityRevealedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('polarity.revealed'),
    pipelineStage: z.literal('reveal'),
    sourcePolarityAssessmentEventId: identifierSchema,
    anchorId: identifierSchema,
    values: z
      .object({
        negative: z.string().trim().min(1),
        positive: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export const sessionCommandExecutedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('session.command.executed'),
    pipelineStage: z.literal('command'),
    commandName: sessionCommandNameSchema,
    idempotencyKey: identifierSchema,
    expectedSequence: z.number().int().nonnegative(),
    resultingSequence: z.number().int().positive(),
    requestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    resultEventIds: z.array(identifierSchema),
  })
  .strict();

const tutorEventIdentityShape = {
  ...eventBaseShape,
  pipelineStage: z.literal('tutor'),
  sourceAnswerEventId: identifierSchema,
  sourceAssessmentEventId: identifierSchema,
  nodeId: identifierSchema,
  cycleId: identifierSchema,
};

export const tutorCycleStartedEventSchema = z
  .object({
    ...tutorEventIdentityShape,
    kind: z.literal('tutor.cycle.started'),
  })
  .strict();

export const tutorTurnCompletedEventSchema = z
  .object({
    ...tutorEventIdentityShape,
    kind: z.literal('tutor.turn.completed'),
    studentAnswer: z.string(),
    turn: z
      .object({
        action: z.enum(['probe', 'hint', 'check']),
        content: z.string().trim().min(1),
      })
      .strict(),
    source: z.enum(['provider', 'development-cache', 'demo-recording', 'preset']),
    degraded: z.boolean(),
    activeElapsedMs: z.number().int().nonnegative(),
  })
  .strict();

export const tutorCycleTerminalEventSchema = z
  .object({
    ...tutorEventIdentityShape,
    kind: z.literal('tutor.cycle.terminal'),
    reason: z.enum(['max-rounds', 'deadline']),
    content: z.string().trim().min(1),
    activeElapsedMs: z.number().int().nonnegative(),
  })
  .strict();

const agentEventIdentityShape = {
  ...eventBaseShape,
  pipelineStage: z.literal('agent'),
};

export const agentTurnCompletedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.turn.completed'),
    turnId: identifierSchema,
    triggerEventId: identifierSchema,
    contextThroughSequence: z.number().int().nonnegative(),
    requestHash: agentRequestHashSchema,
    source: z.enum(['provider', 'development-cache', 'demo-recording', 'fallback']),
    model: identifierSchema,
    failureCategory: identifierSchema.optional(),
    providerAttempts: z.number().int().nonnegative().max(3).optional(),
    orderedActions: z.array(normalizedAgentActionSchema).min(1).max(8),
    terminalAction: terminalAgentActionRefSchema,
    provenance: agentEventProvenanceSchema,
    caseRunId: identifierSchema.optional(),
    sdkSessionId: z.string().uuid().optional(),
    questionRunId: identifierSchema.optional(),
    objectiveId: identifierSchema.optional(),
    compacted: z.boolean().optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const seenCallIds = new Set<string>();
    const terminalActions = event.orderedActions.filter((action) =>
      terminalAgentActionNameSchema.safeParse(action.name).success);
    const continuationActions = event.orderedActions.length - terminalActions.length;
    const judgedNodeIds = new Set<string>();

    event.orderedActions.forEach((action, index) => {
      if (seenCallIds.has(action.callId)) {
        context.addIssue({
          code: 'custom',
          path: ['orderedActions', index, 'callId'],
          message: `duplicate tool call id ${action.callId}`,
        });
      }
      seenCallIds.add(action.callId);
      if (action.name === 'conclude_node') {
        if (judgedNodeIds.has(action.arguments.nodeId)) {
          context.addIssue({
            code: 'custom',
            path: ['orderedActions', index, 'arguments', 'nodeId'],
            message: 'a node can be judged at most once per turn',
          });
        }
        judgedNodeIds.add(action.arguments.nodeId);
      }
    });

    if (continuationActions > 6) {
      context.addIssue({
        code: 'custom',
        path: ['orderedActions'],
        message: 'a turn can contain at most 6 continuation actions',
      });
    }
    if (terminalActions.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['terminalAction'],
        message: 'a completed agent turn requires exactly one terminal action',
      });
      return;
    }
    const terminal = terminalActions[0];
    const last = event.orderedActions.at(-1);
    if (
      terminal.callId !== event.terminalAction.callId
      || terminal.name !== event.terminalAction.name
    ) {
      context.addIssue({
        code: 'custom',
        path: ['terminalAction'],
        message: 'terminalAction must identify the terminal action in orderedActions',
      });
    }
    if (last?.callId !== terminal.callId) {
      context.addIssue({
        code: 'custom',
        path: ['orderedActions'],
        message: 'the terminal action must be the final ordered action',
      });
    }
    if (event.failureCategory && event.source !== 'fallback') {
      context.addIssue({
        code: 'custom',
        path: ['failureCategory'],
        message: 'failureCategory is only valid for a fallback agent turn',
      });
    }
  });

export const agentCaseStartedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.case.started'),
    caseRunId: identifierSchema,
    sdkSessionId: z.string().uuid(),
    initialSnapshotId: identifierSchema,
    objectiveIds: z.array(identifierSchema).min(1),
  })
  .strict();

export const agentQuestionStartedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.question.started'),
    caseRunId: identifierSchema,
    questionRunId: identifierSchema,
    objectiveId: identifierSchema,
  })
  .strict();

export const agentUnderstandingUpdatedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.understanding.updated'),
    caseRunId: identifierSchema,
    questionRunId: identifierSchema,
    objectiveId: identifierSchema,
    sourceAnswerEventId: identifierSchema,
    updates: z.array(studentMemoryNodeUpdateSchema).min(1),
  })
  .strict();

export const agentMemoryRecalledEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.memory.recalled'),
    caseRunId: identifierSchema,
    snapshotId: identifierSchema,
    topicKind: z.enum(['index', 'node', 'dimension', 'evidence']),
    topicKey: identifierSchema.optional(),
  })
  .strict();

export const agentQuestionResolvedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.question.resolved'),
    caseRunId: identifierSchema,
    questionRunId: identifierSchema,
    objectiveId: identifierSchema,
    summary: z.string().trim().min(1),
    snapshotId: identifierSchema,
  })
  .strict();

export const agentMemorySnapshotCommittedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.memory.snapshot.committed'),
    caseRunId: identifierSchema,
    questionRunId: identifierSchema.optional(),
    objectiveId: identifierSchema.optional(),
    snapshot: studentMemorySnapshotV1Schema,
    index: studentMemoryIndexV1Schema,
  })
  .strict();

export const agentCaseCompletedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.case.completed'),
    caseRunId: identifierSchema,
    sdkSessionId: z.string().uuid(),
    summary: z.string().trim().min(1),
    finalSnapshotId: identifierSchema,
  })
  .strict();

export const agentAnchorRevealedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.anchor.revealed'),
    caseRunId: identifierSchema,
    objectiveId: identifierSchema,
    anchorId: identifierSchema,
    values: z
      .object({
        negative: z.string().trim().min(1),
        positive: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export const agentInputPendingEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.input.pending'),
    caseRunId: identifierSchema,
    sdkSessionId: z.string().uuid(),
    pendingInputId: identifierSchema,
    turnId: identifierSchema,
    triggerEventId: identifierSchema,
    payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const agentContextCompactedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.context.compacted'),
    caseRunId: identifierSchema,
    sdkSessionId: z.string().uuid(),
    trigger: z.enum(['auto', 'manual']),
    preTokens: z.number().int().nonnegative(),
  })
  .strict();

export const agentJudgmentRecordedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.judgment.recorded'),
    turnId: identifierSchema,
    nodeId: identifierSchema,
    verdict: agentVerdictSchema,
    rationale: z.string().trim().min(1),
    basisThroughSequence: z.number().int().nonnegative(),
    basisEventIds: z.array(identifierSchema).min(1),
    supersedesEventId: identifierSchema.optional(),
    provenance: agentEventProvenanceSchema,
  })
  .strict()
  .superRefine((event, context) => {
    const seen = new Set<string>();
    event.basisEventIds.forEach((eventId, index) => {
      if (seen.has(eventId)) {
        context.addIssue({
          code: 'custom',
          path: ['basisEventIds', index],
          message: `duplicate basis event id ${eventId}`,
        });
      }
      seen.add(eventId);
    });
  });

export const agentDivergenceChangedEventSchema = z
  .object({
    ...agentEventIdentityShape,
    kind: z.literal('agent.divergence.changed'),
    judgmentEventId: identifierSchema,
    shadowAssessmentEventId: identifierSchema,
    agentVerdict: comparableAgentVerdictSchema,
    shadowVerdict: comparableAgentVerdictSchema,
    status: z.enum(['detected', 'resolved']),
    comparisonPolicyVersion: identifierSchema,
  })
  .strict();

export const sessionEventSchema = z.union([
  answerSubmittedEventSchema,
  polarityAssessedEventSchema,
  polarityRevealedEventSchema,
  sessionCommandExecutedEventSchema,
  assessmentCompletedEventSchema,
  assessmentAuditCompletedEventSchema,
  assessmentDivergenceChangedEventSchema,
  tutorCycleStartedEventSchema,
  tutorTurnCompletedEventSchema,
  tutorCycleTerminalEventSchema,
  agentCaseStartedEventSchema,
  agentQuestionStartedEventSchema,
  agentUnderstandingUpdatedEventSchema,
  agentMemoryRecalledEventSchema,
  agentQuestionResolvedEventSchema,
  agentMemorySnapshotCommittedEventSchema,
  agentCaseCompletedEventSchema,
  agentAnchorRevealedEventSchema,
  agentInputPendingEventSchema,
  agentContextCompactedEventSchema,
  agentTurnCompletedEventSchema,
  agentJudgmentRecordedEventSchema,
  agentDivergenceChangedEventSchema,
]);

const pipelineStageOrder = {
  extraction: 1,
  rule: 2,
  following: 3,
  score: 4,
} as const;

export const sessionSchema = z
  .object({
    schemaVersion: z.literal('session.v2'),
    // 契约标记记录会话产生时的版本;不用 z.literal 钉死——否则任何一次
    // 工具集/契约演进都会让全部已存会话 parse 失败(restoreLatest 会直接
    // 删档)。回放/agent loop 的版本一致性由各自运行时显式校验。
    agentContractRevision: z
      .string()
      .trim()
      .min(1)
      .default(AGENT_CONTRACT_REVISION),
    toolsetDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{16,64}$/)
      .default(AGENT_TOOLSET_DIGEST),
    contextBuilderVersion: z
      .string()
      .trim()
      .min(1)
      .default(AGENT_CONTEXT_BUILDER_VERSION),
    id: identifierSchema,
    anonymousStudentId: z.string().regex(/^anon-[A-Z0-9]{8,}$/),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    serverSequence: z.number().int().nonnegative().optional(),
    configVersions: z
      .object({
        configDigest: identifierSchema,
        knowledgeModel: identifierSchema,
        rubrics: identifierSchema,
        pretest: identifierSchema,
        scaffoldPolicy: identifierSchema,
        cases: z.record(identifierSchema, identifierSchema),
        grammar: identifierSchema,
        engines: z
          .object({
            rubric: identifierSchema,
            topology: identifierSchema,
            equation: identifierSchema,
          })
          .strict(),
      })
      .strict(),
    events: z.array(sessionEventSchema),
  })
  .strict()
  .superRefine((session, context) => {
    const eventIds = new Set<string>();
    const eventsById = new Map<string, z.infer<typeof sessionEventSchema>>();
    const answers = new Map<string, z.infer<typeof answerSubmittedEventSchema>>();
    const assessments = new Map<string, z.infer<typeof assessmentCompletedEventSchema>>();
    const auditAssessments = new Map<
      string,
      z.infer<typeof assessmentAuditCompletedEventSchema>
    >();
    const auditKeys = new Set<string>();
    const polarityAssessments = new Map<string, z.infer<typeof polarityAssessedEventSchema>>();
    const agentTurns = new Map<string, z.infer<typeof agentTurnCompletedEventSchema>>();
    const judgments = new Map<string, z.infer<typeof agentJudgmentRecordedEventSchema>>();
    const judgmentKeys = new Set<string>();
    const answerWorkflows = new Set<string>();
    const commandKeys = new Set<string>();
    const progress = new Map<string, number>();
    const tutorCycles = new Map<string, {
      sourceAssessmentEventId: string;
      nodeId: string;
      terminal: boolean;
    }>();

    session.events.forEach((event, index) => {
      if (event.sequence !== index) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'sequence'],
          message: `expected sequence ${index}`,
        });
      }
      if (eventIds.has(event.id)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'id'],
          message: `duplicate event id ${event.id}`,
        });
      }
      eventIds.add(event.id);
      eventsById.set(event.id, event);

      if (event.command) {
        if (commandKeys.has(event.command.idempotencyKey)) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'command', 'idempotencyKey'],
            message: 'a command idempotency key can be recorded only once',
          });
        }
        commandKeys.add(event.command.idempotencyKey);
        if (
          event.command.resultingSequence
          <= event.command.expectedSequence
        ) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'command'],
            message: 'command resulting sequence must advance its expected sequence',
          });
        }
      }

      if (event.kind === 'answer.submitted') {
        if (event.responseToAgentTurnId && event.responseContractId) {
          const turn = agentTurns.get(event.responseToAgentTurnId);
          if (!turn) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'responseToAgentTurnId'],
              message: 'must reference an earlier completed agent turn',
            });
          } else {
            for (const field of ['caseId', 'stageId'] as const) {
              if (event[field] !== turn[field]) {
                context.addIssue({
                  code: 'custom',
                  path: ['events', index, field],
                  message: `must match response agent turn ${field}`,
                });
              }
            }
            const terminal = turn.orderedActions.find((action) =>
              action.callId === turn.terminalAction.callId);
            const terminalContractId = terminal
              && (
                terminal.name === 'ask_student'
                || terminal.name === 'present_question'
                || terminal.name === 'show_question_card'
              )
              ? terminal.arguments.responseContractId
              : undefined;
            if (terminalContractId !== event.responseContractId) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, 'responseContractId'],
                message: 'must match the response contract issued by the agent turn',
              });
            }
          }
        }
        const workflowKey = event.responseToAgentTurnId
          ? `agent-turn\u0000${event.responseToAgentTurnId}`
          : `${event.caseId}\u0000${event.stageId}\u0000${event.attemptId}`;
        if (answerWorkflows.has(workflowKey)) {
          context.addIssue({
            code: 'custom',
            path: [
              'events',
              index,
              event.responseToAgentTurnId ? 'responseToAgentTurnId' : 'attemptId',
            ],
            message: event.responseToAgentTurnId
              ? 'duplicate answer for agent turn'
              : 'duplicate answer for case, stage, and attempt',
          });
        }
        answerWorkflows.add(workflowKey);
        answers.set(event.id, event);
        return;
      }

      if (event.kind === 'agent.turn.completed') {
        const trigger = eventsById.get(event.triggerEventId);
        if (
          !trigger
          || trigger.sequence >= event.sequence
          || trigger.kind === 'agent.judgment.recorded'
          || trigger.kind === 'agent.divergence.changed'
          || trigger.kind === 'assessment.audit.completed'
          || trigger.kind === 'assessment.divergence.changed'
        ) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'triggerEventId'],
            message: 'must reference an earlier learner-visible trigger event',
          });
        } else if (event.contextThroughSequence < trigger.sequence) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'contextThroughSequence'],
            message: 'must include the trigger event',
          });
        }
        if (event.contextThroughSequence >= event.sequence) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'contextThroughSequence'],
            message: 'must precede the completed turn event',
          });
        }
        if (agentTurns.has(event.turnId)) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'turnId'],
            message: `duplicate agent turn id ${event.turnId}`,
          });
        }
        agentTurns.set(event.turnId, event);
        return;
      }

      if (
        event.kind === 'agent.case.started'
        || event.kind === 'agent.question.started'
        || event.kind === 'agent.understanding.updated'
        || event.kind === 'agent.memory.recalled'
        || event.kind === 'agent.question.resolved'
        || event.kind === 'agent.memory.snapshot.committed'
        || event.kind === 'agent.case.completed'
        || event.kind === 'agent.anchor.revealed'
        || event.kind === 'agent.input.pending'
        || event.kind === 'agent.context.compacted'
      ) {
        return;
      }

      if (event.kind === 'agent.judgment.recorded') {
        const turn = agentTurns.get(event.turnId);
        if (!turn) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'turnId'],
            message: 'must reference an earlier completed agent turn',
          });
        } else {
          for (const field of ['caseId', 'stageId', 'attemptId'] as const) {
            if (event[field] !== turn[field]) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, field],
                message: `must match source agent turn ${field}`,
              });
            }
          }
          const conclusion = turn.orderedActions.find(
            (
              action,
            ): action is Extract<
              (typeof turn.orderedActions)[number],
              { name: 'conclude_node' }
            > => action.name === 'conclude_node' && action.arguments.nodeId === event.nodeId,
          );
          if (
            !conclusion
            || conclusion.arguments.verdict !== event.verdict
            || conclusion.arguments.rationale !== event.rationale
          ) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'nodeId'],
              message: 'judgment must match the turn conclude_node action',
            });
          }
        }
        const judgmentKey = `${event.turnId}\u0000${event.nodeId}`;
        if (judgmentKeys.has(judgmentKey)) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'nodeId'],
            message: 'a turn can record at most one judgment per node',
          });
        }
        judgmentKeys.add(judgmentKey);
        if (event.basisThroughSequence >= event.sequence) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'basisThroughSequence'],
            message: 'judgment basis must precede the judgment event',
          });
        }
        event.basisEventIds.forEach((basisEventId, basisIndex) => {
          const basis = eventsById.get(basisEventId);
          if (
            !basis
            || basis.sequence >= event.sequence
            || basis.sequence > event.basisThroughSequence
          ) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'basisEventIds', basisIndex],
              message: 'basis event must exist at or before basisThroughSequence',
            });
          }
        });
        if (event.supersedesEventId) {
          const superseded = judgments.get(event.supersedesEventId);
          if (!superseded || superseded.nodeId !== event.nodeId) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'supersedesEventId'],
              message: 'must reference an earlier judgment for the same node',
            });
          }
        }
        judgments.set(event.id, event);
        return;
      }

      if (event.kind === 'agent.divergence.changed') {
        const judgment = judgments.get(event.judgmentEventId);
        if (!judgment) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'judgmentEventId'],
            message: 'must reference an earlier agent judgment',
          });
        } else {
          if (judgment.verdict === 'inconclusive' || judgment.verdict !== event.agentVerdict) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'agentVerdict'],
              message: 'must match a comparable judgment verdict',
            });
          }
        }
        const shadow = assessments.get(event.shadowAssessmentEventId);
        if (!shadow) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'shadowAssessmentEventId'],
            message: 'must reference an earlier shadow assessment',
          });
        } else {
          const basisSelected = judgment
            ? [...assessments.values()].filter((candidate) =>
                candidate.nodeId === judgment.nodeId
                && candidate.sequence <= judgment.basisThroughSequence)
              .at(-1)
            : undefined;
          if (!basisSelected || basisSelected.id !== shadow.id) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'shadowAssessmentEventId'],
              message:
                'shadow assessment must be the basis-selected latest attempt',
            });
          }
          if (judgment && (
            shadow.nodeId !== judgment.nodeId
            || shadow.sequence > judgment.basisThroughSequence
          )) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'shadowAssessmentEventId'],
              message: 'shadow assessment must cover the judgment node within its basis',
            });
          }
          const outcome = shadow.score.status === 'scored'
            ? shadow.score.outcome ?? shadow.ruleDecision.status
            : null;
          const comparableOutcome = outcome === 'hit-with-help' ? 'hit' : outcome;
          if (
            comparableOutcome !== 'hit'
            && comparableOutcome !== 'partial'
            && comparableOutcome !== 'miss'
          ) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'shadowAssessmentEventId'],
              message: 'shadow assessment must have a comparable scored verdict',
            });
          } else if (comparableOutcome !== event.shadowVerdict) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'shadowVerdict'],
              message: 'must match the normalized shadow assessment verdict',
            });
          }
        }
        const differs = event.agentVerdict !== event.shadowVerdict;
        if (
          (event.status === 'detected' && !differs)
          || (event.status === 'resolved' && differs)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'status'],
            message: 'divergence status must match whether the verdicts differ',
          });
        }
        return;
      }

      if (event.kind === 'assessment.audit.completed') {
        const answer = answers.get(event.sourceAnswerEventId);
        if (!answer) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'sourceAnswerEventId'],
            message: 'must reference an earlier answer event',
          });
        } else {
          for (const field of ['caseId', 'stageId', 'attemptId'] as const) {
            if (event[field] !== answer[field]) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, field],
                message: `must match source answer ${field}`,
              });
            }
          }
          if (event.questionId !== answer.questionId) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'questionId'],
              message: 'must match the source answer question',
            });
          }
          const original = answer.answer.format === 'text' || answer.answer.format === 'equation'
            ? answer.answer.value
            : answer.answer.format === 'choice'
              ? answer.answer.optionId
              : JSON.stringify(answer.answer.value);
          event.evidence.forEach((evidence, evidenceIndex) => {
            if (
              evidence.end > original.length
              || original.slice(evidence.start, evidence.end) !== evidence.quote
            ) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, 'evidence', evidenceIndex],
                message: 'evidence must exactly quote the source answer',
              });
            }
          });
        }
        const auditKey = `${event.sourceAnswerEventId}\u0000${event.nodeId}`;
        if (auditKeys.has(auditKey)) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'nodeId'],
            message: 'an answer can have only one audit assessment per node',
          });
        }
        auditKeys.add(auditKey);
        auditAssessments.set(event.id, event);
        return;
      }

      if (event.kind === 'assessment.divergence.changed') {
        const answer = answers.get(event.sourceAnswerEventId);
        const primary = assessments.get(event.primaryAssessmentEventId);
        const audit = auditAssessments.get(event.auditEventId);
        if (!answer) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'sourceAnswerEventId'],
            message: 'must reference an earlier answer event',
          });
        }
        if (
          !primary
          || primary.sourceAnswerEventId !== event.sourceAnswerEventId
          || primary.nodeId !== event.nodeId
        ) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'primaryAssessmentEventId'],
            message: 'must reference the primary assessment for this answer and node',
          });
        } else {
          const primaryOutcome = primary.score.status === 'scored'
            ? primary.score.outcome ?? primary.ruleDecision.status
            : null;
          const normalized = primaryOutcome === 'hit-with-help' ? 'hit' : primaryOutcome;
          if (normalized !== event.primaryVerdict) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'primaryVerdict'],
              message: 'must match the normalized primary verdict',
            });
          }
        }
        if (
          !audit
          || audit.sourceAnswerEventId !== event.sourceAnswerEventId
          || audit.nodeId !== event.nodeId
          || audit.verdict !== event.auditVerdict
        ) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'auditEventId'],
            message: 'must reference the comparable audit assessment for this answer and node',
          });
        }
        const differs = event.primaryVerdict !== event.auditVerdict;
        if (
          (event.status === 'detected' && !differs)
          || (event.status === 'matched' && differs)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'status'],
            message: 'divergence status must match whether the verdicts differ',
          });
        }
        return;
      }

      if (event.kind === 'polarity.revealed') {
        const source = polarityAssessments.get(event.sourcePolarityAssessmentEventId);
        if (!source) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'sourcePolarityAssessmentEventId'],
            message: 'must reference an earlier polarity assessment',
          });
        } else {
          for (const field of ['caseId', 'stageId', 'attemptId', 'anchorId'] as const) {
            if (event[field] !== source[field]) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, field],
                message: `must match source polarity assessment ${field}`,
              });
            }
          }
          if (source.outcome !== 'hit') {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'sourcePolarityAssessmentEventId'],
              message: 'polarity can only be revealed after a hit',
            });
          }
          const configured = new Map(source.correctValue.split(';').map((entry) => {
            const separator = entry.indexOf('=');
            return [
              entry.slice(0, separator).trim(),
              entry.slice(separator + 1).trim(),
            ];
          }));
          if (
            event.values.negative !== configured.get('negative')
            || event.values.positive !== configured.get('positive')
          ) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'values'],
              message: 'revealed polarity must match the server assessment',
            });
          }
        }
        return;
      }

      if (event.kind === 'session.command.executed') {
        if (commandKeys.has(event.idempotencyKey)) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'idempotencyKey'],
            message: 'a command idempotency key can be recorded only once',
          });
        }
        commandKeys.add(event.idempotencyKey);
        if (event.resultingSequence <= event.expectedSequence) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'resultingSequence'],
            message: 'command marker must advance its expected sequence',
          });
        }
        event.resultEventIds.forEach((eventId, eventIdIndex) => {
          const resultEvent = eventsById.get(eventId);
          if (!resultEvent || resultEvent.sequence >= event.sequence) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'resultEventIds', eventIdIndex],
              message: 'command result event must exist before its marker',
            });
          }
        });
        return;
      }

      const answer = answers.get(event.sourceAnswerEventId);
      if (!answer) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'sourceAnswerEventId'],
          message: 'must reference an earlier answer event',
        });
      } else {
        for (const field of ['caseId', 'stageId', 'attemptId'] as const) {
          if (event[field] !== answer[field]) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, field],
              message: `must match source answer ${field}`,
            });
          }
        }
        if (event.kind === 'polarity.assessed') {
          const original = answer.answer.format === 'text' || answer.answer.format === 'equation'
            ? answer.answer.value
            : answer.answer.format === 'choice'
              ? answer.answer.optionId
              : JSON.stringify(answer.answer.value);
          event.evidence.forEach((evidence, evidenceIndex) => {
            if (
              evidence.end > original.length
              || original.slice(evidence.start, evidence.end) !== evidence.quote
            ) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, 'evidence', evidenceIndex],
                message: 'evidence must exactly quote the source answer',
              });
            }
          });
          event.facts.forEach((fact, factIndex) => {
            if (
              fact.evidence
              && (
                fact.evidence.end > original.length
                || original.slice(fact.evidence.start, fact.evidence.end) !== fact.evidence.quote
              )
            ) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, 'facts', factIndex, 'evidence'],
                message: 'fact evidence must exactly quote the source answer',
              });
            }
          });
        } else if (event.kind === 'assessment.completed' && event.extraction.status === 'assessed') {
          const original = answer.answer.format === 'text' || answer.answer.format === 'equation'
            ? answer.answer.value
            : answer.answer.format === 'choice'
              ? answer.answer.optionId
              : JSON.stringify(answer.answer.value);
          event.extraction.evidence.forEach((evidence, evidenceIndex) => {
            if (
              evidence.end > original.length
              || original.slice(evidence.start, evidence.end) !== evidence.quote
            ) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, 'extraction', 'evidence', evidenceIndex],
                message: 'evidence must exactly quote the source answer',
              });
            }
          });
        }
      }

      if (event.kind === 'polarity.assessed') {
        polarityAssessments.set(event.id, event);
        return;
      }
      if (
        event.kind === 'tutor.cycle.started'
        || event.kind === 'tutor.turn.completed'
        || event.kind === 'tutor.cycle.terminal'
      ) {
        const assessment = assessments.get(event.sourceAssessmentEventId);
        if (!assessment) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'sourceAssessmentEventId'],
            message: 'must reference an earlier assessment event',
          });
        } else {
          if (assessment.sourceAnswerEventId !== event.sourceAnswerEventId) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'sourceAnswerEventId'],
              message: 'must match the source assessment answer',
            });
          }
          if (assessment.nodeId !== event.nodeId) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'nodeId'],
              message: 'must match the source assessment node',
            });
          }
        }

        const cycle = tutorCycles.get(event.cycleId);
        if (event.kind === 'tutor.cycle.started') {
          if (cycle) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, 'cycleId'],
              message: 'tutor cycle has already started',
            });
          } else {
            tutorCycles.set(event.cycleId, {
              sourceAssessmentEventId: event.sourceAssessmentEventId,
              nodeId: event.nodeId,
              terminal: false,
            });
          }
          return;
        }

        if (!cycle) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'cycleId'],
            message: 'tutor turn or terminal event requires an earlier cycle start',
          });
          return;
        }
        if (
          cycle.sourceAssessmentEventId !== event.sourceAssessmentEventId
          || cycle.nodeId !== event.nodeId
        ) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'cycleId'],
            message: 'tutor event identity must match its cycle start',
          });
        }
        if (cycle.terminal) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'cycleId'],
            message: 'tutor cycle is already terminal',
          });
        }
        if (event.kind === 'tutor.cycle.terminal') cycle.terminal = true;
        return;
      }

      const progressKey =
        `${event.caseId}\u0000${event.stageId}\u0000${event.attemptId}\u0000${event.nodeId}`;
      const currentProgress = pipelineStageOrder[event.pipelineStage];
      const previousProgress = progress.get(progressKey);
      if (previousProgress !== undefined && currentProgress < previousProgress) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'pipelineStage'],
          message: 'assessment pipeline progress cannot move backward',
        });
      }
      progress.set(progressKey, Math.max(previousProgress ?? 0, currentProgress));
      assessments.set(event.id, event);
    });

    const caseStarts = new Map<string, z.infer<typeof agentCaseStartedEventSchema>>();
    const sdkSessions = new Map<string, string>();
    const questionStarts = new Map<string, z.infer<typeof agentQuestionStartedEventSchema>>();
    const resolvedByRun = new Map<string, Set<string>>();
    const completedCaseRuns = new Set<string>();
    const memoryBySnapshotId = new Map<
      string,
      z.infer<typeof agentMemorySnapshotCommittedEventSchema>
    >();
    const issue = (index: number, path: Array<string | number>, message: string) => {
      context.addIssue({
        code: 'custom',
        path: ['events', index, ...path],
        message,
      });
    };
    session.events.forEach((event, index) => {
      if (event.kind === 'agent.memory.snapshot.committed') {
        const snapshot = event.snapshot;
        const hasQuestionRunId = event.questionRunId !== undefined;
        const hasObjectiveId = event.objectiveId !== undefined;
        if (snapshot.studentId !== session.anonymousStudentId) {
          issue(index, ['snapshot', 'studentId'], 'student memory must belong to this session');
        }
        if (hasQuestionRunId !== hasObjectiveId) {
          issue(
            index,
            ['questionRunId'],
            'question-scoped memory commits require both questionRunId and objectiveId',
          );
        }
        if (event.questionRunId && event.objectiveId) {
          const start = caseStarts.get(event.caseRunId);
          const question = questionStarts.get(event.questionRunId);
          const resolution = session.events.slice(0, index).find((candidate) =>
            candidate.kind === 'agent.question.resolved'
            && candidate.caseRunId === event.caseRunId
            && candidate.questionRunId === event.questionRunId
            && candidate.objectiveId === event.objectiveId
            && candidate.snapshotId === snapshot.snapshotId);
          if (
            !start
            || start.caseId !== event.caseId
            || event.attemptId !== event.caseRunId
            || !question
            || question.caseRunId !== event.caseRunId
            || question.objectiveId !== event.objectiveId
          ) {
            issue(
              index,
              ['questionRunId'],
              'question-scoped memory commit must match its case and question',
            );
          }
          if (!resolution) {
            issue(
              index,
              ['snapshot', 'snapshotId'],
              'question-scoped memory commit requires its earlier resolution event',
            );
          }
          if (snapshot.sourceQuestionId !== event.questionRunId) {
            issue(
              index,
              ['snapshot', 'sourceQuestionId'],
              'question-scoped memory snapshot must identify its source question',
            );
          }
        }
        if (
          JSON.stringify(snapshot.configVersions)
          !== JSON.stringify(session.configVersions)
        ) {
          issue(index, ['snapshot', 'configVersions'], 'student memory must use session configuration');
        }
        if (
          event.index.snapshotId !== snapshot.snapshotId
          || event.index.sourceThroughSequence !== snapshot.sourceThroughSequence
        ) {
          issue(index, ['index'], 'student memory index must describe the committed snapshot');
        }
        if (
          snapshot.sourceThroughSequence >= event.sequence
          && !(
            snapshot.previousSnapshotId === null
            && event.sequence === 0
            && snapshot.sourceThroughSequence === 0
          )
        ) {
          issue(
            index,
            ['snapshot', 'sourceThroughSequence'],
            'student memory source boundary must precede its commit event',
          );
        }
        if (memoryBySnapshotId.has(snapshot.snapshotId)) {
          issue(index, ['snapshot', 'snapshotId'], 'duplicate student memory snapshot id');
        }
        if (snapshot.previousSnapshotId) {
          const previous = memoryBySnapshotId.get(snapshot.previousSnapshotId);
          if (!previous) {
            issue(
              index,
              ['snapshot', 'previousSnapshotId'],
              'previous student memory snapshot must be committed earlier',
            );
          } else if (
            JSON.stringify(previous.snapshot.pretestBaseline)
            !== JSON.stringify(snapshot.pretestBaseline)
          ) {
            issue(
              index,
              ['snapshot', 'pretestBaseline'],
              'pretest baseline is immutable across student memory snapshots',
            );
          }
        }
        memoryBySnapshotId.set(snapshot.snapshotId, event);
        return;
      }

      if (event.kind === 'agent.case.started') {
        if (caseStarts.has(event.caseRunId)) {
          issue(index, ['caseRunId'], 'duplicate Agent case run id');
        }
        const sdkOwner = sdkSessions.get(event.sdkSessionId);
        if (sdkOwner && sdkOwner !== event.caseRunId) {
          issue(index, ['sdkSessionId'], 'one SDK session can belong to only one case run');
        }
        const initial = memoryBySnapshotId.get(event.initialSnapshotId);
        if (!initial || initial.sequence >= event.sequence) {
          issue(
            index,
            ['initialSnapshotId'],
            'Agent case must start from an earlier committed student memory snapshot',
          );
        }
        caseStarts.set(event.caseRunId, event);
        sdkSessions.set(event.sdkSessionId, event.caseRunId);
        return;
      }

      if (
        event.kind === 'agent.question.started'
        || event.kind === 'agent.understanding.updated'
        || event.kind === 'agent.memory.recalled'
        || event.kind === 'agent.question.resolved'
        || event.kind === 'agent.case.completed'
        || event.kind === 'agent.anchor.revealed'
        || event.kind === 'agent.input.pending'
        || event.kind === 'agent.context.compacted'
        || (event.kind === 'agent.turn.completed' && event.caseRunId)
      ) {
        const caseRunId = event.caseRunId!;
        const start = caseStarts.get(caseRunId);
        if (!start || start.sequence >= event.sequence) {
          issue(index, ['caseRunId'], 'Agent event must reference an earlier case start');
          return;
        }
        if (event.caseId !== start.caseId || event.attemptId !== caseRunId) {
          issue(index, ['caseRunId'], 'Agent event identity must match its case run');
        }
        if (
          'sdkSessionId' in event
          && event.sdkSessionId !== start.sdkSessionId
        ) {
          issue(index, ['sdkSessionId'], 'Agent event SDK session must match its case run');
        }
        if (event.kind === 'agent.turn.completed' && !event.sdkSessionId) {
          issue(
            index,
            ['sdkSessionId'],
            'case Agent turn must persist the SDK session id',
          );
        }

        if (event.kind === 'agent.question.started') {
          if (!start.objectiveIds.includes(event.objectiveId)) {
            issue(index, ['objectiveId'], 'Agent question objective is outside the case pool');
          }
          if (questionStarts.has(event.questionRunId)) {
            issue(index, ['questionRunId'], 'duplicate Agent question run id');
          }
          questionStarts.set(event.questionRunId, event);
          return;
        }

        if (
          event.kind === 'agent.understanding.updated'
          || event.kind === 'agent.question.resolved'
        ) {
          const question = questionStarts.get(event.questionRunId);
          if (
            !question
            || question.sequence >= event.sequence
            || question.caseRunId !== event.caseRunId
            || question.objectiveId !== event.objectiveId
          ) {
            issue(
              index,
              ['questionRunId'],
              'Agent question event must match an earlier question start',
            );
          }
          if (event.kind === 'agent.understanding.updated') {
            const answer = answers.get(event.sourceAnswerEventId);
            if (!answer || answer.sequence >= event.sequence) {
              issue(
                index,
                ['sourceAnswerEventId'],
                'working understanding must reference an earlier student answer',
              );
            }
            event.updates.forEach((update, updateIndex) => {
              update.evidenceEventIds.forEach((eventId, evidenceIndex) => {
                const evidence = eventsById.get(eventId);
                if (!evidence || evidence.sequence >= event.sequence) {
                  issue(
                    index,
                    ['updates', updateIndex, 'evidenceEventIds', evidenceIndex],
                    'working understanding evidence must reference an earlier event',
                  );
                }
              });
            });
          } else {
            const resolved = resolvedByRun.get(event.caseRunId) ?? new Set<string>();
            if (resolved.has(event.objectiveId)) {
              issue(index, ['objectiveId'], 'an Agent objective can resolve only once per case');
            }
            resolved.add(event.objectiveId);
            resolvedByRun.set(event.caseRunId, resolved);
          }
          return;
        }

        if (event.kind === 'agent.memory.recalled') {
          const snapshot = memoryBySnapshotId.get(event.snapshotId);
          if (!snapshot || snapshot.sequence >= event.sequence) {
            issue(index, ['snapshotId'], 'memory recall must reference an earlier snapshot');
          }
          return;
        }

        if (event.kind === 'agent.input.pending') {
          const trigger = eventsById.get(event.triggerEventId);
          if (
            event.pendingInputId !== event.id
            || !trigger
            || trigger.sequence >= event.sequence
          ) {
            issue(
              index,
              ['triggerEventId'],
              'pending Agent input must identify itself and an earlier trigger',
            );
          }
          return;
        }

        if (event.kind === 'agent.anchor.revealed') {
          if (!resolvedByRun.get(event.caseRunId)?.has(event.objectiveId)) {
            issue(
              index,
              ['objectiveId'],
              'Agent anchor reveal requires an earlier resolved objective',
            );
          }
          return;
        }

        if (event.kind === 'agent.case.completed') {
          if (completedCaseRuns.has(event.caseRunId)) {
            issue(index, ['caseRunId'], 'Agent case run can complete only once');
          }
          completedCaseRuns.add(event.caseRunId);
          const finalSnapshot = memoryBySnapshotId.get(event.finalSnapshotId);
          if (!finalSnapshot || finalSnapshot.sequence >= event.sequence) {
            issue(
              index,
              ['finalSnapshotId'],
              'Agent case must end from an earlier committed student memory snapshot',
            );
          }
          const resolved = resolvedByRun.get(event.caseRunId) ?? new Set<string>();
          const missing = start.objectiveIds.filter((objectiveId) => !resolved.has(objectiveId));
          if (missing.length > 0) {
            issue(
              index,
              ['caseRunId'],
              `Agent case cannot end with unresolved objectives: ${missing.join(', ')}`,
            );
          }
        }
      }
    });
  });

export type AnswerSubmittedEvent = z.infer<typeof answerSubmittedEventSchema>;
export type AgentAnswerSubmission = z.infer<typeof agentAnswerSubmissionSchema>;
export type AssessmentCompletedEvent = z.infer<typeof assessmentCompletedEventSchema>;
export type AssessmentAuditCompletedEvent = z.infer<typeof assessmentAuditCompletedEventSchema>;
export type AssessmentDivergenceChangedEvent = z.infer<
  typeof assessmentDivergenceChangedEventSchema
>;
export type PolarityAssessedEvent = z.infer<typeof polarityAssessedEventSchema>;
export type PolarityRevealedEvent = z.infer<typeof polarityRevealedEventSchema>;
export type SessionCommandExecutedEvent = z.infer<typeof sessionCommandExecutedEventSchema>;
export type TutorCycleStartedEvent = z.infer<typeof tutorCycleStartedEventSchema>;
export type TutorTurnCompletedEvent = z.infer<typeof tutorTurnCompletedEventSchema>;
export type TutorCycleTerminalEvent = z.infer<typeof tutorCycleTerminalEventSchema>;
export type AgentTurnCompletedEvent = z.infer<typeof agentTurnCompletedEventSchema>;
export type AgentCaseStartedEvent = z.infer<typeof agentCaseStartedEventSchema>;
export type AgentQuestionStartedEvent = z.infer<typeof agentQuestionStartedEventSchema>;
export type AgentUnderstandingUpdatedEvent = z.infer<typeof agentUnderstandingUpdatedEventSchema>;
export type AgentMemoryRecalledEvent = z.infer<typeof agentMemoryRecalledEventSchema>;
export type AgentQuestionResolvedEvent = z.infer<typeof agentQuestionResolvedEventSchema>;
export type AgentMemorySnapshotCommittedEvent = z.infer<
  typeof agentMemorySnapshotCommittedEventSchema
>;
export type AgentCaseCompletedEvent = z.infer<typeof agentCaseCompletedEventSchema>;
export type AgentAnchorRevealedEvent = z.infer<typeof agentAnchorRevealedEventSchema>;
export type AgentInputPendingEvent = z.infer<typeof agentInputPendingEventSchema>;
export type AgentContextCompactedEvent = z.infer<typeof agentContextCompactedEventSchema>;
export type AgentJudgmentRecordedEvent = z.infer<typeof agentJudgmentRecordedEventSchema>;
export type AgentDivergenceChangedEvent = z.infer<typeof agentDivergenceChangedEventSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type StudentSession = z.infer<typeof sessionSchema>;

type EventManagedFields = 'schemaVersion' | 'sequence';
export type SessionEventInput =
  | Omit<z.input<typeof answerSubmittedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof polarityAssessedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof polarityRevealedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof sessionCommandExecutedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof assessmentCompletedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof assessmentAuditCompletedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof assessmentDivergenceChangedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof tutorCycleStartedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof tutorTurnCompletedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof tutorCycleTerminalEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentCaseStartedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentQuestionStartedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentUnderstandingUpdatedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentMemoryRecalledEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentQuestionResolvedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentMemorySnapshotCommittedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentCaseCompletedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentAnchorRevealedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentInputPendingEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentContextCompactedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentTurnCompletedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentJudgmentRecordedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof agentDivergenceChangedEventSchema>, EventManagedFields>;
