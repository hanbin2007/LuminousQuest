import {
  AgentTurnAdapterNotImplementedError,
  type AgentTurnAdapter,
  type AgentTurnAdapterRequest,
  type AgentTurnAdapterResult,
} from './adapter';

export class ClaudeAgentTurnAdapter implements AgentTurnAdapter {
  readonly id = 'claude-agent' as const;

  execute(_request: AgentTurnAdapterRequest): Promise<AgentTurnAdapterResult> {
    return Promise.reject(new AgentTurnAdapterNotImplementedError(this.id));
  }
}
