import { useEffect, useMemo, useState } from 'react';

import { recordBuilderAssessment } from '../../../shared/workflows/engine-assessment';
import { appendSessionEvent } from '../../../shared/session/session';
import type { StudentSession } from '../../../shared/session/schema';
import { useAppContext } from '../../app/AppContext';
import type { BuilderAnswer } from '../builder/TopologyBuilder';
import { TopologyBuilder } from '../builder/TopologyBuilder';
import { DiagnosisView } from '../diagnosis/DiagnosisView';
import { recordChoiceAssessment } from './choice-assessment';
import { HandDrawingPanel } from './HandDrawingPanel';
import { QuestionCard } from './QuestionCard';
import { mergeServerSession } from './session-merge';

interface PretestDraft {
  step: number;
  builder: BuilderAnswer;
  answers: Record<string, string>;
}

const emptyDraft: PretestDraft = {
  step: 0,
  builder: { components: [], connections: [] },
  answers: {},
};

function draftStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadDraft(sessionId: string): PretestDraft {
  try {
    const source = draftStorage()?.getItem(`luminous-quest:pretest-ui.v1:${sessionId}`);
    if (!source) return emptyDraft;
    const value = JSON.parse(source) as Partial<PretestDraft>;
    return {
      step: typeof value.step === 'number' ? value.step : 0,
      builder: value.builder ?? emptyDraft.builder,
      answers: value.answers ?? {},
    };
  } catch {
    return emptyDraft;
  }
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
    caseId: 'zinc-copper',
    stageId: 'assessment-local',
    attemptId: `${questionId}-${count + 1}`,
    questionId,
    answer: { format: 'text', value: answer },
  });
}

export function PretestPage() {
  const {
    config,
    runtime,
    session,
    setSession,
    setPretestComplete,
  } = useAppContext();
  const [draft, setDraft] = useState<PretestDraft>(() => loadDraft(session.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questionCount = config.pretest.questions.length;
  const drawingStep = questionCount + 1;
  const diagnosisStep = questionCount + 2;
  const maxStep = diagnosisStep;
  const activeQuestion = draft.step > 0 && draft.step <= questionCount
    ? config.pretest.questions[draft.step - 1]
    : null;

  useEffect(() => {
    setDraft(loadDraft(session.id));
  }, [session.id]);

  useEffect(() => {
    draftStorage()?.setItem(`luminous-quest:pretest-ui.v1:${session.id}`, JSON.stringify(draft));
    setPretestComplete(draft.step >= diagnosisStep);
  }, [diagnosisStep, draft, session.id, setPretestComplete]);

  const stepLabels = useMemo(() => [
    '搭建通用模型',
    ...config.pretest.questions.map((question, index) => `题目 ${index + 1}`),
    '手绘彩蛋',
    '诊断结果',
  ], [config.pretest.questions]);

  const advance = () => setDraft((current) => ({ ...current, step: Math.min(maxStep, current.step + 1) }));

  const submitQuestion = async (answer: string) => {
    if (!activeQuestion) return;
    setError(null);
    if (activeQuestion.type === 'choice') {
      const result = recordChoiceAssessment({
        session,
        config,
        question: activeQuestion,
        optionId: answer,
      });
      setSession(result.session);
      advance();
      return;
    }

    setBusy(true);
    try {
      let merged = session;
      let receivedServerEvents = false;
      for (const nodeId of activeQuestion.targetNodeIds) {
        const result = await runtime.extractAssessment({
          sessionId: session.id,
          caseId: activeQuestion.referenceEquations[0]?.caseId ?? 'zinc-copper',
          nodeId,
          studentAnswer: answer,
        });
        if (result.session) {
          merged = mergeServerSession(merged, result.session);
          receivedServerEvents = true;
        }
      }
      if (!receivedServerEvents) merged = appendUnassessedTextAnswer(merged, activeQuestion.id, answer);
      setSession(merged);
      advance();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '简答提取失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page-content pretest-page">
      <header className="page-heading">
        <span>模块一</span>
        <h1>前测诊断</h1>
      </header>
      <ol className="pretest-steps" aria-label="前测步骤">
        {stepLabels.map((label, index) => (
          <li key={label} aria-current={index === draft.step ? 'step' : undefined} data-complete={index < draft.step}>
            <span>{index + 1}</span>{label}
          </li>
        ))}
      </ol>

      {draft.step === 0 ? (
        <section className="builder-section" aria-labelledby="builder-title">
          <header>
            <span>通用模型</span>
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
          answer={draft.answers[activeQuestion.id]}
          busy={busy}
          onAnswerChange={(value) => setDraft((current) => ({
            ...current,
            answers: { ...current.answers, [activeQuestion.id]: value },
          }))}
          onSubmit={submitQuestion}
        />
      ) : null}

      {draft.step === drawingStep ? (
        <HandDrawingPanel
          onReview={runtime.reviewDrawing}
          onFinish={() => setDraft((current) => ({ ...current, step: diagnosisStep }))}
        />
      ) : null}

      {draft.step >= diagnosisStep ? <DiagnosisView config={config} session={session} /> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </main>
  );
}
