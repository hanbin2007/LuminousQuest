import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  Cpu,
  LoaderCircle,
  Send,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { AgentActivityMessage } from './agent-activity';
import { useAgentActivityView } from './AgentActivityContext';

function StatusIcon({ message }: { message: AgentActivityMessage }) {
  if (message.state === 'running') {
    return <LoaderCircle aria-hidden="true" className="agent-activity__spinner" />;
  }
  if (message.state === 'error' || message.state === 'warning') {
    return <AlertCircle aria-hidden="true" />;
  }
  if (message.role === 'user') return <Send aria-hidden="true" />;
  return message.role === 'agent'
    ? <Bot aria-hidden="true" />
    : <Check aria-hidden="true" />;
}

export function AgentActivityPanel() {
  const { messages, open, hasActivity, setOpen, clear } = useAgentActivityView();
  const streamRef = useRef<HTMLDivElement>(null);
  const runningMessage = messages.find((message) => message.state === 'running');
  const running = runningMessage !== undefined;
  const [now, setNow] = useState(Date.now());
  const runningSince = runningMessage === undefined
    ? undefined
    : messages.find((message) => message.runId === runningMessage.runId)?.occurredAt;
  const elapsedSeconds = runningSince === undefined
    ? 0
    : Math.max(0, Math.floor((now - runningSince) / 1000));

  useEffect(() => {
    if (!open) return;
    const stream = streamRef.current;
    if (!stream) return;
    if (typeof stream.scrollTo === 'function') {
      stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
    } else {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [messages, open]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!hasActivity) return null;

  if (!open) {
    return (
      <button
        aria-label={running ? '打开 Agent 消息流，Agent 正在工作' : '打开 Agent 消息流'}
        className="agent-activity__launcher"
        data-running={running || undefined}
        onClick={() => setOpen(true)}
        title="Agent 消息流"
        type="button"
      >
        {running
          ? <LoaderCircle aria-hidden="true" className="agent-activity__spinner" />
          : <Bot aria-hidden="true" />}
      </button>
    );
  }

  return (
    <aside
      aria-label="Agent 消息流"
      className="agent-activity"
      data-running={running || undefined}
    >
      <header className="agent-activity__header">
        <span className="agent-activity__identity">
          <i aria-hidden="true"><Cpu /></i>
          <span>
            <strong>Agent 消息流</strong>
            <small>{running ? `正在分析 · ${elapsedSeconds} 秒` : '本轮已同步'}</small>
          </span>
        </span>
        <span className="agent-activity__actions">
          <button
            aria-label="清空 Agent 消息流"
            disabled={running}
            onClick={clear}
            title="清空消息流"
            type="button"
          >
            <Trash2 aria-hidden="true" />
          </button>
          <button
            aria-label="收起 Agent 消息流"
            onClick={() => setOpen(false)}
            title="收起"
            type="button"
          >
            <ChevronDown aria-hidden="true" />
          </button>
        </span>
      </header>
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="agent-activity__stream"
        ref={streamRef}
        role="log"
      >
        {messages.map((message) => (
          <article
            className="agent-activity__message"
            data-role={message.role}
            data-state={message.state}
            key={message.id}
          >
            <span className="agent-activity__message-icon">
              <StatusIcon message={message} />
            </span>
            <div>
              <strong>{message.title}</strong>
              <p>{message.body}</p>
              {message.meta ? <small>{message.meta}</small> : null}
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}
