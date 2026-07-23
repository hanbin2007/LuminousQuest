import {
  ArrowRight,
  Check,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  LocateFixed,
  Send,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { CaseConfig } from '../../../shared/config/schemas';
import type { ScaffoldScoreInput } from '../../../shared/scoring/scaffold';
import type {
  AssessmentCompletedEvent,
  StudentSession,
  TutorTurnCompletedEvent,
} from '../../../shared/session';
import { sessionServerSequence } from '../../../shared/session/sync';
import { useAppContext } from '../../app/AppContext';
import { resolveTrainingCaseId, trainingCasePath } from '../../app/route-config';
import { getWorkspaceStorage } from '../../persistence/workspace-storage';
import { AnnotationCard, type AnnotationStatus } from '../diagnosis/AnnotationCard';
import { EquationToolbar } from '../pretest/EquationToolbar';
import { mergeServerSession } from '../pretest/session-merge';
import {
  loadDemoTrainingRound,
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
import { latestAgentFocus } from '../model/agent-focus';
import { LiveModelPanel } from './LiveModelPanel';
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
  closing?: string;
  completedRounds: number;
  source: 'provider' | 'development-cache' | 'demo-recording' | 'preset';
  degraded: boolean;
  terminal: boolean;
  reason?: string;
}

function restoredDemoRound(
  session: StudentSession,
  config: ReturnType<typeof useAppContext>['config'],
  cases: readonly CaseConfig[],
  draft: TrainingDraft,
): CompletedRound | null {
  const stored = loadDemoTrainingRound(
    getWorkspaceStorage(),
    session.id,
    cases.map((entry) => entry.id),
  );
  if (!stored) return null;
  const trainingCase = cases.find((entry) => entry.id === stored.caseId);
  if (!trainingCase) return null;
  const scaffoldScore = deriveCaseScaffoldScore(session.events, stored.caseId, stored.attemptIds);
  const casePass = deriveCasePassEvaluation(session.events, trainingCase, stored.attemptIds, config);
  const scores = draft.scaffoldHistory.map((entry) => entry.score);
  if (scaffoldScore) scores.push(scaffoldScore);
  const transition = trainingCase.caseType === 'training'
    ? advanceScaffold(trainingCase.caseType, draft.currentLevel, scores, config.scaffoldPolicy)
    : null;
  return { ...stored, scaffoldScore, transition, casePass };
}

function restoredTutorNotes(
  session: StudentSession,
  round: CompletedRound | null,
): Record<string, TutorNote> {
  if (!round) return {};
  const attemptIds = new Set(round.attemptIds);
  const turns = session.events.filter((event): event is TutorTurnCompletedEvent =>
    event.kind === 'tutor.turn.completed'
    && event.caseId === round.caseId
    && attemptIds.has(event.attemptId));
  const notes: Record<string, TutorNote> = {};
  turns.forEach((turn) => {
    const completedRounds = turns.filter((event) => event.cycleId === turn.cycleId).length;
    const terminal = session.events.find((event) =>
      event.kind === 'tutor.cycle.terminal' && event.cycleId === turn.cycleId);
    notes[turn.nodeId] = {
      content: terminal?.kind === 'tutor.cycle.terminal' ? terminal.content : turn.turn.content,
      completedRounds,
      source: turn.source,
      degraded: turn.degraded,
      terminal: Boolean(terminal),
      ...(terminal?.kind === 'tutor.cycle.terminal' ? { reason: terminal.reason } : {}),
    };
  });
  return notes;
}

function tutorSourceLabel(source: TutorNote['source']) {
  if (source === 'provider') return '实时辅导';
  if (source === 'demo-recording') return '演示回放';
  if (source === 'development-cache') return '回放降级';
  if (source === 'preset') return '预设回退';
  return '辅导记录';
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

type TrainingCompletionSection = 'analysis' | 'equations';

interface TrainingRequiredItem {
  id: string;
  controlId: string;
  label: string;
  section: TrainingCompletionSection;
  complete: boolean;
}

function requiredTrainingItems(
  trainingCase: CaseConfig,
  draft: TrainingDraft,
  level: number,
): TrainingRequiredItem[] {
  const scaffold = activeScaffold(trainingCase, level);
  const analysis = scaffold.level === 1
    ? scaffold.fields.map((field) => ({
      id: `analysis:${field.id}`,
      controlId: `training-answer-${trainingCase.id}-${field.id}`,
      label: field.prompt,
      section: 'analysis' as const,
      complete: caseAnswer(draft, trainingCase.id, field.id).trim().length > 0,
    }))
    : scaffold.level === 2
      ? scaffold.dimensionIds.map((dimensionId) => ({
        id: `analysis:${dimensionId}`,
        controlId: `training-answer-${trainingCase.id}-${dimensionId}`,
        label: dimensionAnswerLabels[dimensionId],
        section: 'analysis' as const,
        complete: caseAnswer(draft, trainingCase.id, dimensionId).trim().length > 0,
      }))
      : [{
        id: 'analysis:independent',
        controlId: `training-answer-${trainingCase.id}-independent`,
        label: '独立分析',
        section: 'analysis' as const,
        complete: caseAnswer(draft, trainingCase.id, 'independent').trim().length > 0,
      }];
  const equations = trainingCase.equationSets.map((equation) => ({
    id: `equation:${equation.id}`,
    controlId: `training-equation-${trainingCase.id}-${equation.id}`,
    label: equationLabels[equation.electrode],
    section: 'equations' as const,
    complete: equationAnswer(draft, trainingCase.id, equation.id).trim().length > 0,
  }));
  return [...analysis, ...equations];
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

const topicTitles: Record<string, string> = {
  'zinc-copper': '电极与反应物',
  'hydrogen-oxygen': '反应场所与离子通路',
  'aluminum-air': '多孔电极与介质',
  'methane-fuel': '燃料、氧化剂与能量',
};

function topicDescription(trainingCase: CaseConfig, level: number) {
  const scaffold = activeScaffold(trainingCase, level);
  if (scaffold.level === 1) {
    const prompts = scaffold.fields.slice(0, 4).map((field) => field.prompt).join('');
    return `结合${trainingCase.title}装置示意图思考：${prompts}`;
  }
  if (scaffold.level === 2) {
    return `结合${trainingCase.title}，从装置、原理和能量三个维度完成分析，并说明判断依据。`;
  }
  return scaffold.prompt;
}

function MaterialPanel({
  trainingCase,
  completedNodeIds,
  level,
}: {
  trainingCase: CaseConfig;
  completedNodeIds: readonly string[];
  level: number;
}) {
  const [materialId, setMaterialId] = useState<string | null>(null);
  const available = visibleCaseMaterials(trainingCase, completedNodeIds);
  const material = available.find((entry) => entry.id === materialId) ?? available[0];

  useEffect(() => setMaterialId(null), [trainingCase.id]);

  return (
    <section className="training-topic ds-frame" aria-labelledby="training-topic-title">
      <div className="training-topic__summary">
        <div className="training-topic__media">
          {material?.materialRef ? (
            <img
              src={`/${material.materialRef}`}
              alt={`${trainingCase.title} ${material.kind === 'cross-section' ? '结构剖面图' : '装置简图'}`}
            />
          ) : (
            <span>素材待签收</span>
          )}
        </div>
        <div className="training-topic__title">
          <span>装置维度</span>
          <h2 id="training-topic-title">{topicTitles[trainingCase.id] ?? trainingCase.title}</h2>
        </div>
        <div className="training-topic__level">
          <span>当前等级</span>
          <strong>{levelNumerals[level] ?? `${level}级`}</strong>
        </div>
      </div>
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
      <p>{topicDescription(trainingCase, level)}</p>
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
  const [showValidation, setShowValidation] = useState(false);
  const scaffold = activeScaffold(trainingCase, level);
  const policyLabel = trainingCase.caseType === 'transfer'
    ? '三级 · 冷迁移独立作答'
    : `${levelNumerals[scaffold.level]} · ${scaffold.level === 1
      ? '完整引导'
      : scaffold.level === 2 ? '三维度标题' : '独立作答'}`;
  const requiredItems = requiredTrainingItems(trainingCase, draft, level);
  const completedCount = requiredItems.filter((item) => item.complete).length;
  const missingItems = requiredItems.filter((item) => !item.complete);
  const analysisItems = requiredItems.filter((item) => item.section === 'analysis');
  const equationItems = requiredItems.filter((item) => item.section === 'equations');
  const analysisComplete = analysisItems.filter((item) => item.complete).length;
  const equationsComplete = equationItems.filter((item) => item.complete).length;
  const isComplete = missingItems.length === 0;

  const locateMissing = (section?: TrainingCompletionSection) => {
    const item = missingItems.find((candidate) => !section || candidate.section === section);
    if (!item) return;
    const control = document.getElementById(item.controlId);
    if (control && typeof control.scrollIntoView === 'function') {
      control.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    control?.focus({ preventScroll: true });
  };

  const attemptSubmit = () => {
    if (!isComplete) {
      setShowValidation(true);
      locateMissing();
    } else {
      setShowValidation(false);
    }
    onSubmit();
  };

  return (
    <section className="training-workspace ds-frame ds-frame--secondary" aria-labelledby="training-workspace-title">
      <header>
        <h2 id="training-workspace-title">AI 助教</h2>
        <span>在线</span>
      </header>

      <div className="training-workspace__thread">
        <div className="training-chat-bubble training-chat-bubble--assistant ds-control">
          <strong>{policyLabel}</strong>
          <p>
            {trainingCase.caseType === 'transfer'
              ? '请独立完成分析，本轮不会显示即时提示。'
              : '先观察装置，再按下面的问题逐步写出你的判断。'}
          </p>
        </div>

        <section className="training-completion" aria-labelledby="training-completion-title">
          <div className="training-completion__summary">
            <ListChecks aria-hidden="true" />
            <div>
              <span id="training-completion-title">本案例完成度</span>
              <strong>{completedCount} / {requiredItems.length}</strong>
            </div>
            <button
              className="secondary-button training-completion__locate"
              disabled={isComplete}
              onClick={() => locateMissing()}
              type="button"
            >
              <LocateFixed aria-hidden="true" />定位未完成项
            </button>
          </div>
          <progress
            aria-label={`本案例已完成 ${completedCount} 项，共 ${requiredItems.length} 项`}
            max={requiredItems.length}
            value={completedCount}
          />
          <div className="training-completion__sections">
            <button
              data-complete={analysisComplete === analysisItems.length || undefined}
              disabled={analysisComplete === analysisItems.length}
              onClick={() => locateMissing('analysis')}
              type="button"
            >
              分析 {analysisComplete}/{analysisItems.length}
            </button>
            <button
              data-complete={equationsComplete === equationItems.length || undefined}
              disabled={equationsComplete === equationItems.length}
              onClick={() => locateMissing('equations')}
              type="button"
            >
              方程式 {equationsComplete}/{equationItems.length}
            </button>
          </div>
          {showValidation && !isComplete ? (
            <p className="training-completion__error" role="alert">
              还有 {missingItems.length} 项未完成，已定位到第一处。
            </p>
          ) : null}
        </section>

        <div className="training-answer-fields">
          {scaffold.level === 1 ? scaffold.fields.map((field) => {
            const controlId = `training-answer-${trainingCase.id}-${field.id}`;
            const missing = showValidation && !requiredItems.find((item) => item.controlId === controlId)?.complete;
            return (
            <label
              key={field.id}
              className="training-answer-field"
              data-dimension={field.dimensionId}
              data-missing={missing || undefined}
            >
              <span className="training-chat-bubble training-chat-bubble--assistant ds-control">
                <strong>{field.nodeId === 'D5' ? 'D5 · 场所与反应物四连问' : field.nodeId}</strong>
                {field.prompt}
              </span>
              <span className="training-chat-bubble training-chat-bubble--student">
                <textarea
                  id={controlId}
                  aria-label={field.prompt}
                  placeholder="输入你的想法…"
                  value={caseAnswer(draft, trainingCase.id, field.id)}
                  onChange={(event) => onAnswer(field.id, event.target.value)}
                  rows={2}
                />
              </span>
            </label>
            );
          }) : null}
          {scaffold.level === 2 ? scaffold.dimensionIds.map((dimensionId) => {
            const controlId = `training-answer-${trainingCase.id}-${dimensionId}`;
            const missing = showValidation && !requiredItems.find((item) => item.controlId === controlId)?.complete;
            return (
            <label
              key={dimensionId}
              className="training-answer-field"
              data-dimension={dimensionId}
              data-missing={missing || undefined}
            >
              <span className="training-chat-bubble training-chat-bubble--assistant ds-control">
                <strong>{dimensionAnswerLabels[dimensionId]}</strong>
              </span>
              <span className="training-chat-bubble training-chat-bubble--student">
                <textarea
                  id={controlId}
                  aria-label={dimensionAnswerLabels[dimensionId]}
                  placeholder="输入你的分析…"
                  value={caseAnswer(draft, trainingCase.id, dimensionId)}
                  onChange={(event) => onAnswer(dimensionId, event.target.value)}
                  rows={4}
                />
              </span>
            </label>
            );
          }) : null}
          {scaffold.level === 3 ? (() => {
            const controlId = `training-answer-${trainingCase.id}-independent`;
            const missing = showValidation && !requiredItems.find((item) => item.controlId === controlId)?.complete;
            return (
            <label
              className="training-answer-field"
              data-dimension="principle"
              data-missing={missing || undefined}
            >
              <span className="training-chat-bubble training-chat-bubble--assistant ds-control">
                <strong>独立分析</strong>
                {scaffold.prompt}
              </span>
              <span className="training-chat-bubble training-chat-bubble--student">
                <textarea
                  id={controlId}
                  aria-label="独立分析"
                  placeholder="输入完整分析…"
                  value={caseAnswer(draft, trainingCase.id, 'independent')}
                  onChange={(event) => onAnswer('independent', event.target.value)}
                  rows={6}
                />
              </span>
            </label>
            );
          })() : null}
        </div>

        <fieldset className="training-equations ds-control">
          <legend>补全反应式</legend>
          {trainingCase.equationSets.map((equation) => {
            const id = `training-equation-${trainingCase.id}-${equation.id}`;
            const value = equationAnswer(draft, trainingCase.id, equation.id);
            return (
              <label
                data-missing={showValidation && !value.trim() || undefined}
                key={equation.id}
                htmlFor={id}
              >
                <span>{equationLabels[equation.electrode]}</span>
                <EquationToolbar
                  textareaId={id}
                  value={value}
                  onChange={(next) => onEquation(equation.id, next)}
                />
                <textarea
                  id={id}
                  aria-label={equationLabels[equation.electrode]}
                  placeholder="输入反应式…"
                  value={value}
                  onChange={(event) => onEquation(equation.id, event.target.value)}
                  rows={2}
                />
              </label>
            );
          })}
        </fieldset>
      </div>

      <footer className="training-workspace__composer">
        <span>{isComplete
          ? (trainingCase.caseType === 'transfer' ? '独立作答已完成，可以提交' : '全部内容已完成，可以提交')
          : `还需完成 ${missingItems.length} 项`}</span>
        <button
          aria-label={trainingCase.caseType === 'transfer' ? '提交冷迁移作答' : '提交案例作答'}
          className="training-submit"
          disabled={busy}
          onClick={attemptSubmit}
          type="button"
        >
          {busy ? <LoaderCircle className="training-spinner" aria-hidden="true" /> : <Send aria-hidden="true" />}
        </button>
      </footer>
    </section>
  );
}

export function TrainingPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
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
  const initialDraft = () =>
    loadTrainingDraft(getWorkspaceStorage(), session.id, cases.map((entry) => entry.id), firstLevel);
  const [draft, setDraft] = useState<TrainingDraft>(initialDraft);
  const [round, setRound] = useState<CompletedRound | null>(() =>
    restoredDemoRound(session, config, cases, initialDraft()));
  const [tutorNotes, setTutorNotes] = useState<Record<string, TutorNote>>(() =>
    restoredTutorNotes(session, restoredDemoRound(session, config, cases, initialDraft())));
  const [comparison, setComparison] = useState<TransferComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [tutorBusyNode, setTutorBusyNode] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submissionIds = useRef(new Map<string, string>());

  // agent 的 focus_node 非权威聚焦:新提示到达才应用一次,学生点选可随时覆盖
  const agentFocus = useMemo(() => latestAgentFocus(session), [session]);
  const appliedAgentFocusSequence = useRef(0);
  useEffect(() => {
    if (agentFocus && agentFocus.sequence > appliedAgentFocusSequence.current) {
      appliedAgentFocusSequence.current = agentFocus.sequence;
      setFocusNodeId(agentFocus.nodeId);
    }
  }, [agentFocus]);

  const routedCaseId = resolveTrainingCaseId(config, pathname);
  const activeCaseId = routedCaseId ?? draft.activeCaseId;
  const activeIndex = Math.max(0, cases.findIndex((entry) => entry.id === activeCaseId));
  const trainingCase = cases[activeIndex] ?? firstCase;
  const completedTrainingCount = trainingCase
    ? cases.slice(0, activeIndex + (round?.caseId === trainingCase.id ? 1 : 0))
      .filter((entry) => entry.caseType === 'training').length
    : 0;

  useEffect(() => {
    const next = loadTrainingDraft(getWorkspaceStorage(), session.id, cases.map((entry) => entry.id), firstLevel);
    const restoredRound = restoredDemoRound(session, config, cases, next);
    setDraft(next);
    setRound(restoredRound);
    setTutorNotes(restoredTutorNotes(session, restoredRound));
    setComparison(null);
  }, [cases, config, firstLevel, session.id]);

  useEffect(() => {
    try {
      saveTrainingDraft(getWorkspaceStorage(), session.id, draft);
    } catch {
      setError('训练草稿保存失败，请导出会话。');
    }
  }, [draft, session.id]);

  useEffect(() => {
    const routeCaseId = resolveTrainingCaseId(config, pathname);
    if (pathname === '/training' || routeCaseId === null) {
      navigate(trainingCasePath(draft.activeCaseId || firstCase?.id || ''), { replace: true });
      return;
    }
    if (draft.activeCaseId === routeCaseId) return;
    setDraft((current) => ({ ...current, activeCaseId: routeCaseId }));
    setRound(null);
    setTutorNotes({});
    setFocusNodeId(null);
    setComparison(null);
    setError(null);
  }, [config, firstCase?.id, navigate, pathname]);

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
        expectedSequence: sessionServerSequence(merged),
        idempotencyKey: narrativeId,
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
          expectedSequence: sessionServerSequence(merged),
          idempotencyKey: equationId,
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
    navigate(trainingCasePath(next.id));
    setRound(null);
    setTutorNotes({});
    setFocusNodeId(null);
    setError(null);
  };

  const askTutor = async (nodeId: string) => {
    setTutorBusyNode(nodeId);
    setFocusNodeId(nodeId);
    setError(null);
    try {
      const result = await runtime.tutorTurn({
        sessionId: session.id,
        expectedSequence: sessionServerSequence(session),
        idempotencyKey: `tutor:${nodeId}:${sessionServerSequence(session)}`,
        nodeId,
        studentAnswer: combinedNarrative(draft, trainingCase, draft.currentLevel),
      });
      setSession((current) => mergeServerSession(current, result.session));
      if (result.status === 'respond') {
        setTutorNotes((current) => ({
          ...current,
          [nodeId]: {
            content: result.turn.content,
            ...(result.finalRound ? { closing: config.scaffoldPolicy.socratic.fallback.closing } : {}),
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
    <main className="training-page training-page--split">
      <h1 className="visually-hidden">思维模型训练</h1>
      <h2 className="visually-hidden">{trainingCase.title}</h2>
      <div className="training-main" key={trainingCase.id}>
        <MaterialPanel
          trainingCase={trainingCase}
          completedNodeIds={feedbackEvents.map((event) => event.nodeId)}
          level={draft.currentLevel}
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

      {error ? <p className="form-error training-error" role="alert">{error}</p> : null}

      {trainingCase.caseType === 'training' && round ? (
        <section className="training-feedback ds-frame" aria-labelledby="training-feedback-title">
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
                <div
                  className="training-feedback-item"
                  key={event.nodeId}
                  data-focused={focusNodeId === event.nodeId || undefined}
                  onClick={() => setFocusNodeId(event.nodeId)}
                >
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
                      {note.closing ? <p className="training-tutor-note__closing">{note.closing}</p> : null}
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
      </div>

      <aside className="training-stage-rail">
        <LiveModelPanel
          session={session}
          config={config}
          trainingCase={trainingCase}
          focusNodeId={focusNodeId}
          onFocus={setFocusNodeId}
        />
      </aside>
    </main>
  );
}
