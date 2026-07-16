import { ArrowRight, Check, Lightbulb, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CaseConfig } from '../../../shared/config/schemas';
import type { ScaffoldScoreInput } from '../../../shared/scoring/scaffold';
import type { AssessmentCompletedEvent, StudentSession } from '../../../shared/session';
import { useAppContext } from '../../app/AppContext';
import { AnnotationCard, type AnnotationStatus } from '../diagnosis/AnnotationCard';
import { EquationToolbar } from '../pretest/EquationToolbar';
import { mergeServerSession } from '../pretest/session-merge';
import {
  emptyTrainingDraft,
  loadTrainingDraft,
  saveTrainingDraft,
  type TrainingDraft,
} from './draft';
import {
  advanceScaffold,
  deriveCaseScaffoldScore,
  deriveCasePassEvaluation,
  initialScaffold,
  upsertScaffoldHistory,
  type ScaffoldViewState,
} from './scaffold-adapter';
import { mediumLabel, visibleCaseMaterials } from './materials';
import { TransferRadarComparison } from './TransferRadarComparison';
import { buildTransferComparison, type TransferComparison } from './transfer-comparison';

const levelNumerals: Record<number, string> = { 1: '一级', 2: '二级', 3: '三级' };
const dimensionAnswerLabels = {
  device: '装置维度作答',
  principle: '原理维度作答',
  energy: '能量维度作答',
} as const;
const equationLabels = {
  negative: '负极反应式',
  positive: '正极反应式',
  overall: '总反应式',
} as const;

interface CompletedRound {
  caseId: string;
  attemptIds: string[];
  scaffoldScore: ScaffoldScoreInput | null;
  transition: ScaffoldViewState | null;
  casePass: ReturnType<typeof deriveCasePassEvaluation>;
}

interface TutorNote {
  content: string;
  completedRounds: number;
  source: 'provider' | 'development-cache' | 'demo-recording' | 'preset';
  degraded: boolean;
  terminal: boolean;
  reason?: string;
}

function tutorSourceLabel(source: TutorNote['source']) {
  if (source === 'provider') return '实时辅导';
  if (source === 'preset') return '预设回退';
  return '回放降级';
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function caseAnswer(draft: TrainingDraft, caseId: string, fieldId: string) {
  return draft.answers[caseId]?.[fieldId] ?? '';
}

function equationAnswer(draft: TrainingDraft, caseId: string, equationId: string) {
  return draft.equations[caseId]?.[equationId] ?? '';
}

function activeScaffold(trainingCase: CaseConfig, level: number) {
  const forcedLevel = trainingCase.caseType === 'transfer' ? 3 : level;
  return trainingCase.scaffold.find((entry) => entry.level === forcedLevel)
    ?? trainingCase.scaffold.find((entry) => entry.level === 3)
    ?? trainingCase.scaffold[0]!;
}

function combinedNarrative(draft: TrainingDraft, trainingCase: CaseConfig, level: number) {
  const scaffold = activeScaffold(trainingCase, level);
  if (scaffold.level === 1) {
    return scaffold.fields.map((field) =>
      `${field.nodeId} ${field.prompt}\n${caseAnswer(draft, trainingCase.id, field.id)}`).join('\n\n');
  }
  if (scaffold.level === 2) {
    return scaffold.dimensionIds.map((dimensionId) =>
      `${dimensionAnswerLabels[dimensionId]}\n${caseAnswer(draft, trainingCase.id, dimensionId)}`).join('\n\n');
  }
  return caseAnswer(draft, trainingCase.id, 'independent');
}

function latestRoundAssessments(session: StudentSession, round: CompletedRound) {
  const attemptIds = new Set(round.attemptIds);
  const latest = new Map<string, AssessmentCompletedEvent>();
  for (const event of session.events) {
    if (
      event.kind !== 'assessment.completed'
      || event.caseId !== round.caseId
      || !attemptIds.has(event.attemptId)
    ) continue;
    const previous = latest.get(event.nodeId);
    if (!previous || event.sequence > previous.sequence) latest.set(event.nodeId, event);
  }
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
}

function annotationStatus(event: AssessmentCompletedEvent): AnnotationStatus {
  if (event.score.status === 'unassessed') {
    return event.extraction.status === 'needs-review' ? 'needs-review' : 'unassessed';
  }
  if (event.score.status === 'unanswered') return 'unassessed';
  if (event.score.status === 'needs-review') return 'needs-review';
  const outcome = event.score.outcome ?? event.ruleDecision.status;
  if (outcome === 'hit' || outcome === 'hit-with-help') return 'hit';
  if (outcome === 'partial') return 'partial';
  if (outcome === 'miss') return 'miss';
  return 'unassessed';
}

function eventQuote(event: AssessmentCompletedEvent) {
  return event.extraction.status === 'assessed' ? event.extraction.evidence[0]?.quote : undefined;
}

function transitionPresentation(
  transition: ScaffoldViewState,
  threshold: number,
) {
  if (transition.action === 'promote') {
    return `连续 ${threshold} 次无辅助答对，下一案例进入${levelNumerals[transition.level]}脚手架。`;
  }
  if (transition.action === 'demote') {
    return `连续 ${transition.streak} 次未答对，下一案例回到${levelNumerals[transition.level]}脚手架。`;
  }
  return transition.changeReason;
}

function MaterialPanel({
  trainingCase,
  completedNodeIds,
}: {
  trainingCase: CaseConfig;
  completedNodeIds: readonly string[];
}) {
  const [materialId, setMaterialId] = useState<string | null>(null);
  const available = visibleCaseMaterials(trainingCase, completedNodeIds);
  const material = available.find((entry) => entry.id === materialId) ?? available[0];

  useEffect(() => setMaterialId(null), [trainingCase.id]);

  return (
    <section className="training-material" aria-labelledby="training-material-title">
      <header>
        <span>案例素材</span>
        <h3 id="training-material-title">先读装置，再看内部</h3>
      </header>
      {available.length > 1 ? (
        <div className="segmented-control training-material__switch" aria-label="案例素材视图">
          {available.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === material?.id ? 'is-active' : undefined}
              onClick={() => setMaterialId(entry.id)}
            >
              {entry.kind === 'cross-section' ? '查看结构剖面' : '查看装置简图'}
            </button>
          ))}
        </div>
      ) : null}
      {material?.materialRef ? (
        <figure>
          <img
            src={`/${material.materialRef}`}
            alt={`${trainingCase.title} ${material.kind === 'cross-section' ? '结构剖面图' : '装置简图'}`}
          />
          <figcaption>
            {material.kind === 'cross-section' ? '结构剖面' : '装置简图'} · {mediumLabel(trainingCase.medium)}
          </figcaption>
        </figure>
      ) : (
        <p className="training-material__pending">素材待签收</p>
      )}
    </section>
  );
}

interface AnswerWorkspaceProps {
  trainingCase: CaseConfig;
  draft: TrainingDraft;
  level: number;
  busy: boolean;
  onAnswer: (fieldId: string, value: string) => void;
  onEquation: (equationId: string, value: string) => void;
  onSubmit: () => void;
}

function AnswerWorkspace({
  trainingCase,
  draft,
  level,
  busy,
  onAnswer,
  onEquation,
  onSubmit,
}: AnswerWorkspaceProps) {
  const scaffold = activeScaffold(trainingCase, level);
  const policyLabel = trainingCase.caseType === 'transfer'
    ? '三级 · 冷迁移独立作答'
    : `${levelNumerals[scaffold.level]} · ${scaffold.level === 1
      ? '完整引导'
      : scaffold.level === 2 ? '三维度标题' : '独立作答'}`;

  return (
    <section className="training-workspace" aria-labelledby="training-workspace-title">
      <header>
        <div>
          <span>当前脚手架</span>
          <h3 id="training-workspace-title">{policyLabel}</h3>
        </div>
        <small>{trainingCase.caseType === 'transfer' ? '固定等级，不提供提示' : '由作答状态自动调整'}</small>
      </header>

      <div className="training-answer-fields">
        {scaffold.level === 1 ? scaffold.fields.map((field) => (
          <label key={field.id} className="training-answer-field" data-dimension={field.dimensionId}>
            <span>
              <strong>{field.nodeId === 'D5' ? 'D5 · 场所与反应物四连问' : field.nodeId}</strong>
              {field.prompt}
            </span>
            <textarea
              value={caseAnswer(draft, trainingCase.id, field.id)}
              onChange={(event) => onAnswer(field.id, event.target.value)}
              rows={3}
            />
          </label>
        )) : null}
        {scaffold.level === 2 ? scaffold.dimensionIds.map((dimensionId) => (
          <label key={dimensionId} className="training-answer-field" data-dimension={dimensionId}>
            <span><strong>{dimensionAnswerLabels[dimensionId]}</strong></span>
            <textarea
              aria-label={dimensionAnswerLabels[dimensionId]}
              value={caseAnswer(draft, trainingCase.id, dimensionId)}
              onChange={(event) => onAnswer(dimensionId, event.target.value)}
              rows={6}
            />
          </label>
        )) : null}
        {scaffold.level === 3 ? (
          <label className="training-answer-field" data-dimension="principle">
            <span><strong>独立分析</strong>{scaffold.prompt}</span>
            <textarea
              aria-label="独立分析"
              value={caseAnswer(draft, trainingCase.id, 'independent')}
              onChange={(event) => onAnswer('independent', event.target.value)}
              rows={10}
            />
          </label>
        ) : null}
      </div>

      <fieldset className="training-equations">
        <legend>电极反应式与总反应式</legend>
        {trainingCase.equationSets.map((equation) => {
          const id = `training-equation-${trainingCase.id}-${equation.id}`;
          const value = equationAnswer(draft, trainingCase.id, equation.id);
          return (
            <label key={equation.id} htmlFor={id}>
              <span>{equationLabels[equation.electrode]}</span>
              <EquationToolbar
                textareaId={id}
                value={value}
                onChange={(next) => onEquation(equation.id, next)}
              />
              <textarea
                id={id}
                aria-label={equationLabels[equation.electrode]}
                value={value}
                onChange={(event) => onEquation(equation.id, event.target.value)}
                rows={2}
              />
            </label>
          );
        })}
      </fieldset>

      <button className="primary-button training-submit" type="button" disabled={busy} onClick={onSubmit}>
        {busy ? <LoaderCircle className="training-spinner" aria-hidden="true" /> : <Check aria-hidden="true" />}
        {trainingCase.caseType === 'transfer' ? '提交冷迁移作答' : '提交案例作答'}
      </button>
    </section>
  );
}

export function TrainingPage() {
  const {
    config,
    runtime,
    session,
    setSession,
    setTrainingComplete,
  } = useAppContext();
  const cases = useMemo(
    () => [...config.cases].sort((left, right) => left.sequence - right.sequence),
    [config.cases],
  );
  const firstCase = cases[0];
  const firstLevel = firstCase
    ? initialScaffold(firstCase.caseType, config.scaffoldPolicy).level
    : 1;
  const [draft, setDraft] = useState<TrainingDraft>(() =>
    loadTrainingDraft(storage(), session.id, cases.map((entry) => entry.id), firstLevel));
  const [round, setRound] = useState<CompletedRound | null>(null);
  const [tutorNotes, setTutorNotes] = useState<Record<string, TutorNote>>({});
  const [comparison, setComparison] = useState<TransferComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [tutorBusyNode, setTutorBusyNode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submissionIds = useRef(new Map<string, string>());

  const activeIndex = Math.max(0, cases.findIndex((entry) => entry.id === draft.activeCaseId));
  const trainingCase = cases[activeIndex] ?? firstCase;
  const completedTrainingCount = trainingCase
    ? cases.slice(0, activeIndex + (round?.caseId === trainingCase.id ? 1 : 0))
      .filter((entry) => entry.caseType === 'training').length
    : 0;

  useEffect(() => {
    const next = loadTrainingDraft(storage(), session.id, cases.map((entry) => entry.id), firstLevel);
    setDraft(next);
    setRound(null);
    setTutorNotes({});
    setComparison(null);
  }, [cases, firstLevel, session.id]);

  useEffect(() => {
    try {
      saveTrainingDraft(storage(), session.id, draft);
    } catch {
      setError('训练草稿保存失败，请导出会话。');
    }
  }, [draft, session.id]);

  if (!trainingCase) {
    return <main className="page-content"><p className="form-error">没有可用的训练案例。</p></main>;
  }

  const updateAnswer = (fieldId: string, value: string) => {
    setDraft((current) => ({
      ...current,
      answers: {
        ...current.answers,
        [trainingCase.id]: { ...current.answers[trainingCase.id], [fieldId]: value },
      },
    }));
  };

  const updateEquation = (equationId: string, value: string) => {
    setDraft((current) => ({
      ...current,
      equations: {
        ...current.equations,
        [trainingCase.id]: { ...current.equations[trainingCase.id], [equationId]: value },
      },
    }));
  };

  const stableSubmissionId = (key: string) => {
    const existing = submissionIds.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    submissionIds.current.set(key, created);
    return created;
  };

  const submitCase = async () => {
    setBusy(true);
    setError(null);
    setTutorNotes({});
    let merged = session;
    const attemptIds: string[] = [];
    const narrative = combinedNarrative(draft, trainingCase, draft.currentLevel);
    try {
      const answerTargetNodeIds = [...new Set(trainingCase.evidencePaths
        .filter((entry) => entry.source === 'answer')
        .map((entry) => entry.nodeId))];
      const narrativeId = stableSubmissionId(`${trainingCase.id}\0analysis\0${narrative}`);
      attemptIds.push(narrativeId);
      const narrativeResult = await runtime.extractAssessment({
        sessionId: session.id,
        caseId: trainingCase.id,
        questionId: `${trainingCase.id}:analysis`,
        targetNodeIds: answerTargetNodeIds,
        studentAnswer: narrative,
        submissionId: narrativeId,
      });
      if (narrativeResult.session) {
        merged = mergeServerSession(merged, narrativeResult.session);
        setSession(merged);
      }

      for (const equation of trainingCase.equationSets) {
        const value = equationAnswer(draft, trainingCase.id, equation.id);
        const equationId = stableSubmissionId(`${trainingCase.id}\0${equation.id}\0${value}`);
        attemptIds.push(equationId);
        const equationResult = await runtime.assessEquation({
          sessionId: session.id,
          caseId: trainingCase.id,
          equationSetId: equation.id,
          equation: value,
          submissionId: equationId,
        });
        if (equationResult.session) {
          merged = mergeServerSession(merged, equationResult.session);
          setSession(merged);
        }
      }

      const scaffoldScore = deriveCaseScaffoldScore(merged.events, trainingCase.id, attemptIds);
      const casePass = deriveCasePassEvaluation(merged.events, trainingCase, attemptIds, config);
      let transition: ScaffoldViewState | null = null;
      if (trainingCase.caseType === 'training') {
        const history = scaffoldScore
          ? upsertScaffoldHistory(draft.scaffoldHistory, {
            caseId: trainingCase.id,
            attemptIds,
            score: scaffoldScore,
          })
          : draft.scaffoldHistory;
        transition = advanceScaffold(
          'training',
          draft.currentLevel,
          history.map((entry) => entry.score),
          config.scaffoldPolicy,
        );
        setDraft((current) => ({ ...current, scaffoldHistory: history }));
      }
      const completedRound = { caseId: trainingCase.id, attemptIds, scaffoldScore, transition, casePass };
      setRound(completedRound);

      if (trainingCase.caseType === 'transfer') {
        setComparison(buildTransferComparison(merged, config, trainingCase.id));
        setTrainingComplete(true);
      } else if (activeIndex === cases.length - 1) {
        setTrainingComplete(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const nextCase = () => {
    const next = cases[activeIndex + 1];
    if (!next || !round || !round.casePass.passed) return;
    const nextLevel = next.caseType === 'transfer'
      ? 3
      : round.transition?.level ?? draft.currentLevel;
    setDraft((current) => ({
      ...current,
      activeCaseId: next.id,
      currentLevel: nextLevel,
    }));
    setRound(null);
    setTutorNotes({});
    setError(null);
  };

  const askTutor = async (nodeId: string) => {
    setTutorBusyNode(nodeId);
    setError(null);
    try {
      const result = await runtime.tutorTurn({
        sessionId: session.id,
        nodeId,
        studentAnswer: combinedNarrative(draft, trainingCase, draft.currentLevel),
      });
      setSession((current) => mergeServerSession(current, result.session));
      if (result.status === 'respond') {
        setTutorNotes((current) => ({
          ...current,
          [nodeId]: {
            content: result.finalRound
              ? config.scaffoldPolicy.socratic.fallback.closing
              : result.turn.content,
            completedRounds: result.completedRounds,
            source: result.source,
            degraded: result.degraded,
            terminal: result.finalRound,
            reason: result.reason,
          },
        }));
      } else if (result.status === 'advance') {
        setTutorNotes((current) => ({
          ...current,
          [nodeId]: {
            content: config.scaffoldPolicy.socratic.fallback.closing,
            completedRounds: result.completedRounds,
            source: result.source,
            degraded: result.degraded,
            terminal: true,
            reason: result.reason,
          },
        }));
      } else {
        setTutorNotes((current) => ({
          ...current,
          [nodeId]: {
            content: '当前节点暂不需要追加提示。',
            completedRounds: result.assistance.rounds,
            source: result.source,
            degraded: result.degraded,
            terminal: true,
            reason: result.reason,
          },
        }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '老师提示暂时不可用。');
    } finally {
      setTutorBusyNode(null);
    }
  };

  if (comparison) {
    return (
      <main className="page-content training-page">
        <header className="page-heading">
          <span>模块二 · 冷迁移后测完成</span>
          <h1>思维模型训练</h1>
        </header>
        <TransferRadarComparison comparison={comparison} />
      </main>
    );
  }

  const feedbackEvents = round?.caseId === trainingCase.id
    ? latestRoundAssessments(session, round)
    : [];
  const next = cases[activeIndex + 1];
  const normalTrainingComplete = trainingCase.caseType === 'training'
    && Boolean(round?.casePass.passed)
    && completedTrainingCount === cases.filter((entry) => entry.caseType === 'training').length;
  const tutorNodeIds = new Set(trainingCase.tutoring.map((entry) => entry.nodeId));

  return (
    <main className="page-content training-page">
      <header className="page-heading training-page__heading">
        <div>
          <span>模块二 · 案例 {activeIndex + 1} / {cases.length}</span>
          <h1>思维模型训练</h1>
        </div>
        <p>{completedTrainingCount} 个训练案例已完成</p>
      </header>

      <section className="training-case-heading">
        <span>{trainingCase.caseType === 'transfer' ? '冷迁移后测' : '案例训练'}</span>
        <h2>{trainingCase.title}</h2>
        <p>
          {trainingCase.caseType === 'transfer'
            ? '本案例固定独立作答；不显示即时对错，也不提供提示。'
            : `当前等级：${levelNumerals[draft.currentLevel]}。完成后由脚手架策略决定下一案例等级。`}
        </p>
      </section>

      <div className="training-layout">
        <MaterialPanel
          trainingCase={trainingCase}
          completedNodeIds={feedbackEvents.map((event) => event.nodeId)}
        />
        <AnswerWorkspace
          trainingCase={trainingCase}
          draft={draft}
          level={draft.currentLevel}
          busy={busy}
          onAnswer={updateAnswer}
          onEquation={updateEquation}
          onSubmit={submitCase}
        />
      </div>

      {error ? <p className="form-error training-error" role="alert">{error}</p> : null}

      {trainingCase.caseType === 'training' && round ? (
        <section className="training-feedback" aria-labelledby="training-feedback-title">
          <header>
            <div>
              <span>即时反馈</span>
              <h2 id="training-feedback-title">本轮证据批注</h2>
            </div>
            {round.scaffoldScore?.outcome === 'hit' ? (
              <div className="training-electron-flow" data-active="true" aria-label="本案例答对电子流">
                <i /><i /><i />
              </div>
            ) : null}
          </header>

          <div className="training-scaffold-state" data-action={round.transition?.action ?? 'stay'}>
            <strong>{round.transition?.currentLabel ?? '当前脚手架保持不变'}</strong>
            <span>{round.transition
              ? transitionPresentation(round.transition, config.scaffoldPolicy.promotion.consecutiveHits)
              : '本轮没有可用于调整脚手架的已测证据。'}</span>
          </div>

          <p className="training-case-pass" data-passed={round.casePass.passed}>
            {round.casePass.passed
              ? '本案例达到过关条件'
              : '尚未达到本案例过关条件'}
          </p>

          <div className="annotation-list training-feedback__list">
            {feedbackEvents.map((event) => {
              const status = annotationStatus(event);
              const node = config.knowledgeModel.nodes.find((entry) => entry.id === event.nodeId);
              const dimension = config.knowledgeModel.dimensions.find((entry) => entry.id === node?.dimensionId);
              const note = tutorNotes[event.nodeId];
              const canTutor = status === 'miss'
                && tutorNodeIds.has(event.nodeId)
                && !note?.terminal;
              return (
                <div className="training-feedback-item" key={event.nodeId}>
                  <AnnotationCard
                    dimensionLabel={dimension?.label ?? '模型节点'}
                    nodeId={event.nodeId}
                    rubricId={event.rubric.id}
                    status={status}
                    correct={status === 'hit' ? '本节点要求已经完整覆盖。' : '作答已留下可继续推理的证据。'}
                    incorrect={status === 'hit' ? '未发现需要修正的关键点。' : event.ruleDecision.reason}
                    next={status === 'hit' ? '把这条判断与下一节点连接起来。' : node?.statement ?? '回到当前节点重新检查依据。'}
                    quote={eventQuote(event)}
                  />
                  {canTutor ? (
                    <button
                      className="secondary-button training-tutor-trigger"
                      type="button"
                      disabled={tutorBusyNode === event.nodeId}
                      onClick={() => askTutor(event.nodeId)}
                    >
                      <Lightbulb aria-hidden="true" />请老师提示一下
                    </button>
                  ) : null}
                  {note ? (
                    <aside className="training-tutor-note" aria-label={`${event.nodeId} 老师提示`}>
                      <header>
                        <strong>蓝笔追问</strong>
                        <span>第 {note.completedRounds} / {config.scaffoldPolicy.socratic.maxRounds} 轮</span>
                        <span>{tutorSourceLabel(note.source)}</span>
                      </header>
                      <p>{note.content}</p>
                      {note.reason ? <small>故障状态：{note.reason}</small> : null}
                    </aside>
                  ) : null}
                </div>
              );
            })}
          </div>

          {normalTrainingComplete ? (
            <div className="training-complete">
              <Check aria-hidden="true" />
              <strong>三个训练案例已完成</strong>
            </div>
          ) : null}
          {next && round.casePass.passed ? (
            <button className="primary-button training-next" type="button" onClick={nextCase}>
              进入下一案例<ArrowRight aria-hidden="true" />
            </button>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
