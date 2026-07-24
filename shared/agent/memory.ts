import { z } from 'zod';

const identifier = z.string().trim().min(1);

export const studentUnderstandingStateSchema = z.enum([
  'mastered',
  'developing',
  'not-yet',
  'uncertain',
  'unseen',
]);

export const studentMemoryNodeSchema = z
  .object({
    nodeId: identifier,
    state: studentUnderstandingStateSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    misconceptionIds: z.array(identifier),
    evidenceEventIds: z.array(identifier),
    updatedAt: z.string().datetime({ offset: true }),
    sourceQuestionId: identifier.nullable(),
  })
  .strict();

export const studentMemoryBaselineSchema = z
  .object({
    source: z.literal('pretest'),
    capturedThroughSequence: z.number().int().nonnegative().nullable(),
    nodes: z.array(studentMemoryNodeSchema),
  })
  .strict();

export const formalAssessmentMemorySchema = z
  .object({
    nodeId: identifier,
    assessmentEventId: identifier,
    verdict: z.enum(['hit', 'partial', 'miss', 'needs-review', 'unassessed']),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const studentMemoryDivergenceSchema = z
  .object({
    nodeId: identifier,
    agentState: studentUnderstandingStateSchema,
    formalVerdict: z.enum(['hit', 'partial', 'miss', 'needs-review', 'unassessed']),
    status: z.enum(['detected', 'matched']),
  })
  .strict();

export const studentMemorySnapshotV1Schema = z
  .object({
    version: z.literal('student-memory-snapshot.v1'),
    snapshotId: identifier,
    studentId: identifier,
    previousSnapshotId: identifier.nullable(),
    sourceQuestionId: identifier.nullable(),
    sourceThroughSequence: z.number().int().nonnegative(),
    occurredAt: z.string().datetime({ offset: true }),
    configVersions: z
      .object({
        configDigest: identifier,
        knowledgeModel: identifier,
        rubrics: identifier,
        pretest: identifier,
        scaffoldPolicy: identifier,
        cases: z.record(identifier, identifier),
        grammar: identifier,
        engines: z
          .object({
            rubric: identifier,
            topology: identifier,
            equation: identifier,
          })
          .strict(),
      })
      .strict(),
    pretestBaseline: studentMemoryBaselineSchema,
    nodes: z.array(studentMemoryNodeSchema),
    formalAssessments: z.array(formalAssessmentMemorySchema),
    divergences: z.array(studentMemoryDivergenceSchema),
    supportDependencies: z.array(z
      .object({
        nodeId: identifier,
        dependsOn: z.array(identifier),
      })
      .strict()),
    resolvedObjectives: z.array(z
      .object({
        caseId: identifier,
        objectiveId: identifier,
        questionId: identifier,
        resolvedAt: z.string().datetime({ offset: true }),
      })
      .strict()),
    caseProgress: z.array(z
      .object({
        caseId: identifier,
        resolvedObjectiveIds: z.array(identifier),
        completed: z.boolean(),
      })
      .strict()),
    interactionSignals: z
      .object({
        answerCount: z.number().int().nonnegative(),
        assistanceCount: z.number().int().nonnegative(),
        retryCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const expected = new Set(snapshot.pretestBaseline.nodes.map((node) => node.nodeId));
    const actual = new Set(snapshot.nodes.map((node) => node.nodeId));
    if (
      expected.size !== snapshot.pretestBaseline.nodes.length
      || actual.size !== snapshot.nodes.length
      || expected.size !== actual.size
      || [...expected].some((nodeId) => !actual.has(nodeId))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nodes'],
        message: 'snapshot must contain exactly one current state for every baseline node',
      });
    }
    const dependencyNodes = new Set(
      snapshot.supportDependencies.map((entry) => entry.nodeId),
    );
    if (
      dependencyNodes.size !== snapshot.supportDependencies.length
      || dependencyNodes.size !== actual.size
      || [...actual].some((nodeId) => !dependencyNodes.has(nodeId))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['supportDependencies'],
        message: 'snapshot must retain dependencies for every knowledge node',
      });
    }
  });

export const studentMemoryIndexV1Schema = z
  .object({
    version: z.literal('student-memory-index.v1'),
    snapshotId: identifier,
    sourceThroughSequence: z.number().int().nonnegative(),
    counts: z.record(studentUnderstandingStateSchema, z.number().int().nonnegative()),
    nodes: z.array(z
      .object({
        nodeId: identifier,
        state: studentUnderstandingStateSchema,
        confidence: z.number().min(0).max(1),
        hasMisconception: z.boolean(),
        hasDivergence: z.boolean(),
      })
      .strict()),
    resolvedObjectives: z.array(z
      .object({
        caseId: identifier,
        objectiveId: identifier,
      })
      .strict()),
  })
  .strict();

export const studentMemoryTopicV1Schema = z
  .object({
    version: z.literal('student-memory-topic.v1'),
    snapshotId: identifier,
    kind: z.enum(['node', 'dimension', 'evidence']),
    key: identifier,
    nodes: z.array(studentMemoryNodeSchema),
    formalAssessments: z.array(formalAssessmentMemorySchema),
    divergences: z.array(studentMemoryDivergenceSchema),
    supportDependencies: z.array(z
      .object({
        nodeId: identifier,
        dependsOn: z.array(identifier),
      })
      .strict()),
  })
  .strict();

export const studentMemoryNodeUpdateSchema = z
  .object({
    nodeId: identifier,
    state: z.enum(['mastered', 'developing', 'not-yet', 'uncertain']),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(1000),
    misconceptionIds: z.array(identifier).default([]),
    evidenceEventIds: z.array(identifier).default([]),
  })
  .strict();

export type StudentUnderstandingState = z.infer<typeof studentUnderstandingStateSchema>;
export type StudentMemoryNode = z.infer<typeof studentMemoryNodeSchema>;
export type StudentMemorySnapshotV1 = z.infer<typeof studentMemorySnapshotV1Schema>;
export type StudentMemoryIndexV1 = z.infer<typeof studentMemoryIndexV1Schema>;
export type StudentMemoryTopicV1 = z.infer<typeof studentMemoryTopicV1Schema>;
export type StudentMemoryNodeUpdate = z.infer<typeof studentMemoryNodeUpdateSchema>;
