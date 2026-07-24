import { z } from 'zod';

import {
  agentEquationFillBoardSchema,
  agentResponseBoardSchema,
  agentShortFillBoardSchema,
  agentSingleChoiceBoardSchema,
} from '../../shared/agent/contracts';
import { studentMemoryNodeUpdateSchema } from '../../shared/agent/memory';
import type { AgentToolDefinition } from './adapters/adapter';

const identifier = z.string().trim().min(1);
const questionBoardSchema = z.discriminatedUnion('kind', [
  agentSingleChoiceBoardSchema,
  agentShortFillBoardSchema,
  agentEquationFillBoardSchema,
]);

export const agentToolArgumentSchemas = {
  select_objective: z
    .object({ objectiveId: identifier })
    .strict(),
  show_question_card: z
    .object({
      objectiveId: identifier,
      text: z.string().trim().min(1).max(240),
      board: questionBoardSchema,
    })
    .strict(),
  show_case_material: z.object({ materialId: identifier }).strict(),
  focus_cognitive_node: z
    .object({
      nodeId: identifier,
      mode: z.enum(['focus', 'halo', 'camera']).default('focus'),
    })
    .strict(),
  recall_student_memory: z
    .object({
      kind: z.enum(['index', 'node', 'dimension', 'evidence']),
      nodeId: identifier.optional(),
      dimensionId: identifier.optional(),
      eventId: identifier.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const required = value.kind === 'node'
        ? 'nodeId'
        : value.kind === 'dimension'
          ? 'dimensionId'
          : value.kind === 'evidence'
            ? 'eventId'
            : null;
      for (const key of ['nodeId', 'dimensionId', 'eventId'] as const) {
        if ((key === required) !== (value[key] !== undefined)) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: key === required ? `is required for ${value.kind}` : `is not valid for ${value.kind}`,
          });
        }
      }
    }),
  update_student_understanding: z
    .object({
      objectiveId: identifier,
      updates: z.array(studentMemoryNodeUpdateSchema).min(1).max(12),
    })
    .strict(),
  resolve_question: z
    .object({
      objectiveId: identifier,
      summary: z.string().trim().min(1).max(400),
      updates: z.array(studentMemoryNodeUpdateSchema).min(1).max(12),
    })
    .strict(),
  end_case: z
    .object({ summary: z.string().trim().min(1).max(400) })
    .strict(),
} as const;

const legacyAgentToolArgumentSchemas = {
  ask_student: z
    .object({
      text: z.string().trim().min(1),
      responseContractId: identifier,
      board: agentResponseBoardSchema.optional(),
    })
    .strict(),
  present_question: z
    .object({ questionId: identifier, responseContractId: identifier })
    .strict(),
  present_material: z.object({ materialId: identifier }).strict(),
  focus_node: z.object({ nodeId: identifier }).strict(),
  get_profile: z.object({}).strict(),
  conclude_node: z
    .object({
      nodeId: identifier,
      verdict: z.enum(['hit', 'partial', 'miss', 'inconclusive']),
      rationale: z.string().trim().min(1),
    })
    .strict(),
  end_session: z.object({ summary: z.string().trim().min(1) }).strict(),
} as const;

export type AgentToolName = keyof typeof agentToolArgumentSchemas;

const descriptions: Record<AgentToolName, string> = {
  select_objective:
    'Select exactly one unresolved objective from the private objective pool. Call before asking its first question.',
  show_question_card:
    'Show exactly one atomic student question and wait. Use one single-choice, short-fill, or equation-fill board. Never ask for a complete sentence or combine questions.',
  show_case_material:
    'Reveal one configured material that is currently available in this case.',
  focus_cognitive_node:
    'Move the 3D camera or focus halo to one knowledge node. This is visual only and never changes mastery.',
  recall_student_memory:
    'Read the latest student-memory index or one detailed node, dimension, or evidence topic. This never mutates memory.',
  update_student_understanding:
    'After every student answer, update the in-case working understanding used for provisional 3D feedback. This does not commit long-term memory.',
  resolve_question:
    'When the current atomic objective is solved, submit its semantic node updates. The server atomically commits a complete student-memory snapshot and returns the new index.',
  end_case:
    'End the case only after every configured objective has been resolved.',
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-7' });
  const { $schema: _schema, ...inputSchema } = generated;
  return inputSchema;
}

const LIVE_AGENT_TOOL_SPECS = (
  Object.keys(agentToolArgumentSchemas) as AgentToolName[]
).map((name) => ({
  name,
  description: descriptions[name],
  schema: agentToolArgumentSchemas[name],
  inputSchema: jsonSchema(agentToolArgumentSchemas[name]),
}));

const legacyDescriptions: Record<keyof typeof legacyAgentToolArgumentSchemas, string> = {
  ask_student: 'Legacy archived question tool.',
  present_question: 'Legacy archived configured-question tool.',
  present_material: 'Legacy archived material tool.',
  focus_node: 'Legacy archived focus tool.',
  get_profile: 'Legacy archived profile tool.',
  conclude_node: 'Legacy archived judgment tool.',
  end_session: 'Legacy archived terminal tool.',
};

const LEGACY_AGENT_TOOL_SPECS = (
  Object.keys(legacyAgentToolArgumentSchemas) as Array<
    keyof typeof legacyAgentToolArgumentSchemas
  >
).map((name) => ({
  name,
  description: legacyDescriptions[name],
  schema: legacyAgentToolArgumentSchemas[name],
  inputSchema: jsonSchema(legacyAgentToolArgumentSchemas[name]),
}));

// The adapter can replay archived v2 traces, while new model calls receive
// only the v3 live definitions from createAgentToolDefinitions().
export const AGENT_TOOL_SPECS = [
  ...LIVE_AGENT_TOOL_SPECS,
  ...LEGACY_AGENT_TOOL_SPECS,
];

export function createAgentToolDefinitions(): AgentToolDefinition[] {
  return LIVE_AGENT_TOOL_SPECS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema: structuredClone(inputSchema),
  }));
}

export function parseAgentToolArguments(name: string, value: unknown) {
  const schema = (
    agentToolArgumentSchemas as Record<string, z.ZodType>
  )[name] ?? (
    legacyAgentToolArgumentSchemas as Record<string, z.ZodType>
  )[name];
  if (!schema) throw new Error(`Unknown agent tool ${name}`);
  return schema.parse(value);
}
