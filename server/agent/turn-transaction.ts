import {
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
  type NormalizedAgentAction,
  type TerminalAgentActionRef,
} from '../../shared/agent/contracts';
import { appendSessionEvent } from '../../shared/session/session';
import type {
  SessionEventInput,
  StudentSession,
} from '../../shared/session/schema';

type AgentTurnInput = Extract<SessionEventInput, { kind: 'agent.turn.completed' }>;
type AgentWriteInput = Extract<
  SessionEventInput,
  { kind: 'agent.judgment.recorded' | 'agent.divergence.changed' }
>;
type AgentTurnMetadata = Omit<AgentTurnInput, 'orderedActions' | 'terminalAction'>;

export type AgentTurnTransactionState = 'open' | 'terminal' | 'committed' | 'aborted';

export class AgentTurnTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTurnTransactionError';
  }
}

export class AgentTurnTransaction {
  private transactionState: AgentTurnTransactionState = 'open';
  private readonly actions: NormalizedAgentAction[] = [];
  private readonly stagedWrites: AgentWriteInput[] = [];
  private readonly callIds = new Set<string>();
  private readonly judgedNodeIds = new Set<string>();
  private continuationCount = 0;
  private terminalAction: TerminalAgentActionRef | undefined;

  get state() {
    return this.transactionState;
  }

  recordAction(input: unknown) {
    this.requireOpen('tool call');
    const action = normalizedAgentActionSchema.parse(input);
    if (this.actions.length >= 8) {
      throw new AgentTurnTransactionError('A turn can contain at most 8 tool calls');
    }
    if (this.callIds.has(action.callId)) {
      throw new AgentTurnTransactionError(`Duplicate tool call id ${action.callId}`);
    }

    const terminal = terminalAgentActionNameSchema.safeParse(action.name).success;
    if (!terminal && this.continuationCount >= 6) {
      throw new AgentTurnTransactionError('A turn can contain at most 6 continuation actions');
    }
    if (action.name === 'conclude_node') {
      if (this.judgedNodeIds.has(action.arguments.nodeId)) {
        throw new AgentTurnTransactionError('A node can be judged at most once per turn');
      }
      this.judgedNodeIds.add(action.arguments.nodeId);
    }

    this.callIds.add(action.callId);
    this.actions.push(action);
    if (terminal) {
      this.terminalAction = {
        callId: action.callId,
        name: action.name as TerminalAgentActionRef['name'],
      };
      this.transactionState = 'terminal';
    } else {
      this.continuationCount += 1;
    }
    return action;
  }

  stageWrite(event: AgentWriteInput) {
    this.requireOpen('agent write');
    this.stagedWrites.push(event);
  }

  commit(session: StudentSession, metadata: AgentTurnMetadata) {
    if (this.transactionState !== 'terminal' || !this.terminalAction) {
      throw new AgentTurnTransactionError(
        'A turn transaction can commit only after one terminal action',
      );
    }
    try {
      let committed = appendSessionEvent(session, {
        ...metadata,
        orderedActions: [...this.actions],
        terminalAction: this.terminalAction,
      });
      for (const event of this.stagedWrites) {
        committed = appendSessionEvent(committed, event);
      }
      this.transactionState = 'committed';
      this.stagedWrites.length = 0;
      return committed;
    } catch (error) {
      this.transactionState = 'aborted';
      this.stagedWrites.length = 0;
      throw error;
    }
  }

  private requireOpen(operation: string) {
    if (this.transactionState !== 'open') {
      throw new AgentTurnTransactionError(
        `Cannot record ${operation} after the terminal latch`,
      );
    }
  }
}
