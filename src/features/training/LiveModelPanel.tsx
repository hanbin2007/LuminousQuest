import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState } from 'react';

import type { CaseConfig, LoadedConfig } from '../../../shared/config/schemas';
import type { StudentSession } from '../../../shared/session';
import { useReducedMotion } from '../../app/useReducedMotion';
import { buildLiveCellState, liveNodeById } from '../model/live-cell';
import { STAGE } from '../model/stage-tokens';
import { TrainingGlassPanel } from './TrainingGlassPanel';

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
      <TrainingGlassPanel
        aria-labelledby="live-model-title"
        className="live-model live-model--frozen ds-frame ds-frame--stage"
        role="region"
        surfaceClassName="training-glass-panel--stage"
      >
        <header className="live-model__header">
          <h3 id="live-model-title">认知模型</h3>
          <span>暂停点亮</span>
        </header>
        <p className="live-model__focus ds-control">
          冷迁移后测不显示即时对错，模型暂停实时点亮；提交并完成对比后，可在雷达图中回看三维度表现。
        </p>
      </TrainingGlassPanel>
    );
  }

  return (
    <TrainingGlassPanel
      aria-labelledby="live-model-title"
      className="live-model ds-frame ds-frame--stage"
      role="region"
      surfaceClassName="training-glass-panel--stage"
    >
      <header className="live-model__header">
        <h3 id="live-model-title">认知模型</h3>
        <p className="live-model__meta" key={trainingCase.id}>
          已点亮 {state.litCount} / {state.totalCount}
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

      {focused ? (
        <p className="live-model__focus ds-control" aria-live="polite">
          <span className="live-model__focus-text" key={focusNodeId}>
            {focused.id} · {focused.statement}
          </span>
        </p>
      ) : null}

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

    </TrainingGlassPanel>
  );
});
