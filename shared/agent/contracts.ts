import { z } from 'zod';
import { studentMemoryNodeUpdateSchema } from './memory';

export const AGENT_CONTRACT_REVISION = 'agent-contract.v3' as const;
export const AGENT_TOOLSET_DIGEST =
  'sha256:ba0b4078345823dde2518aba1280cf3cfe464ccc039df6892cd251489b146c8a' as const;
export const AGENT_CONTEXT_BUILDER_VERSION = 'agent-context-builder.v3' as const;
export const RESPONSE_CONTRACT_REVISION = 'response-contract.v2' as const;

const identifierSchema = z.string().trim().min(1);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uniqueIdentifiersSchema = z.array(identifierSchema).superRefine((values, context) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: `duplicate identifier ${value}`,
      });
    }
    seen.add(value);
  });
});

export const agentVerdictSchema = z.enum(['hit', 'partial', 'miss', 'inconclusive']);
export const comparableAgentVerdictSchema = z.enum(['hit', 'partial', 'miss']);

const agentChoiceBoardOptionSchema = z
  .object({
    id: identifierSchema,
    label: z.string().trim().min(1).max(60),
  })
  .strict();

const agentChoiceBoardSchema = z
  .object({
    kind: z.literal('choice'),
    options: z.array(agentChoiceBoardOptionSchema).min(2).max(6),
  })
  .strict()
  .superRefine((board, context) => {
    const ids = new Set<string>();
    const labels = new Set<string>();
    board.options.forEach((option, index) => {
      if (ids.has(option.id)) {
        context.addIssue({
          code: 'custom',
          path: ['options', index, 'id'],
          message: `duplicate choice id ${option.id}`,
        });
      }
      if (labels.has(option.label)) {
        context.addIssue({
          code: 'custom',
          path: ['options', index, 'label'],
          message: `duplicate choice label ${option.label}`,
        });
      }
      ids.add(option.id);
      labels.add(option.label);
    });
  });

const agentFillBlankBoardSchema = z
  .object({
    kind: z.literal('fill-blank'),
    placeholder: z.string().trim().min(1).max(40),
    maxLength: z.number().int().min(1).max(40),
  })
  .strict();

export const agentSingleChoiceBoardSchema = z
  .object({
    kind: z.literal('single-choice'),
    options: z.array(agentChoiceBoardOptionSchema).min(2).max(6),
  })
  .strict()
  .superRefine((board, context) => {
    const ids = new Set<string>();
    board.options.forEach((option, index) => {
      if (ids.has(option.id)) {
        context.addIssue({
          code: 'custom',
          path: ['options', index, 'id'],
          message: `duplicate choice id ${option.id}`,
        });
      }
      ids.add(option.id);
    });
  });

export const agentShortFillBoardSchema = z
  .object({
    kind: z.literal('short-fill'),
    placeholder: z.string().trim().min(1).max(40).default('关键词或短语'),
    maxLength: z.number().int().min(1).max(40).default(24),
  })
  .strict();

export const agentEquationFillBoardSchema = z
  .object({
    kind: z.literal('equation-fill'),
    placeholder: z.string().trim().min(1).max(40).default('填写一条反应式'),
  })
  .strict();

export const agentResponseBoardSchema = z.discriminatedUnion('kind', [
  agentChoiceBoardSchema,
  agentFillBlankBoardSchema,
  agentSingleChoiceBoardSchema,
  agentShortFillBoardSchema,
  agentEquationFillBoardSchema,
]);

const askStudentActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('ask_student'),
    arguments: z
      .object({
        text: z.string().trim().min(1),
        responseContractId: identifierSchema,
        // Optional here so archived v1 turns remain importable. The live tool
        // schema requires a board for every newly generated ask_student call.
        board: agentResponseBoardSchema.optional(),
      })
      .strict(),
  })
  .strict();

const presentQuestionActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('present_question'),
    arguments: z
      .object({
        questionId: identifierSchema,
        responseContractId: identifierSchema,
      })
      .strict(),
  })
  .strict();

const presentMaterialActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('present_material'),
    arguments: z.object({ materialId: identifierSchema }).strict(),
  })
  .strict();

const focusNodeActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('focus_node'),
    arguments: z.object({ nodeId: identifierSchema }).strict(),
  })
  .strict();

const getProfileActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('get_profile'),
    arguments: z.object({}).strict(),
  })
  .strict();

const concludeNodeActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('conclude_node'),
    arguments: z
      .object({
        nodeId: identifierSchema,
        verdict: agentVerdictSchema,
        rationale: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const endSessionActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('end_session'),
    arguments: z.object({ summary: z.string().trim().min(1) }).strict(),
  })
  .strict();

const selectObjectiveActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('select_objective'),
    arguments: z.object({ objectiveId: identifierSchema }).strict(),
  })
  .strict();

const showQuestionCardActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('show_question_card'),
    arguments: z
      .object({
        objectiveId: identifierSchema,
        text: z.string().trim().min(1).max(240),
        board: z.discriminatedUnion('kind', [
          agentSingleChoiceBoardSchema,
          agentShortFillBoardSchema,
          agentEquationFillBoardSchema,
        ]),
        // Server-generated. It is absent in the provider tool input and added
        // by the execution boundary before the action is persisted.
        responseContractId: identifierSchema.optional(),
      })
      .strict(),
  })
  .strict();

const showCaseMaterialActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('show_case_material'),
    arguments: z.object({ materialId: identifierSchema }).strict(),
  })
  .strict();

const focusCognitiveNodeActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('focus_cognitive_node'),
    arguments: z
      .object({
        nodeId: identifierSchema,
        mode: z.enum(['focus', 'halo', 'camera']).default('focus'),
      })
      .strict(),
  })
  .strict();

const recallStudentMemoryActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('recall_student_memory'),
    arguments: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('index') }).strict(),
      z.object({ kind: z.literal('node'), nodeId: identifierSchema }).strict(),
      z.object({ kind: z.literal('dimension'), dimensionId: identifierSchema }).strict(),
      z.object({ kind: z.literal('evidence'), eventId: identifierSchema }).strict(),
    ]),
  })
  .strict();

const updateStudentUnderstandingActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('update_student_understanding'),
    arguments: z
      .object({
        objectiveId: identifierSchema,
        updates: z.array(studentMemoryNodeUpdateSchema).min(1).max(12),
      })
      .strict(),
  })
  .strict();

const resolveQuestionActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('resolve_question'),
    arguments: z
      .object({
        objectiveId: identifierSchema,
        summary: z.string().trim().min(1).max(400),
        updates: z.array(studentMemoryNodeUpdateSchema).min(1).max(12),
      })
      .strict(),
  })
  .strict();

const endCaseActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('end_case'),
    arguments: z.object({ summary: z.string().trim().min(1).max(400) }).strict(),
  })
  .strict();

export const normalizedAgentActionSchema = z.discriminatedUnion('name', [
  askStudentActionSchema,
  presentQuestionActionSchema,
  presentMaterialActionSchema,
  focusNodeActionSchema,
  getProfileActionSchema,
  concludeNodeActionSchema,
  endSessionActionSchema,
  selectObjectiveActionSchema,
  showQuestionCardActionSchema,
  showCaseMaterialActionSchema,
  focusCognitiveNodeActionSchema,
  recallStudentMemoryActionSchema,
  updateStudentUnderstandingActionSchema,
  resolveQuestionActionSchema,
  endCaseActionSchema,
]);

export const terminalAgentActionNameSchema = z.enum([
  'ask_student',
  'present_question',
  'end_session',
  'show_question_card',
  'end_case',
]);

export const terminalAgentActionRefSchema = z
  .object({
    callId: identifierSchema,
    name: terminalAgentActionNameSchema,
  })
  .strict();

export const agentEventProvenanceSchema = z
  .object({
    adapter: z.enum(['openai-compatible', 'claude-agent']),
    adapterVersion: identifierSchema,
  })
  .strict();

const choiceAssessmentEntrypointSchema = z
  .object({
    kind: z.literal('choice'),
    route: z.literal('/api/assessment/choice'),
  })
  .strict();

const textAssessmentEntrypointSchema = z
  .object({
    kind: z.literal('text-extraction'),
    route: z.literal('/api/assessment/extract'),
  })
  .strict();

const directChoiceAssessmentEntrypointSchema = z
  .object({
    kind: z.literal('direct-choice'),
    route: z.literal('/api/assessment/choice'),
  })
  .strict();

const directTextAssessmentEntrypointSchema = z
  .object({
    kind: z.literal('direct-text'),
    route: z.literal('/api/assessment/extract'),
  })
  .strict();

const equationAssessmentEntrypointSchema = z
  .object({
    kind: z.literal('equation'),
    route: z.literal('/api/assessment/equation'),
    equationSetId: identifierSchema,
  })
  .strict();

const builderAssessmentEntrypointSchema = z
  .object({
    kind: z.literal('builder'),
    handler: z.literal('recordBuilderAssessment'),
  })
  .strict();

const unassessedEntrypointSchema = z
  .object({
    kind: z.literal('unassessed'),
    reason: z.enum([
      'conversation-only',
      'unsupported-question',
      'teacher-review-required',
    ]),
  })
  .strict();

export const assessmentEntrypointSchema = z.discriminatedUnion('kind', [
  choiceAssessmentEntrypointSchema,
  textAssessmentEntrypointSchema,
  directChoiceAssessmentEntrypointSchema,
  directTextAssessmentEntrypointSchema,
  equationAssessmentEntrypointSchema,
  builderAssessmentEntrypointSchema,
  unassessedEntrypointSchema,
]);

export const responseContractSchema = z
  .object({
    revision: z.literal(RESPONSE_CONTRACT_REVISION),
    responseContractId: identifierSchema,
    sessionId: identifierSchema,
    agentTurnId: identifierSchema,
    questionId: identifierSchema.nullable(),
    caseId: identifierSchema.nullable(),
    targetNodeIds: uniqueIdentifiersSchema,
    assessmentEntrypoint: assessmentEntrypointSchema,
    createdThroughSequence: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((contract, context) => {
    const unassessed = contract.assessmentEntrypoint.kind === 'unassessed';
    if (unassessed) {
      if (contract.questionId !== null) {
        context.addIssue({
          code: 'custom',
          path: ['questionId'],
          message: 'unassessed response contract cannot bind a question',
        });
      }
      if (contract.targetNodeIds.length !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['targetNodeIds'],
          message: 'unassessed response contract cannot bind grading targets',
        });
      }
      return;
    }
    if (contract.questionId === null) {
      context.addIssue({
        code: 'custom',
        path: ['questionId'],
        message: 'assessed response contract requires a question',
      });
    }
    if (contract.caseId === null) {
      context.addIssue({
        code: 'custom',
        path: ['caseId'],
        message: 'assessed response contract requires a case',
      });
    }
    if (contract.targetNodeIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['targetNodeIds'],
        message: 'assessed response contract requires grading targets',
      });
    }
  });

export type AgentVerdict = z.infer<typeof agentVerdictSchema>;
export type ComparableAgentVerdict = z.infer<typeof comparableAgentVerdictSchema>;
export type AgentResponseBoard = z.infer<typeof agentResponseBoardSchema>;
export type NormalizedAgentAction = z.infer<typeof normalizedAgentActionSchema>;
export type TerminalAgentActionRef = z.infer<typeof terminalAgentActionRefSchema>;
export type AgentEventProvenance = z.infer<typeof agentEventProvenanceSchema>;
export type AssessmentEntrypoint = z.infer<typeof assessmentEntrypointSchema>;
export type ResponseContract = z.infer<typeof responseContractSchema>;
export type ResponseContractUnassessedReason = Extract<
  AssessmentEntrypoint,
  { kind: 'unassessed' }
>['reason'];
export type AgentRequestHash = z.infer<typeof hashSchema>;

export const agentRequestHashSchema = hashSchema;
