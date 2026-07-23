import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

import {
  agentActivityFailureMessage,
  createAgentActivityRunId,
  type AgentActivityActions,
  type AgentActivityMessage,
  type AgentActivityResult,
  type AgentActivityRun,
} from './agent-activity';

interface AgentActivityViewState {
  messages: AgentActivityMessage[];
  open: boolean;
  hasActivity: boolean;
}

interface AgentActivityViewActions {
  setOpen: (open: boolean) => void;
  clear: () => void;
}

const StateContext = createContext<AgentActivityViewState | null>(null);
const ActionsContext = createContext<AgentActivityActions | null>(null);
const ViewActionsContext = createContext<AgentActivityViewActions | null>(null);

const maximumMessages = 30;

function messageId(runId: string, suffix: string) {
  return `${runId}-${suffix}`;
}

export function AgentActivityProvider({ children }: PropsWithChildren) {
  const [messages, setMessages] = useState<AgentActivityMessage[]>([]);
  const [open, setOpen] = useState(false);

  const begin = useCallback((run: AgentActivityRun) => {
    const runId = createAgentActivityRunId();
    const occurredAt = Date.now();
    setMessages((current) => [
      ...current,
      {
        id: messageId(runId, 'submitted'),
        runId,
        role: 'user' as const,
        title: '已收到提交',
        body: run.target,
        ...(run.summary ? { meta: run.summary } : {}),
        state: 'complete' as const,
        occurredAt,
      },
      {
        id: messageId(runId, 'working'),
        runId,
        role: run.role,
        title: run.title,
        body: run.body,
        state: 'running' as const,
        occurredAt: occurredAt + 1,
      },
    ].slice(-maximumMessages));
    setOpen(true);
    return runId;
  }, []);

  const progress = useCallback((runId: string, result: AgentActivityResult) => {
    setMessages((current) => {
      if (!current.some((message) => message.runId === runId && message.state === 'running')) {
        return current;
      }
      return [
        ...current.map((message) => message.runId === runId && message.state === 'running'
          ? { ...message, state: 'complete' as const }
          : message),
        {
          id: messageId(runId, `progress-${Date.now()}`),
          runId,
          role: result.role ?? 'agent',
          title: result.title,
          body: result.body,
          ...(result.meta ? { meta: result.meta } : {}),
          state: 'running' as const,
          occurredAt: Date.now(),
        },
      ].slice(-maximumMessages);
    });
  }, []);

  const complete = useCallback((runId: string, result: AgentActivityResult) => {
    setMessages((current) => [
      ...current.map((message) => message.runId === runId && message.state === 'running'
        ? { ...message, state: 'complete' as const }
        : message),
      {
        id: messageId(runId, 'result'),
        runId,
        role: result.role ?? 'agent',
        title: result.title,
        body: result.body,
        ...(result.meta ? { meta: result.meta } : {}),
        state: result.state ?? 'complete',
        occurredAt: Date.now(),
      },
    ].slice(-maximumMessages));
  }, []);

  const fail = useCallback((runId: string, error: unknown) => {
    setMessages((current) => [
      ...current.map((message) => message.runId === runId && message.state === 'running'
        ? { ...message, state: 'error' as const, body: '本次处理未完成。' }
        : message),
      {
        id: messageId(runId, 'error'),
        runId,
        role: 'system' as const,
        title: '处理失败',
        body: agentActivityFailureMessage(error),
        state: 'error' as const,
        occurredAt: Date.now(),
      },
    ].slice(-maximumMessages));
  }, []);

  const activityActions = useMemo<AgentActivityActions>(
    () => ({ begin, progress, complete, fail }),
    [begin, progress, complete, fail],
  );
  const viewState = useMemo<AgentActivityViewState>(
    () => ({ messages, open, hasActivity: messages.length > 0 }),
    [messages, open],
  );
  const viewActions = useMemo<AgentActivityViewActions>(
    () => ({ setOpen, clear: () => setMessages([]) }),
    [],
  );

  return (
    <ActionsContext.Provider value={activityActions}>
      <ViewActionsContext.Provider value={viewActions}>
        <StateContext.Provider value={viewState}>
          {children}
        </StateContext.Provider>
      </ViewActionsContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useAgentActivityActions() {
  const value = useContext(ActionsContext);
  if (!value) throw new Error('AgentActivityProvider is not available');
  return value;
}

export function useAgentActivityView() {
  const state = useContext(StateContext);
  const actions = useContext(ViewActionsContext);
  if (!state || !actions) throw new Error('AgentActivityProvider is not available');
  return { ...state, ...actions };
}
