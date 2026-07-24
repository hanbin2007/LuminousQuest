import {
  AlertTriangle,
  Bot,
  FileImage,
  LoaderCircle,
  Play,
  Send,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { LoadedConfig, CaseConfig } from '../../../shared/config/schemas';
import type { AgentResponseBoard } from '../../../shared/agent/contracts';
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
  level?: number;
  onSession: (session: StudentSession) => void;
  onCommandPendingChange?: (pending: boolean) => void;
  completionAction?: {
    label: string;
    onClick: () => void;
  };
  suspended?: boolean;
}

type AgentAnswerEvent = Extract<
  StudentSession['events'][number],
  { kind: 'answer.submitted' }
>;

function questionPresentation(
  config: LoadedConfig,
  trainingCase: CaseConfig,
  questionId: string,
  level: number,
) {
  if (questionId === `${trainingCase.id}:analysis`) {
    const effectiveLevel = trainingCase.caseType === 'transfer' ? 3 : level;
    const scaffold = trainingCase.scaffold.find((entry) => entry.level === effectiveLevel)
      ?? trainingCase.scaffold.find((entry) => entry.level === 3)
      ?? trainingCase.scaffold[0]!;
    if (scaffold.level === 1) {
      return {
        prompt: `请结合“${trainingCase.title}”逐项完成分析。`,
        details: scaffold.fields.map((field) => field.prompt),
        equation: false,
        board: {
          kind: 'fill-blank',
          placeholder: '关键词或短语',
          maxLength: 80,
        } satisfies AgentResponseBoard,
      };
    }
    if (scaffold.level === 2) {
      return {
        prompt: `请结合“${trainingCase.title}”完成三维分析。`,
        details: scaffold.dimensionIds.map((dimensionId) => {
          const label = config.knowledgeModel.dimensions.find(
            (dimension) => dimension.id === dimensionId,
          )?.label ?? dimensionId;
          return `从${label}维度说明你的判断及依据。`;
        }),
        equation: false,
        board: {
          kind: 'fill-blank',
          placeholder: '关键词或短语',
          maxLength: 80,
        } satisfies AgentResponseBoard,
      };
    }
    return {
      prompt: scaffold.prompt,
      details: [],
      equation: false,
      board: {
        kind: 'fill-blank',
        placeholder: '关键词或短语',
        maxLength: 80,
      } satisfies AgentResponseBoard,
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
      details: [],
      equation: true,
      board: {
        kind: 'fill-blank',
        placeholder: '填写方程式',
        maxLength: 80,
      } satisfies AgentResponseBoard,
    };
  }
  const pretestQuestion = config.pretest.questions.find((question) =>
    question.id === questionId);
  if (pretestQuestion?.type === 'choice') {
    return {
      prompt: pretestQuestion.prompt,
      details: [],
      equation: false,
      board: {
        kind: 'choice',
        options: pretestQuestion.options.map((option) => ({
          id: option.id,
          label: option.text,
        })),
      } satisfies AgentResponseBoard,
    };
  }
  return {
    prompt: pretestQuestion?.prompt ?? questionId,
    details: [],
    equation: false,
    board: {
      kind: 'fill-blank',
      placeholder: '关键词或短语',
      maxLength: 80,
    } satisfies AgentResponseBoard,
  };
}

function answerText(event: AgentAnswerEvent) {
  if (event.answer.format === 'text') return event.answer.value;
  if (event.answer.format === 'choice') return event.answer.optionId;
  if (event.answer.format === 'equation') return event.answer.value;
  if (event.answer.format === 'canvas') return '已提交画布作答';
  return `已提交装置图：${event.answer.value.components.length} 个元件`;
}

function turnResponseBoard(
  turn: AgentTurnCompletedEvent,
  config: LoadedConfig,
  trainingCase: CaseConfig,
  level: number,
) {
  const terminal = turn.orderedActions.find(
    (action) => action.callId === turn.terminalAction.callId,
  );
  if (terminal?.name === 'ask_student') {
    return terminal.arguments.board ?? {
      kind: 'fill-blank' as const,
      placeholder: '关键词或短语',
      maxLength: 80,
    };
  }
  if (terminal?.name === 'present_question') {
    return questionPresentation(
      config,
      trainingCase,
      terminal.arguments.questionId,
      level,
    ).board;
  }
  if (terminal?.name === 'show_question_card') return terminal.arguments.board;
  return null;
}

export function agentTurnTriggerForCase(
  session: StudentSession,
  caseId: string,
) {
  const learnerVisible = [...session.events].reverse().filter((event) =>
    event.kind !== 'session.command.executed'
    && !event.kind.startsWith('agent.')
    && event.kind !== 'assessment.audit.completed'
    && event.kind !== 'assessment.divergence.changed');
  return learnerVisible.find((event) => event.caseId === caseId)
    ?? learnerVisible[0];
}

function agentFailureLabel(category?: string) {
  switch (category) {
    case 'timeout':
      return '模型响应超时';
    case 'provider-error':
    case 'provider-unavailable':
    case 'http-error':
      return '在线模型暂时不可用';
    case 'budget-exceeded':
      return '当前学习记录超过了安全上下文预算';
    case 'max-turns':
    case 'missing-terminal-tool':
    case 'invalid-provider-response':
    case 'tool-execution-error':
      return '模型响应未通过 Agent 工具协议';
    default:
      return '在线模型调用失败';
  }
}

export function AgentChat({
  config,
  runtime,
  session,
  trainingCase,
  level = 1,
  onSession,
  onCommandPendingChange,
  completionAction,
  suspended = false,
}: AgentChatProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyTurnId, setBusyTurnId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allTurns = useMemo(() => session.events.filter(
    (event): event is AgentTurnCompletedEvent =>
      event.kind === 'agent.turn.completed',
  ), [session.events]);
  const turns = useMemo(() => allTurns.filter(
    (event) => event.caseId === trainingCase.id,
  ), [allTurns, trainingCase.id]);
  const latestTurn = turns.at(-1);
  const answers = useMemo(() => new Map(session.events
    .filter((event): event is AgentAnswerEvent =>
      event.kind === 'answer.submitted' && Boolean(event.responseToAgentTurnId))
    .map((event) => [event.responseToAgentTurnId!, event])), [session.events]);
  const activeTurn = [...turns].reverse().find((turn) =>
    (turn.terminalAction.name === 'ask_student'
      || turn.terminalAction.name === 'present_question'
      || turn.terminalAction.name === 'show_question_card')
    && !answers.has(turn.turnId));
  const pendingInput = [...session.events].reverse().find((event) =>
    event.kind === 'agent.input.pending'
    && event.caseId === trainingCase.id
    && !allTurns.some((turn) => turn.turnId === event.turnId));
  const pendingAnswer = pendingInput?.kind === 'agent.input.pending'
    ? session.events.find((event): event is AgentAnswerEvent =>
        event.kind === 'answer.submitted'
        && event.id === pendingInput.triggerEventId
        && Boolean(event.responseToAgentTurnId))
    : undefined;
  const fallback = latestTurn?.source === 'fallback';
  const ended = latestTurn?.terminalAction.name === 'end_session'
    || latestTurn?.terminalAction.name === 'end_case';
  const trigger = agentTurnTriggerForCase(session, trainingCase.id);
  const retryAttempt = trigger
    ? turns.filter((turn) =>
      turn.source === 'fallback'
      && turn.triggerEventId === trigger.id).length
    : 0;

  const requestTurn = async () => {
    if (!runtime.runAgentTurn || !trigger || starting || suspended) return;
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
        idempotencyKey:
          `agent-turn:${trainingCase.id}:${trigger.sequence}:attempt-${retryAttempt}`,
      });
      onSession(mergeServerSession(session, result.session));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent 对话启动失败');
    } finally {
      setStarting(false);
      onCommandPendingChange?.(false);
    }
  };

  const submit = async (turn: AgentTurnCompletedEvent) => {
    const value = drafts[turn.turnId]?.trim() ?? '';
    if (!value || !runtime.submitAgentAnswer || busyTurnId) return;
    setBusyTurnId(turn.turnId);
    onCommandPendingChange?.(true);
    setError(null);
    try {
      const board = turnResponseBoard(turn, config, trainingCase, level);
      const answer = board?.kind === 'choice' || board?.kind === 'single-choice'
        ? { format: 'choice' as const, optionId: value }
        : board?.kind === 'equation-fill'
          ? { format: 'equation' as const, value }
          : { format: 'text' as const, value };
      const result = await runtime.submitAgentAnswer({
        session,
        sessionId: session.id,
        turnId: turn.turnId,
        answer,
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

  const retryPendingAnswer = async () => {
    if (
      !pendingAnswer?.responseToAgentTurnId
      || !runtime.submitAgentAnswer
      || busyTurnId
    ) return;
    setBusyTurnId(pendingAnswer.responseToAgentTurnId);
    onCommandPendingChange?.(true);
    setError(null);
    try {
      const result = await runtime.submitAgentAnswer({
        session,
        sessionId: session.id,
        turnId: pendingAnswer.responseToAgentTurnId,
        answer: pendingAnswer.answer,
        expectedSequence: sessionServerSequence(session),
        idempotencyKey: `agent-answer:${pendingAnswer.responseToAgentTurnId}`,
      });
      onSession(mergeServerSession(session, result.session));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent 恢复失败，请重试。');
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
          <span>
            <strong id="agent-chat-title">Agent 对话</strong>
            <small>{trainingCase.title}</small>
          </span>
        </span>
        <small>{starting
          ? '连接中'
          : fallback ? '需重试' : ended ? '本案例完成' : turns.length > 0 ? '进行中' : '待开始'}</small>
      </header>

      {fallback ? (
        <div className="agent-chat__degraded" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>Agent 通道本轮未响应</strong>
            已自动尝试 {latestTurn?.providerAttempts ?? 1} 次，
            {agentFailureLabel(latestTurn?.failureCategory)}。
            本轮没有采用预设问题代替 Agent。请重新连接后继续对话。
          </span>
          {runtime.runAgentTurn && trigger ? (
            <button
              disabled={starting || suspended}
              onClick={() => void requestTurn()}
              type="button"
            >
              重新连接
            </button>
          ) : null}
        </div>
      ) : null}
      {!fallback && pendingInput ? (
        <div className="agent-chat__degraded" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>Agent 上一轮尚未完成</strong>
            已保留题卡和作答记录，可以从持久化会话继续。
          </span>
          <button
            disabled={starting || Boolean(busyTurnId) || suspended}
            onClick={() => void (
              pendingAnswer ? retryPendingAnswer() : requestTurn()
            )}
            type="button"
          >
            继续本轮
          </button>
        </div>
      ) : null}

      {!runtime.runAgentTurn && turns.length === 0 ? (
        <p className="agent-chat__unavailable">
          Agent 通道暂不可用，请稍后重试。
        </p>
      ) : null}
      {runtime.runAgentTurn && !trigger && turns.length === 0 ? (
        <p className="agent-chat__unavailable">
          请先完成前测；进入训练后，可手动开始 Agent 对话。
        </p>
      ) : null}
      {starting ? (
        <p className="agent-chat__pending" role="status">
          <LoaderCircle aria-hidden="true" />Agent 正在读取当前案例与学习记录
        </p>
      ) : null}

      <div className="agent-chat__thread">
        {runtime.runAgentTurn
        && trigger
        && turns.length === 0
        && !starting
        && !error
        && !pendingInput ? (
          <div className="agent-chat__start">
            <p>题目与前测记录已经就绪。</p>
            <button
              className="primary-button"
              disabled={suspended}
              onClick={() => void requestTurn()}
              type="button"
            >
              <Play aria-hidden="true" />开始 Agent 对话
            </button>
          </div>
        ) : null}
        {turns.filter((turn) => turn.source !== 'fallback').map((turn) => {
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
                if (action.name === 'show_question_card') {
                  return (
                    <section className="agent-chat__question" key={action.callId}>
                      <span>Agent 题卡</span>
                      <strong>{action.arguments.text}</strong>
                    </section>
                  );
                }
                if (action.name === 'present_question') {
                  const question = questionPresentation(
                    config,
                    trainingCase,
                    action.arguments.questionId,
                    level,
                  );
                  return (
                    <section className="agent-chat__question" key={action.callId}>
                      <span>题卡</span>
                      <strong>{question.prompt}</strong>
                      {question.details.length > 0 ? (
                        <ol>
                          {question.details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ol>
                      ) : null}
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
                if (action.name === 'show_case_material') {
                  const material = trainingCase.materials.find(
                    (entry) => entry.id === action.arguments.materialId,
                  );
                  return (
                    <figure className="agent-chat__material" key={action.callId}>
                      {material?.materialRef ? (
                        <img
                          alt={`${trainingCase.title}案例材料`}
                          src={`/${material.materialRef}`}
                        />
                      ) : <FileImage aria-hidden="true" />}
                      <figcaption>
                        {material?.kind === 'cross-section' ? '结构剖面' : '案例材料'}
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
                if (action.name === 'end_case') {
                  return (
                    <section className="agent-chat__summary" key={action.callId}>
                      <span>本案例小结</span>
                      <p>{action.arguments.summary}</p>
                    </section>
                  );
                }
                return null;
              })}

              {answer ? (
                <p className="agent-chat__bubble agent-chat__bubble--student">
                  {(() => {
                    const board = turnResponseBoard(turn, config, trainingCase, level);
                    if (
                      (answer.answer.format === 'text' || answer.answer.format === 'choice')
                      && (board?.kind === 'choice' || board?.kind === 'single-choice')
                    ) {
                      const optionId = answer.answer.format === 'choice'
                        ? answer.answer.optionId
                        : answer.answer.value;
                      return board.options.find(
                        (option) => option.id === optionId,
                      )?.label ?? answerText(answer);
                    }
                    return answerText(answer);
                  })()}
                </p>
              ) : null}

              {canAnswer ? (() => {
                const terminal = turn.orderedActions.find(
                  (action) => action.callId === turn.terminalAction.callId,
                );
                const question = terminal?.name === 'present_question'
                  ? questionPresentation(
                    config,
                    trainingCase,
                    terminal.arguments.questionId,
                    level,
                  )
                  : null;
                const visiblePrompt = terminal?.name === 'show_question_card'
                  ? terminal.arguments.text
                  : question?.prompt;
                const textareaId = `agent-chat-answer-${turn.turnId}`;
                const board = turnResponseBoard(turn, config, trainingCase, level);
                return (
                  <div className="agent-chat__composer">
                    <label htmlFor={textareaId}>
                      {board?.kind === 'choice' || board?.kind === 'single-choice'
                        ? '选择一个回答'
                        : '填写简短答案'}
                    </label>
                    {question?.equation || board?.kind === 'equation-fill' ? (
                      <EquationToolbar
                        textareaId={textareaId}
                        value={drafts[turn.turnId] ?? ''}
                        onChange={(value) => setDrafts((current) => ({
                          ...current,
                          [turn.turnId]: value,
                        }))}
                      />
                    ) : null}
                    {board?.kind === 'choice' || board?.kind === 'single-choice' ? (
                      <fieldset
                        aria-label={visiblePrompt ?? '回答 Agent'}
                        className="agent-chat__choice-board"
                      >
                        {board.options.map((option) => (
                          <label key={option.id}>
                            <input
                              checked={drafts[turn.turnId] === option.id}
                              name={`agent-response-${turn.turnId}`}
                              onChange={() => setDrafts((current) => ({
                                ...current,
                                [turn.turnId]: option.id,
                              }))}
                              type="radio"
                              value={option.id}
                            />
                            <span>{option.label}</span>
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      <input
                        aria-label={visiblePrompt ?? '回答 Agent'}
                        autoComplete="off"
                        id={textareaId}
                        maxLength={
                          board?.kind === 'fill-blank' || board?.kind === 'short-fill'
                            ? board.maxLength
                            : 80
                        }
                        onChange={(event) => setDrafts((current) => ({
                          ...current,
                          [turn.turnId]: event.target.value,
                        }))}
                        placeholder={
                          board && 'placeholder' in board
                            ? board.placeholder
                            : '关键词或短语'
                        }
                        type="text"
                        value={drafts[turn.turnId] ?? ''}
                      />
                    )}
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

      {ended && completionAction ? (
        <footer className="agent-chat__completion">
          <button
            className="primary-button"
            onClick={completionAction.onClick}
            type="button"
          >
            {completionAction.label}
          </button>
        </footer>
      ) : null}
    </section>
  );
}
