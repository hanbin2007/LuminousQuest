import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { recordBuilderAssessment } from '../../../shared/workflows/engine-assessment';
import { appendSessionEvent } from '../../../shared/session/session';
import type { StudentSession } from '../../../shared/session/schema';
import { useAppContext } from '../../app/AppContext';
import { pretestStepPath, resolvePretestStep } from '../../app/route-config';
import { getWorkspaceStorage } from '../../persistence/workspace-storage';
import type { BuilderAnswer } from '../builder/TopologyBuilder';
import { TopologyBuilder } from '../builder/TopologyBuilder';
import { DiagnosisView } from '../diagnosis/DiagnosisView';
import { HandDrawingPanel } from './HandDrawingPanel';
import { QuestionCard } from './QuestionCard';
import { mergeServerSession } from './session-merge';
import {
  loadPretestDraft,
  savePretestDraft,
  type PretestDraft,
} from './draft';

const pretestTimerSeconds = 45;

function appendUnassessedTextAnswer(
  session: StudentSession,
  questionId: string,
  answer: string,
) {
  const count = session.events.filter((event) =>
    event.kind === 'answer.submitted' && event.questionId === questionId).length;
  return appendSessionEvent(session, {
    id: `answer-local-${crypto.randomUUID()}`,
    occurredAt: new Date().toISOString(),
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'pretest',
    stageId: 'assessment-local',
    attemptId: `${questionId}-${count + 1}`,
    questionId,
    answer: { format: 'text', value: answer },
  });
}

export function PretestPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const {
    config,
    runtime,
    session,
    setSession,
    setPretestComplete,
  } = useAppContext();
  const [draft, setDraft] = useState<PretestDraft>(() =>
    loadPretestDraft(getWorkspaceStorage(), session.id, config.pretest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(pretestTimerSeconds);
  const submissionIds = useRef(new Map<string, string>());
  const questionCount = config.pretest.questions.length;
  const drawingStep = questionCount + 1;
  const diagnosisStep = questionCount + 2;
  const maxStep = diagnosisStep;
  const activeQuestion = draft.step > 0 && draft.step <= questionCount
    ? config.pretest.questions[draft.step - 1]
    : null;

  useEffect(() => {
    setDraft(loadPretestDraft(getWorkspaceStorage(), session.id, config.pretest));
  }, [config.pretest, session.id]);

  useEffect(() => {
    try {
      savePretestDraft(getWorkspaceStorage(), session.id, draft);
    } catch {
      setError('草稿保存失败，请导出会话。');
    }
    setPretestComplete(draft.step >= diagnosisStep);
  }, [diagnosisStep, draft, session.id, setPretestComplete]);

  const stepLabels = useMemo(() => [
    '搭建通用模型',
    ...config.pretest.questions.map((_, index) => `题目 ${index + 1}`),
    '手绘彩蛋',
  ], [config.pretest.questions]);

  const goToStep = (step: number, replace = false) => {
    const target = Math.max(0, Math.min(maxStep, step));
    setDraft((current) => current.step === target ? current : { ...current, step: target });
    navigate(pretestStepPath(config, target), { replace });
  };
  const advance = () => goToStep(draft.step + 1);
  const goPrevious = () => goToStep(draft.step - 1);
  const skipQuestion = () => {
    if (!activeQuestion) return;
    setDraft((current) => {
      const answers = { ...current.answers };
      delete answers[activeQuestion.id];
      return {
        ...current,
        answers,
        step: Math.min(maxStep, current.step + 1),
      };
    });
    navigate(pretestStepPath(config, Math.min(maxStep, draft.step + 1)));
  };

  const submittedQuestionIds = useMemo(() => new Set(
    session.events
      .filter((event) => event.kind === 'answer.submitted')
      .map((event) => event.questionId),
  ), [session.events]);
  const stepAnswered = (index: number) => {
    if (index === 0) return submittedQuestionIds.has('pretest-builder');
    if (index <= questionCount) {
      const question = config.pretest.questions[index - 1];
      return submittedQuestionIds.has(question.id)
        || Boolean(draft.answers[question.id]?.trim());
    }
    return draft.step > drawingStep;
  };

  useEffect(() => {
    setSecondsLeft(pretestTimerSeconds);
    if (!activeQuestion) return undefined;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeQuestion]);

  useEffect(() => {
    const routeStep = resolvePretestStep(config, pathname);
    if (pathname === '/pretest' || routeStep === null) {
      navigate(pretestStepPath(config, draft.step), { replace: true });
      return;
    }
    setDraft((current) => current.step === routeStep ? current : { ...current, step: routeStep });
  }, [config, navigate, pathname]);

  const submitQuestion = async (answer: string) => {
    if (!activeQuestion) return;
    setError(null);
    const submissionKey = `${activeQuestion.id}\0${answer}`;
    const submissionId = submissionIds.current.get(submissionKey) ?? crypto.randomUUID();
    submissionIds.current.set(submissionKey, submissionId);
    setBusy(true);
    try {
      if (activeQuestion.type === 'choice') {
        const result = await runtime.assessChoice({
          sessionId: session.id,
          questionId: activeQuestion.id,
          optionId: answer,
          submissionId,
        });
        if (result.session) setSession(mergeServerSession(session, result.session));
      } else {
        const result = await runtime.extractAssessment({
          sessionId: session.id,
          questionId: activeQuestion.id,
          targetNodeIds: [...activeQuestion.targetNodeIds],
          studentAnswer: answer,
          submissionId,
        });
        if (result.session) {
          setSession(mergeServerSession(session, result.session));
        } else {
          setSession(appendUnassessedTextAnswer(session, activeQuestion.id, answer));
        }
      }
      submissionIds.current.delete(submissionKey);
      advance();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '判分请求失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const timerText = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const timerProgress = `${(secondsLeft / pretestTimerSeconds) * 100}%`;

  return (
    <main className={`page-content pretest-page${draft.step === 0 ? ' pretest-page--bench' : ''}`}>
      <header className="visually-hidden">
        <h1>前测诊断</h1>
      </header>
      <div className="pretest-timer-track" aria-hidden="true">
        <span
          data-low={secondsLeft <= 10 || undefined}
          style={{ width: timerProgress }}
        />
      </div>
      <time
        aria-label={`本题剩余时间 ${timerText}`}
        className="pretest-timer"
        data-low={secondsLeft <= 10 || undefined}
      >
        {timerText}
      </time>
      <ol className="pretest-steps" aria-label="前测步骤">
        {stepLabels.map((label, index) => {
          const answered = stepAnswered(index);
          return (
          <li
            key={label}
            aria-current={index === draft.step ? 'step' : undefined}
            data-answered={answered || undefined}
          >
            <button
              aria-label={`跳转到${label}，${answered ? '已作答' : '未作答'}`}
              onClick={() => goToStep(index)}
              title={`${label} · ${answered ? '已作答' : '未作答'}`}
              type="button"
            >
              {String(index).padStart(2, '0')}
            </button>
          </li>
          );
        })}
      </ol>

      <div className="pretest-stage">
      <div
        className={`step-content step-content--${draft.step === 0
          ? 'builder'
          : activeQuestion
            ? 'question'
            : draft.step === drawingStep
              ? 'drawing'
              : 'diagnosis'}`}
        key={draft.step}
      >
      {draft.step === 0 ? (
        <section className="builder-section" aria-labelledby="builder-title">
          <header>
            <span>00 / {String(questionCount).padStart(2, '0')} · 通用模型</span>
            <h2 id="builder-title">{config.pretest.builder.prompt}</h2>
          </header>
          <TopologyBuilder
            config={config.pretest.builder}
            initialValue={draft.builder}
            onChange={(builder) => setDraft((current) => ({ ...current, builder }))}
            onSubmit={(builder) => {
              const normalizedBuilder = {
                components: builder.components.map((component) => ({
                  instanceId: component.instanceId,
                  componentId: component.componentId,
                  x: component.x,
                  y: component.y,
                  ...(component.label ? { label: component.label } : {}),
                  ...(component.assignedRole ? { assignedRole: component.assignedRole } : {}),
                  ...(component.materialBinding ? { materialBinding: component.materialBinding } : {}),
                })),
                connections: builder.connections.map((connection) => ({
                  id: connection.id,
                  from: connection.from,
                  to: connection.to,
                  kind: connection.kind,
                  ...(connection.carrier ? { carrier: connection.carrier } : {}),
                })),
              };
              const count = session.events.filter((event) =>
                event.kind === 'answer.submitted' && event.questionId === 'pretest-builder').length;
              const occurredAt = new Date().toISOString();
              const result = recordBuilderAssessment({
                session,
                config,
                answer: {
                  id: `answer-builder-${crypto.randomUUID()}`,
                  occurredAt,
                  caseId: 'pretest',
                  stageId: 'assessment',
                  attemptId: `builder-${count + 1}`,
                  questionId: 'pretest-builder',
                  value: normalizedBuilder,
                },
                assistance: { kind: 'none', rounds: 0 },
                assessmentEventIdPrefix: `assessment-builder-${crypto.randomUUID()}`,
                assessedAt: occurredAt,
              });
              setSession(result.session);
              advance();
            }}
          />
        </section>
      ) : null}

      {activeQuestion ? (
        <QuestionCard
          key={activeQuestion.id}
          question={activeQuestion}
          dimensionLabel={config.knowledgeModel.dimensions.find((dimension) =>
            dimension.id === activeQuestion.dimensionId)?.label ?? activeQuestion.dimensionId}
          answer={draft.answers[activeQuestion.id]}
          busy={busy}
          questionIndex={draft.step}
          questionTotal={questionCount}
          onAnswerChange={(value) => setDraft((current) => ({
            ...current,
            answers: { ...current.answers, [activeQuestion.id]: value },
          }))}
          onPrevious={goPrevious}
          onSkip={skipQuestion}
          onSubmit={submitQuestion}
        />
      ) : null}

      {draft.step === drawingStep ? (
        <HandDrawingPanel
          onReview={runtime.reviewDrawing}
          onFinish={() => goToStep(diagnosisStep)}
        />
      ) : null}

      {draft.step >= diagnosisStep ? <DiagnosisView config={config} session={session} /> : null}
      </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </main>
  );
}
