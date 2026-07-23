import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { recordBuilderAssessment } from '../../../shared/workflows/engine-assessment';
import { appendSessionEvent } from '../../../shared/session/session';
import type { StudentSession } from '../../../shared/session/schema';
import { sessionServerSequence } from '../../../shared/session/sync';
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
import {
  hasVisibleAnswer,
  resolveOriginalExamChoice,
} from './exam-flow';

const pretestTimerSeconds = 45;
const groupedPretestTimerSeconds = 180;

interface PretestNavigationStep {
  key: string;
  label: string;
  steps: number[];
  kind: 'builder' | 'question' | 'group' | 'drawing';
}

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
  const questionAnswered = (questionId: string) => {
    return submittedQuestionIds.has(questionId)
      || hasVisibleAnswer(draft.answers[questionId] ?? '');
  };

  const navigationSteps = useMemo(() => {
    const items: PretestNavigationStep[] = [{
      key: 'builder',
      label: '搭建通用模型',
      steps: [0],
      kind: 'builder',
    }];
    const seenGroups = new Set<string>();
    let standaloneNumber = 0;

    config.pretest.questions.forEach((question, index) => {
      const step = index + 1;
      if (question.group) {
        if (seenGroups.has(question.group.id)) return;
        seenGroups.add(question.group.id);
        items.push({
          key: `group:${question.group.id}`,
          label: question.group.title,
          steps: config.pretest.questions
            .map((candidate, candidateIndex) =>
              candidate.group?.id === question.group?.id ? candidateIndex + 1 : null)
            .filter((candidateStep): candidateStep is number => candidateStep !== null),
          kind: 'group',
        });
        return;
      }

      standaloneNumber += 1;
      items.push({
        key: `question:${question.id}`,
        label: `题目 ${standaloneNumber}`,
        steps: [step],
        kind: 'question',
      });
    });

    items.push({
      key: 'drawing',
      label: '手绘彩蛋',
      steps: [drawingStep],
      kind: 'drawing',
    });
    return items;
  }, [config.pretest.questions, drawingStep]);

  const navigationAnswered = (item: PretestNavigationStep) => {
    if (item.kind === 'builder') return submittedQuestionIds.has('pretest-builder');
    if (item.kind === 'drawing') return draft.step > drawingStep;
    return item.steps.every((step) => {
      const question = config.pretest.questions[step - 1];
      return question ? questionAnswered(question.id) : false;
    });
  };

  const navigationTarget = (item: PretestNavigationStep) => {
    if (item.kind !== 'group') return item.steps[0] ?? 0;
    return item.steps.find((step) => {
      const question = config.pretest.questions[step - 1];
      return question ? !questionAnswered(question.id) : false;
    }) ?? item.steps[0] ?? 0;
  };

  const activeGroupQuestions = useMemo(() => {
    if (!activeQuestion?.group) return [];
    return config.pretest.questions.filter((question) =>
      question.group?.id === activeQuestion.group?.id);
  }, [activeQuestion, config.pretest.questions]);
  const activeTimerKey = activeQuestion?.group?.id ?? activeQuestion?.id ?? null;
  const timerDuration = activeQuestion?.group
    ? groupedPretestTimerSeconds
    : pretestTimerSeconds;

  useEffect(() => {
    setSecondsLeft(timerDuration);
    if (!activeTimerKey) return undefined;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeTimerKey, timerDuration]);

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
    const choiceAnswer = activeQuestion.type === 'choice'
      ? resolveOriginalExamChoice(activeQuestion.id, answer)
      : null;
    if (activeQuestion.type === 'choice' && choiceAnswer === null) {
      setError('请按题目要求填写完整答案。');
      return;
    }
    const submissionKey = `${activeQuestion.id}\0${answer}`;
    const submissionId = submissionIds.current.get(submissionKey) ?? crypto.randomUUID();
    submissionIds.current.set(submissionKey, submissionId);
    setBusy(true);
    try {
      if (activeQuestion.type === 'choice') {
        const result = await runtime.assessChoice({
          sessionId: session.id,
          expectedSequence: sessionServerSequence(session),
          idempotencyKey: submissionId,
          questionId: activeQuestion.id,
          optionId: choiceAnswer ?? answer,
          submissionId,
        });
        if (result.session) setSession(mergeServerSession(session, result.session));
      } else {
        const result = await runtime.extractAssessment({
          sessionId: session.id,
          expectedSequence: sessionServerSequence(session),
          idempotencyKey: submissionId,
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
  const timerProgress = `${(secondsLeft / timerDuration) * 100}%`;

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
        aria-label={`${activeQuestion?.group ? '本大题' : '本题'}剩余时间 ${timerText}`}
        className="pretest-timer"
        data-low={secondsLeft <= 10 || undefined}
      >
        {timerText}
      </time>
      <ol className="pretest-steps" aria-label="前测步骤">
        {navigationSteps.map((item, index) => {
          const answered = navigationAnswered(item);
          const current = item.steps.includes(draft.step);
          return (
          <li
            key={item.key}
            aria-current={current ? 'step' : undefined}
            data-answered={answered || undefined}
          >
            <button
              aria-label={`跳转到${item.label}，${answered ? '已作答' : '未作答'}`}
              onClick={() => goToStep(navigationTarget(item))}
              title={`${item.label} · ${answered ? '已作答' : '未作答'}`}
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
        key={activeQuestion?.group?.id ?? draft.step}
      >
      {draft.step === 0 ? (
        <section className="builder-section" aria-labelledby="builder-title">
          <header>
            <span>00 / {String(navigationSteps.length - 2).padStart(2, '0')} · 通用模型</span>
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
          key={activeQuestion.group?.id ?? activeQuestion.id}
          question={activeQuestion}
          dimensionLabel={config.knowledgeModel.dimensions.find((dimension) =>
            dimension.id === activeQuestion.dimensionId)?.label ?? activeQuestion.dimensionId}
          answer={draft.answers[activeQuestion.id]}
          busy={busy}
          groupProgress={activeGroupQuestions.length > 0
            ? activeGroupQuestions.map((question, index) => ({
              id: question.id,
              label: `1-${index + 1}`,
              answered: questionAnswered(question.id),
              current: question.id === activeQuestion.id,
            }))
            : undefined}
          questionIndex={draft.step}
          questionTotal={questionCount}
          onAnswerChange={(value) => setDraft((current) => ({
            ...current,
            answers: { ...current.answers, [activeQuestion.id]: value },
          }))}
          onPrevious={goPrevious}
          onGroupNavigate={(questionId) => {
            const questionIndex = config.pretest.questions.findIndex((question) =>
              question.id === questionId);
            if (questionIndex >= 0) goToStep(questionIndex + 1);
          }}
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
