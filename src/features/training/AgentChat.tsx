import { AlertTriangle, Bot, FileImage, LoaderCircle, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { LoadedConfig, CaseConfig } from '../../../shared/config/schemas';
import type {
  AgentTurnCompletedEvent,
  StudentSession,
} from '../../../shared/session/schema';
import { sessionServerSequence } from '../../../shared/session/sync';
import type { AppRuntime } from '../../runtime/api';
import { EquationToolbar } from '../pretest/EquationToolbar';
import { mergeServerSession } from '../pretest/session-merge';

interface AgentChatProps {
  config: LoadedConfig;
  runtime: AppRuntime;
  session: StudentSession;
  trainingCase: CaseConfig;
  onSession: (session: StudentSession) => void;
  onCommandPendingChange?: (pending: boolean) => void;
  suspended?: boolean;
}

type AgentAnswerEvent = Extract<
  StudentSession['events'][number],
  { kind: 'answer.submitted' }
>;

function questionPresentation(trainingCase: CaseConfig, questionId: string) {
  if (questionId === `${trainingCase.id}:analysis`) {
    return {
      prompt: `请分析案例“${trainingCase.title}”中的关键电化学过程。`,
      equation: false,
    };
  }
  const equation = trainingCase.equationSets.find(
    (entry) => questionId === `${trainingCase.id}:${entry.id}`,
  );
  if (equation) {
    const electrode = equation.electrode === 'negative'
      ? '负极半反应'
      : equation.electrode === 'positive'
        ? '正极半反应'
        : '总反应';
    return {
      prompt: `请写出案例“${trainingCase.title}”的${electrode}方程式。`,
      equation: true,
    };
  }
  return { prompt: questionId, equation: false };
}

function answerText(event: AgentAnswerEvent) {
  if (event.answer.format === 'text') return event.answer.value;
  if (event.answer.format === 'canvas') return '已提交画布作答';
  return `已提交装置图：${event.answer.value.components.length} 个元件`;
}

export function agentTurnTriggerForCase(
  session: StudentSession,
  caseId: string,
) {
  const learnerVisible = [...session.events].reverse().filter((event) =>
    event.kind !== 'session.command.executed'
    && event.kind !== 'agent.judgment.recorded'
    && event.kind !== 'agent.divergence.changed');
  return learnerVisible.find((event) => event.caseId === caseId)
    ?? learnerVisible[0];
}

export function AgentChat({
  config: _config,
  runtime,
  session,
  trainingCase,
  onSession,
  onCommandPendingChange,
  suspended = false,
}: AgentChatProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyTurnId, setBusyTurnId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedCases = useRef(new Set<string>());
  const allTurns = useMemo(() => session.events.filter(
    (event): event is AgentTurnCompletedEvent =>
      event.kind === 'agent.turn.completed',
  ), [session.events]);
  const turns = useMemo(() => allTurns.filter(
    (event) => event.caseId === trainingCase.id,
  ), [allTurns, trainingCase.id]);
  const answers = useMemo(() => new Map(session.events
    .filter((event): event is AgentAnswerEvent =>
      event.kind === 'answer.submitted' && Boolean(event.responseToAgentTurnId))
    .map((event) => [event.responseToAgentTurnId!, event])), [session.events]);
  const activeTurn = [...turns].reverse().find((turn) =>
    (turn.terminalAction.name === 'ask_student'
      || turn.terminalAction.name === 'present_question')
    && !answers.has(turn.turnId));
  const fallback = turns.some((turn) => turn.source === 'fallback');
  const trigger = agentTurnTriggerForCase(session, trainingCase.id);
  const startKey = `${session.id}:${trainingCase.id}`;

  const requestTurn = async () => {
    if (!runtime.runAgentTurn || !trigger || starting || suspended) return;
    startedCases.current.add(startKey);
    setStarting(true);
    onCommandPendingChange?.(true);
    setError(null);
    try {
      const result = await runtime.runAgentTurn({
        session,
        sessionId: session.id,
        caseId: trainingCase.id,
        triggerEventId: trigger.id,
        expectedSequence: sessionServerSequence(session),
        idempotencyKey: `agent-turn:${trainingCase.id}:${trigger.sequence}`,
      });
      onSession(mergeServerSession(session, result.session));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent 对话启动失败');
    } finally {
      setStarting(false);
      onCommandPendingChange?.(false);
    }
  };

  useEffect(() => {
    if (
      turns.length > 0
      || !runtime.runAgentTurn
      || !trigger
      || suspended
      || startedCases.current.has(startKey)
    ) return;
    void requestTurn();
  }, [runtime.runAgentTurn, startKey, suspended, trigger?.id, turns.length]);

  const submit = async (turn: AgentTurnCompletedEvent) => {
    const value = drafts[turn.turnId]?.trim() ?? '';
    if (!value || !runtime.submitAgentAnswer || busyTurnId) return;
    setBusyTurnId(turn.turnId);
    onCommandPendingChange?.(true);
    setError(null);
    try {
      const result = await runtime.submitAgentAnswer({
        session,
        sessionId: session.id,
        turnId: turn.turnId,
        answer: { format: 'text', value },
        expectedSequence: sessionServerSequence(session),
        idempotencyKey: `agent-answer:${turn.turnId}`,
      });
      onSession(mergeServerSession(session, result.session));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '作答提交失败，请重试。');
    } finally {
      setBusyTurnId(null);
      onCommandPendingChange?.(false);
    }
  };

  return (
    <section className="agent-chat ds-frame ds-frame--secondary" aria-labelledby="agent-chat-title">
      <header className="agent-chat__header">
        <span className="agent-chat__identity">
          <Bot aria-hidden="true" />
          <strong id="agent-chat-title">Agent 对话</strong>
        </span>
        <small>{fallback ? '降级' : turns.length > 0 ? '进行中' : '准备中'}</small>
      </header>

      {fallback ? (
        <div className="agent-chat__degraded" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>Agent 通道已降级</strong>
            继续使用下方现有确定性训练流程，本区暂不接收作答。
          </span>
        </div>
      ) : null}

      {!runtime.runAgentTurn && turns.length === 0 ? (
        <p className="agent-chat__unavailable">
          Agent 通道暂不可用，请继续使用下方现有确定性训练流程。
        </p>
      ) : null}
      {runtime.runAgentTurn && !trigger && turns.length === 0 ? (
        <p className="agent-chat__unavailable">
          完成一项课程作答后，Agent 对话会在这里开始。
        </p>
      ) : null}
      {starting ? (
        <p className="agent-chat__pending" role="status">
          <LoaderCircle aria-hidden="true" />Agent 正在准备下一步
        </p>
      ) : null}

      <div className="agent-chat__thread">
        {turns.map((turn) => {
          const answer = answers.get(turn.turnId);
          const canAnswer = activeTurn?.turnId === turn.turnId
            && turn.source !== 'fallback'
            && Boolean(runtime.submitAgentAnswer);
          return (
            <article className="agent-chat__turn" key={turn.turnId}>
              {turn.orderedActions.map((action) => {
                if (action.name === 'ask_student') {
                  return (
                    <p className="agent-chat__bubble agent-chat__bubble--agent" key={action.callId}>
                      {action.arguments.text}
                    </p>
                  );
                }
                if (action.name === 'present_question') {
                  const question = questionPresentation(
                    trainingCase,
                    action.arguments.questionId,
                  );
                  return (
                    <section className="agent-chat__question" key={action.callId}>
                      <span>题卡</span>
                      <strong>{question.prompt}</strong>
                    </section>
                  );
                }
                if (action.name === 'present_material') {
                  const material = trainingCase.materials.find(
                    (entry) => entry.id === action.arguments.materialId,
                  );
                  return (
                    <figure className="agent-chat__material" key={action.callId}>
                      {material?.materialRef ? (
                        <img
                          alt={`${trainingCase.title} ${
                            material.kind === 'cross-section' ? '结构剖面图' : '装置简图'
                          }`}
                          src={`/${material.materialRef}`}
                        />
                      ) : <FileImage aria-hidden="true" />}
                      <figcaption>
                        {material?.kind === 'cross-section' ? '结构剖面' : '装置素材'}
                      </figcaption>
                    </figure>
                  );
                }
                if (action.name === 'end_session') {
                  return (
                    <section className="agent-chat__summary" key={action.callId}>
                      <span>本次小结</span>
                      <p>{action.arguments.summary}</p>
                    </section>
                  );
                }
                return null;
              })}

              {answer ? (
                <p className="agent-chat__bubble agent-chat__bubble--student">
                  {answerText(answer)}
                </p>
              ) : null}

              {canAnswer ? (() => {
                const terminal = turn.orderedActions.find(
                  (action) => action.callId === turn.terminalAction.callId,
                );
                const question = terminal?.name === 'present_question'
                  ? questionPresentation(trainingCase, terminal.arguments.questionId)
                  : null;
                const textareaId = `agent-chat-answer-${turn.turnId}`;
                return (
                  <div className="agent-chat__composer">
                    <label htmlFor={textareaId}>
                      {question?.prompt ?? '回答 Agent'}
                    </label>
                    {question?.equation ? (
                      <EquationToolbar
                        textareaId={textareaId}
                        value={drafts[turn.turnId] ?? ''}
                        onChange={(value) => setDrafts((current) => ({
                          ...current,
                          [turn.turnId]: value,
                        }))}
                      />
                    ) : null}
                    <textarea
                      aria-label={question?.prompt ?? '回答 Agent'}
                      id={textareaId}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [turn.turnId]: event.target.value,
                      }))}
                      placeholder="输入你的回答…"
                      rows={question?.equation ? 2 : 3}
                      value={drafts[turn.turnId] ?? ''}
                    />
                    <button
                      className="agent-chat__submit"
                      disabled={busyTurnId === turn.turnId || !drafts[turn.turnId]?.trim()}
                      onClick={() => void submit(turn)}
                      type="button"
                    >
                      {busyTurnId === turn.turnId
                        ? <LoaderCircle aria-hidden="true" />
                        : <Send aria-hidden="true" />}
                      提交给 Agent
                    </button>
                  </div>
                );
              })() : null}
            </article>
          );
        })}
      </div>

      {error ? (
        <div className="agent-chat__error" role="alert">
          <span>{error}</span>
          {turns.length === 0 && runtime.runAgentTurn && trigger ? (
            <button onClick={() => void requestTurn()} type="button">重试</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
