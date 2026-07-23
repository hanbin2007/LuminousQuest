import type {
  NormalizedAgentAction,
  TerminalAgentActionRef,
} from '../../../shared/agent/contracts';

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

export interface AgentTurnAdapter {
  readonly id: 'openai-compatible' | 'claude-agent';
  execute(request: AgentTurnAdapterRequest): Promise<AgentTurnAdapterResult>;
}

export class AgentTurnAdapterNotImplementedError extends Error {
  constructor(adapterId: AgentTurnAdapter['id']) {
    super(`${adapterId} AgentTurnAdapter is a Phase 1 contract stub`);
    this.name = 'AgentTurnAdapterNotImplementedError';
  }
}
