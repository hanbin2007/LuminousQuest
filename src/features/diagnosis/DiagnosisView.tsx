import { lazy, Suspense, useMemo } from 'react';

import type { LoadedConfig } from '../../../shared/config/schemas';
import { buildLearnerProfile } from '../../../shared/scoring/profile';
import type { StudentSession } from '../../../shared/session/schema';
import { AnnotationCard, type AnnotationStatus } from './AnnotationCard';

const DiagnosisRadar = lazy(async () => {
  const module = await import('./DiagnosisRadar');
  return { default: module.DiagnosisRadar };
});

const dimensionTerms = {
  device: '失电子场所 · 电子导体 · 离子导体 · 得电子场所',
  principle: '电极反应物 · 电极产物 · 电子与离子转移',
  energy: '化学能直接转化为电能',
} as const;

interface DiagnosisViewProps {
  config: LoadedConfig;
  session: StudentSession;
}

function annotationStatus(node: ReturnType<typeof buildLearnerProfile>['nodes'][number]): AnnotationStatus {
  if (node.status !== 'scored') return 'unassessed';
  if (node.outcome === 'hit' || node.outcome === 'hit-with-help') return 'hit';
  return node.outcome ?? 'unassessed';
}

export function DiagnosisView({ config, session }: DiagnosisViewProps) {
  const profile = useMemo(() => buildLearnerProfile(session, config), [config, session]);
  const dimensionById = new Map<string, typeof config.knowledgeModel.dimensions[number]>(
    config.knowledgeModel.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const rubricByNode = new Map(config.rubrics.rubrics.map((rubric) => [rubric.nodeId, rubric]));

  return (
    <section className="diagnosis-view" aria-labelledby="diagnosis-title">
      <header className="page-heading">
        <span>前测完成</span>
        <h1 id="diagnosis-title">诊断结果</h1>
      </header>
      <div className="diagnosis-overview">
        <div className="diagnosis-chart-column">
          <Suspense fallback={<div className="diagnosis-radar diagnosis-radar--loading" aria-label="雷达图载入中" />}>
            <DiagnosisRadar dimensions={profile.dimensions.map((dimension) => ({
              id: dimension.dimensionId as 'device' | 'principle' | 'energy',
              label: dimensionById.get(dimension.dimensionId)?.label ?? dimension.dimensionId,
              value: dimension.ratio ?? 0,
            }))} />
          </Suspense>
          <p className="model-axis-terms">
            {dimensionTerms.device}；{dimensionTerms.principle}；{dimensionTerms.energy}
          </p>
        </div>
        <div className="dimension-scores" aria-label="三维度分数">
          {profile.dimensions.map((dimension) => {
            const label = dimensionById.get(dimension.dimensionId)?.label ?? dimension.dimensionId;
            return (
              <button
                className={`dimension-score dimension-score--${dimension.dimensionId}`}
                key={dimension.dimensionId}
                onClick={() => document.getElementById(`evidence-${dimension.dimensionId}`)?.scrollIntoView()}
                type="button"
              >
                <span>{label}</span>
                <strong>{dimension.ratio === null ? '未测到' : `${Math.round(dimension.ratio * 100)}`}</strong>
                <small>{dimension.ratio === null ? 'unassessed' : dimension.level}</small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="evidence-groups">
        {config.knowledgeModel.dimensions.map((dimension) => {
          const nodes = profile.nodes.filter((node) => node.dimensionId === dimension.id);
          return (
            <section id={`evidence-${dimension.id}`} className={`evidence-group evidence-group--${dimension.id}`} key={dimension.id}>
              <header>
                <h2>{dimension.label}证据</h2>
                <p>{dimensionTerms[dimension.id as keyof typeof dimensionTerms]}</p>
              </header>
              <div className="annotation-list">
                {nodes.map((node) => {
                  const rubric = rubricByNode.get(node.nodeId)!;
                  const status = annotationStatus(node);
                  const matchedRule = node.status === 'scored'
                    ? rubric.rules.find((rule) => rule.id === node.trace?.ruleId)
                    : undefined;
                  const requirement = rubric.evidenceRequirements[0]?.description ?? '完成对应证据表达。';
                  const isUnassessed = status === 'unassessed';
                  const originalAnswer = node.trace?.originalAnswer;
                  const quote = originalAnswer && originalAnswer.length > 220
                    ? `${originalAnswer.slice(0, 220)}…`
                    : originalAnswer;
                  return (
                    <AnnotationCard
                      key={node.nodeId}
                      dimensionLabel={dimension.label}
                      nodeId={node.nodeId}
                      rubricId={rubric.id}
                      status={status}
                      correct={isUnassessed
                        ? '尚无可引用证据。'
                        : status === 'hit'
                          ? matchedRule?.description ?? '本项证据达到量表要求。'
                          : '已完成与本节点相关的作答。'}
                      incorrect={isUnassessed
                        ? '本项未测到，不能视为错误。'
                        : status === 'hit'
                          ? '本次证据未显示关键错误。'
                          : matchedRule?.description ?? '当前证据尚未达到量表要求。'}
                      next={status === 'hit' ? `换一个案例，再次验证：${requirement}` : requirement}
                      quote={quote}
                      fullQuote={originalAnswer && originalAnswer.length > 220 ? originalAnswer : undefined}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
