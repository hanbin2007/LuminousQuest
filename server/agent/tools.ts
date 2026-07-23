import { z } from 'zod';

import type { AgentToolDefinition } from './adapters/adapter';

const identifier = z.string().trim().min(1);

export const agentToolArgumentSchemas = {
  ask_student: z
    .object({
      text: z.string().trim().min(1),
      responseContractId: identifier,
    })
    .strict(),
  present_question: z
    .object({
      questionId: identifier,
      responseContractId: identifier,
    })
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
  ask_student:
    'Ask one free-form student-facing question. Use a server-provided response contract candidate.',
  present_question:
    'Present one configured question verbatim and wait for the student response.',
  present_material: 'Present one configured case material to the student.',
  focus_node: 'Move the non-authoritative 3D focus to one knowledge node.',
  get_profile: 'Read the latest diagnostic and record-track profile snapshot.',
  conclude_node: 'Record the agent judgment for one knowledge node.',
  end_session: 'End training with a concise student-facing summary.',
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-7' });
  const { $schema: _schema, ...inputSchema } = generated;
  return inputSchema;
}

export const AGENT_TOOL_SPECS = (
  Object.keys(agentToolArgumentSchemas) as AgentToolName[]
).map((name) => ({
  name,
  description: descriptions[name],
  schema: agentToolArgumentSchemas[name],
  inputSchema: jsonSchema(agentToolArgumentSchemas[name]),
}));

export function createAgentToolDefinitions(): AgentToolDefinition[] {
  return AGENT_TOOL_SPECS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema: structuredClone(inputSchema),
  }));
}

export function parseAgentToolArguments(name: string, value: unknown) {
  const schema = agentToolArgumentSchemas[name as AgentToolName];
  if (!schema) throw new Error(`Unknown agent tool ${name}`);
  return schema.parse(value);
}
