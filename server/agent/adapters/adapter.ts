import type {
  NormalizedAgentAction,
  TerminalAgentActionRef,
} from '../../../shared/agent/contracts';
import {
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
  terminalAgentActionRefSchema,
} from '../../../shared/agent/contracts';
import { z } from 'zod';

export interface AgentTurnMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentTurnAdapterRequest {
  requestHash: `sha256:${string}`;
  model: string;
  systemPrompt: string;
  messages: AgentTurnMessage[];
  tools: AgentToolDefinition[];
  maxTurns: number;
  signal?: AbortSignal;
  executeTool?: (
    action: NormalizedAgentAction,
  ) => Promise<AgentToolExecutionResult>;
}

export interface AgentTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentTurnAdapterResult {
  source: 'provider' | 'development-cache' | 'demo-recording' | 'fallback';
  model: string;
  orderedActions: NormalizedAgentAction[];
  terminalAction: TerminalAgentActionRef;
  usage: AgentTurnUsage;
}

export interface AgentToolExecutionResult {
  accepted: boolean;
  action: NormalizedAgentAction;
  content: string;
  errorCategory?: string;
}

export interface AgentTurnAdapter {
  readonly id: 'openai-compatible' | 'claude-agent';
  execute(request: AgentTurnAdapterRequest): Promise<AgentTurnAdapterResult>;
}

export const agentTurnAdapterResultSchema = z
  .object({
    source: z.enum(['provider', 'development-cache', 'demo-recording', 'fallback']),
    model: z.string().trim().min(1),
    orderedActions: z.array(normalizedAgentActionSchema).min(1).max(8),
    terminalAction: terminalAgentActionRefSchema,
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    const callIds = new Set<string>();
    const judgedNodes = new Set<string>();
    let continuations = 0;
    let terminals = 0;

    result.orderedActions.forEach((action, index) => {
      if (callIds.has(action.callId)) {
        context.addIssue({
          code: 'custom',
          path: ['orderedActions', index, 'callId'],
          message: `duplicate tool call id ${action.callId}`,
        });
      }
      callIds.add(action.callId);
      if (terminalAgentActionNameSchema.safeParse(action.name).success) {
        terminals += 1;
      } else {
        continuations += 1;
      }
      if (action.name === 'conclude_node') {
        if (judgedNodes.has(action.arguments.nodeId)) {
          context.addIssue({
            code: 'custom',
            path: ['orderedActions', index, 'arguments', 'nodeId'],
            message: 'a node can be judged at most once per turn',
          });
        }
        judgedNodes.add(action.arguments.nodeId);
      }
    });

    const last = result.orderedActions.at(-1);
    if (
      terminals !== 1
      || continuations > 6
      || last?.callId !== result.terminalAction.callId
      || last?.name !== result.terminalAction.name
    ) {
      context.addIssue({
        code: 'custom',
        path: ['terminalAction'],
        message: 'the one terminal action must be the final ordered action',
      });
    }
  });

export function parseAgentTurnAdapterResult(value: unknown): AgentTurnAdapterResult {
  return agentTurnAdapterResultSchema.parse(value);
}

export class AgentTurnAdapterError extends Error {
  constructor(
    message: string,
    readonly category = 'provider-error',
    readonly httpStatus?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AgentTurnAdapterError';
  }
}
