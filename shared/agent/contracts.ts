import { z } from 'zod';

export const AGENT_CONTRACT_REVISION = 'agent-contract.v1' as const;
export const AGENT_TOOLSET_DIGEST =
  'sha256:9ba48ee80a9684b10385dbe8e99c393c8113980b7244da9a264f8f2b65fd9078' as const;
export const AGENT_CONTEXT_BUILDER_VERSION = 'agent-context-builder.v1' as const;
export const RESPONSE_CONTRACT_REVISION = 'response-contract.v1' as const;

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

const askStudentActionSchema = z
  .object({
    callId: identifierSchema,
    name: z.literal('ask_student'),
    arguments: z
      .object({
        text: z.string().trim().min(1),
        responseContractId: identifierSchema,
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

export const normalizedAgentActionSchema = z.discriminatedUnion('name', [
  askStudentActionSchema,
  presentQuestionActionSchema,
  presentMaterialActionSchema,
  focusNodeActionSchema,
  getProfileActionSchema,
  concludeNodeActionSchema,
  endSessionActionSchema,
]);

export const terminalAgentActionNameSchema = z.enum([
  'ask_student',
  'present_question',
  'end_session',
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
