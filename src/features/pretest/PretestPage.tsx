import { useEffect, useMemo, useRef, useState } from 'react';

import { recordBuilderAssessment } from '../../../shared/workflows/engine-assessment';
import { appendSessionEvent } from '../../../shared/session/session';
import type { StudentSession } from '../../../shared/session/schema';
import { useAppContext } from '../../app/AppContext';
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

function draftStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
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
    caseId: 'pretest',
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
    stageJump,
    consumeStageJump,
  } = useAppContext();
  const [draft, setDraft] = useState<PretestDraft>(() =>
    loadPretestDraft(draftStorage(), session.id, config.pretest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionIds = useRef(new Map<string, string>());
  const questionCount = config.pretest.questions.length;
  const drawingStep = questionCount + 1;
  const diagnosisStep = questionCount + 2;
  const maxStep = diagnosisStep;
  const activeQuestion = draft.step > 0 && draft.step <= questionCount
    ? config.pretest.questions[draft.step - 1]
    : null;

  useEffect(() => {
    setDraft(loadPretestDraft(draftStorage(), session.id, config.pretest));
  }, [config.pretest, session.id]);

  useEffect(() => {
    try {
      savePretestDraft(draftStorage(), session.id, draft);
    } catch {
      setError('草稿保存失败，请导出会话。');
    }
    setPretestComplete(draft.step >= diagnosisStep);
  }, [diagnosisStep, draft, session.id, setPretestComplete]);

  const stepLabels = useMemo(() => [
    '搭建通用模型',
    ...config.pretest.questions.map((question, index) => `题目 ${index + 1}`),
    '手绘彩蛋',
    '诊断结果',
  ], [config.pretest.questions]);

  const advance = () => setDraft((current) => ({ ...current, step: Math.min(maxStep, current.step + 1) }));

  // 测试阶段手动跳转:直接落到目标步骤(动画路径与正常推进一致)
  useEffect(() => {
    if (stageJump?.module !== 'pretest') return;
    const target = Math.min(maxStep, Math.max(0, stageJump.step));
    setDraft((current) => ({ ...current, step: target }));
    consumeStageJump();
  }, [stageJump, maxStep, consumeStageJump]);

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

      <div className="step-content" key={draft.step}>
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
          dimensionLabel={config.knowledgeModel.dimensions.find((dimension) =>
            dimension.id === activeQuestion.dimensionId)?.label ?? activeQuestion.dimensionId}
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
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </main>
  );
}
