import { useContext, useEffect, useMemo, useState } from 'react';

import { useReducedMotion } from '../../app/useReducedMotion';

import { AppContext } from '../../app/AppContext';
import { DiagnosisRadar } from '../diagnosis/DiagnosisRadar';
import { buildModelScene } from './lighting';
import { KnowledgeScene } from './KnowledgeScene';

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

const LIGHT_LEGEND: Array<{ key: string; label: string; className: string }> = [
  { key: 'full-lit', label: '已掌握 · 全亮', className: 'legend-full' },
  { key: 'half-lit', label: '部分掌握 · 半亮', className: 'legend-half' },
  { key: 'dark', label: '未掌握 · 暗置', className: 'legend-dark' },
  { key: 'unassessed', label: '未测到 · 灰', className: 'legend-unassessed' },
  { key: 'needs-review', label: '待教师复核', className: 'legend-review' },
];

export function ModelPage() {
  const app = useContext(AppContext);
  const [entered, setEntered] = useState(false);
  const [replayToken, setReplayToken] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const hasWebgl = useMemo(webglAvailable, []);

  // 关灯时刻:进入页面后灯光渐暗,再开始点亮序列(--dur-stage 同源:900ms)
  useEffect(() => {
    if (reducedMotion) { setEntered(true); return; }
    const timer = window.setTimeout(() => setEntered(true), 60);
    return () => window.clearTimeout(timer);
  }, [reducedMotion]);

  // 演示重放入口:?stage-demo 直接触发一次完整序列
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('stage-demo')) {
      setReplayToken((token) => token + 1);
    }
  }, []);

  const session = app?.session;
  const config = app?.config;
  const scene = useMemo(
    () => (session && config ? buildModelScene(session, config) : null),
    [session, config],
  );
  if (!app || !scene) return null;
  const selected = selectedId ? scene.nodes.find((node) => node.id === selectedId) ?? null : null;

  return (
    <div className={`stage-dark model-stage ${entered ? 'model-stage--on' : ''}`}>
      <header className="model-stage__header">
        <div>
          <p className="model-stage__eyebrow">模块三 · 思维模型外显</p>
          <h1>电化学统一认知模型</h1>
          <p className="model-stage__meta">
            已点亮 {scene.litCount} / {scene.totalCount} 个知识节点 · 拖动旋转 · 滚轮缩放 · 点击节点查看
          </p>
        </div>
        <button
          type="button"
          className="model-stage__replay"
          onClick={() => setReplayToken((token) => token + 1)}
        >
          重放点亮过程
        </button>
      </header>

      <div className="model-stage__body">
        <div className="model-stage__canvas" aria-hidden={hasWebgl}>
          {hasWebgl ? (
            <KnowledgeScene
              scene={scene}
              replayToken={replayToken}
              reducedMotion={reducedMotion}
              onSelect={setSelectedId}
              selectedId={selectedId}
            />
          ) : (
            <div className="model-stage__fallback">
              <p>当前设备不支持 3D 渲染,以下为节点点亮清单:</p>
              <ul>
                {scene.nodes.map((node) => (
                  <li key={node.id}>
                    {node.id} — {LIGHT_LEGEND.find((entry) => entry.key === node.light)?.label ?? node.light}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className="model-stage__panel">
          {selected ? (
            <section className="model-stage__detail" aria-live="polite">
              <h2>{selected.id}</h2>
              <p className="model-stage__statement">{selected.statement}</p>
              <p className="model-stage__state">
                {LIGHT_LEGEND.find((entry) => entry.key === selected.light)?.label}
              </p>
            </section>
          ) : (
            <section className="model-stage__detail model-stage__detail--empty">
              <p>点击任意节点,查看它对应的知识点与掌握状态。</p>
            </section>
          )}
          <nav className="model-stage__nodes" aria-label="知识节点清单">
            {scene.nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`node-chip node-chip--${node.light} ${selectedId === node.id ? 'node-chip--selected' : ''}`}
                aria-pressed={selectedId === node.id}
                onClick={() => setSelectedId(selectedId === node.id ? null : node.id)}
              >
                {node.id}
              </button>
            ))}
          </nav>
          <section className="model-stage__radar">
            <h2>三维度掌握概览</h2>
            <DiagnosisRadar dimensions={scene.radar.map((entry) => ({
              id: entry.id,
              label: entry.label,
              value: entry.value,
            }))}
            />
          </section>
          <ul className="model-stage__legend">
            {LIGHT_LEGEND.map((entry) => (
              <li key={entry.key}><span className={`legend-dot ${entry.className}`} />{entry.label}</li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

export default ModelPage;
