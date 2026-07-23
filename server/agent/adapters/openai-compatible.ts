import {
  AgentTurnAdapterNotImplementedError,
  type AgentTurnAdapter,
  type AgentTurnAdapterRequest,
  type AgentTurnAdapterResult,
} from './adapter';

export class OpenAICompatibleAgentTurnAdapter implements AgentTurnAdapter {
  readonly id = 'openai-compatible' as const;

  execute(_request: AgentTurnAdapterRequest): Promise<AgentTurnAdapterResult> {
    return Promise.reject(new AgentTurnAdapterNotImplementedError(this.id));
  }
}
