import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState } from 'react';

import type { CaseConfig, LoadedConfig } from '../../../shared/config/schemas';
import type { StudentSession } from '../../../shared/session';
import { useReducedMotion } from '../../app/useReducedMotion';
import { buildLiveCellState, liveNodeById } from '../model/live-cell';
import { STAGE } from '../model/stage-tokens';
import { mediumLabel } from './materials';

// three.js 场景按需加载:无 WebGL 或未进入训练页时不下载/解析 3D chunk
const CellScene = lazy(() =>
  import('../model/CellScene').then((module) => ({ default: module.CellScene })));

const LIGHT_LABELS: Record<string, string> = {
  'full-lit': '已掌握 · 全亮',
  'half-lit': '部分掌握 · 半亮',
  dark: '未掌握 · 暗置',
  unassessed: '未测到 · 灰',
  'needs-review': '待教师复核',
};

const DIMENSION_GROUPS = [
  { id: 'device', label: '装置' },
  { id: 'principle', label: '原理' },
  { id: 'energy', label: '能量' },
] as const;

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!context) return false;
    (context as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export interface LiveModelPanelProps {
  session: StudentSession;
  config: LoadedConfig;
  trainingCase: CaseConfig;
  focusNodeId: string | null;
  onFocus: (nodeId: string | null) => void;
}

export const LiveModelPanel = memo(function LiveModelPanel({
  session,
  config,
  trainingCase,
  focusNodeId,
  onFocus,
}: LiveModelPanelProps) {
  const state = useMemo(
    () => buildLiveCellState(session, config, trainingCase),
    [session, config, trainingCase],
  );
  const hasWebgl = useMemo(webglAvailable, []);
  const reducedMotion = useReducedMotion();

  // 灯态签名变化 → 重放点亮序列(与模块三同语言)
  const [replayToken, setReplayToken] = useState(0);
  const signatureRef = useRef(state.litSignature);
  useEffect(() => {
    if (signatureRef.current !== state.litSignature) {
      signatureRef.current = state.litSignature;
      setReplayToken((token) => token + 1);
    }
  }, [state.litSignature]);

  const focused = liveNodeById(state, focusNodeId);

  // 冷迁移后测:不提供任何即时对错信号,面板冻结为静态说明
  if (trainingCase.caseType === 'transfer') {
    return (
      <section className="live-model live-model--frozen stage-dark" aria-labelledby="live-model-title">
        <header className="live-model__header">
          <div>
            <span className="live-model__eyebrow">冷迁移 · 三维分析</span>
            <h3 id="live-model-title">电化学统一认知模型</h3>
          </div>
        </header>
        <p className="live-model__focus">
          冷迁移后测不显示即时对错，模型暂停实时点亮；提交并完成对比后，可在雷达图中回看三维度表现。
        </p>
      </section>
    );
  }

  return (
    <section className="live-model stage-dark" aria-labelledby="live-model-title">
      <header className="live-model__header">
        <div>
          <span className="live-model__eyebrow">实时 · 三维分析</span>
          <h3 id="live-model-title">电化学统一认知模型</h3>
        </div>
        <p className="live-model__meta" key={trainingCase.id}>
          {trainingCase.title} · {mediumLabel(trainingCase.medium)} · 已点亮 {state.litCount} / {state.totalCount}
        </p>
      </header>

      <div className="live-model__canvas" aria-hidden={hasWebgl}>
        {hasWebgl ? (
          <Suspense fallback={<div className="live-model__loading" style={{ background: STAGE.bg }} />}>
            <CellScene
              state={state}
              replayToken={replayToken}
              reducedMotion={reducedMotion}
              focusNodeId={focusNodeId}
            />
          </Suspense>
        ) : (
          <div className="live-model__fallback">
            <p>当前环境不支持 3D 渲染，以下为节点灯态清单：</p>
            <ul>
              {state.nodes.map((node) => (
                <li key={node.id}>
                  {node.id} — {LIGHT_LABELS[node.light] ?? node.light}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="live-model__focus" aria-live="polite">
        <span className="live-model__focus-text" key={focusNodeId ?? 'idle'}>
          {focused
            ? `聚焦 ${focused.id}（${LIGHT_LABELS[focused.light]}）：${focused.statement}`
            : '提交作答或点击节点，模型会实时点亮对应部分。'}
        </span>
      </p>

      <div className="live-model__chips" role="group" aria-label="认知模型节点">
        {DIMENSION_GROUPS.map((group) => (
          <div className="live-model__chip-row" key={group.id}>
            <span className="live-model__chip-label">{group.label}</span>
            <div>
              {state.nodes
                .filter((node) => node.dimensionId === group.id)
                .map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className={`node-chip node-chip--${node.light} ${focusNodeId === node.id ? 'node-chip--selected' : ''}`}
                    aria-label={`${node.id}（${LIGHT_LABELS[node.light]}）`}
                    aria-pressed={focusNodeId === node.id}
                    onClick={() => onFocus(focusNodeId === node.id ? null : node.id)}
                  >
                    {node.id}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      <ul className="live-model__legend">
        {Object.entries(LIGHT_LABELS).map(([key, label]) => (
          <li key={key}><span className={`legend-dot legend-${key === 'needs-review' ? 'review' : key.replace('-lit', '')}`} />{label}</li>
        ))}
      </ul>
    </section>
  );
});
