import {
  Cable,
  CircleDot,
  MousePointer2,
  Plus,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { PretestConfig } from '../../../shared/config/schemas';
import {
  assessBuilderTopology,
  type BuilderCarrier,
  type BuilderGraph,
  type BuilderGraphComponent,
  type BuilderTopologyAssessment,
  type BuilderConnectionKind,
} from '../../../shared/scoring/topology';
import { presentationFor } from './presentation';
import { previewCircuitClosure } from './topology-preview';

const dragMime = 'application/x-lq-component';
const moveMime = 'application/x-lq-instance';
const gridSize = 24;
const nodeWidth = 120;
const nodeHeight = 132;

export interface PlacedBuilderComponent extends BuilderGraphComponent {
  x: number;
  y: number;
}

export interface BuilderAnswer {
  components: PlacedBuilderComponent[];
  connections: BuilderGraph['connections'];
}

interface TopologyBuilderProps {
  config: PretestConfig['builder'];
  initialValue?: BuilderAnswer;
  onChange?: (value: BuilderAnswer) => void;
  onSubmit: (value: BuilderAnswer, assessment: BuilderTopologyAssessment) => void;
}

const materialOptions = [
  { id: 'generic-conductor', label: '通用导体', specificity: 'generic' as const },
  { id: 'Zn', label: '锌 Zn', specificity: 'specific' as const },
  { id: 'Cu', label: '铜 Cu', specificity: 'specific' as const },
  { id: 'C', label: '碳 C', specificity: 'specific' as const },
];

function createInstanceId(componentId: string) {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${componentId}-${suffix}`;
}

function graphFor(value: BuilderAnswer): BuilderGraph {
  return {
    components: value.components.map(({ x: _x, y: _y, ...component }) => component),
    connections: value.connections,
  };
}

function snapped(value: number) {
  return Math.max(0, Math.round(value / gridSize) * gridSize);
}

export function TopologyBuilder({ config, initialValue, onChange, onSubmit }: TopologyBuilderProps) {
  const [value, setValue] = useState<BuilderAnswer>(initialValue ?? { components: [], connections: [] });
  const [connectionKind, setConnectionKind] = useState<BuilderConnectionKind>('electron-path');
  const [carrier, setCarrier] = useState<BuilderCarrier>('cation');
  const [showDirection, setShowDirection] = useState(true);
  const [connectionStart, setConnectionStart] = useState<string | null>(null);
  const [snapFlash, setSnapFlash] = useState<{ x: number; y: number; key: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const definitionById = useMemo(
    () => new Map(config.components.map((component) => [component.id, component])),
    [config.components],
  );

  useEffect(() => {
    if (initialValue) setValue(initialValue);
  }, [initialValue]);

  const update = (next: BuilderAnswer) => {
    setValue(next);
    onChange?.(next);
  };

  const addComponent = (componentId: string, point?: { x: number; y: number }) => {
    const definition = definitionById.get(componentId);
    if (!definition) return;
    const index = value.components.length;
    const canvasWidth = canvasRef.current?.getBoundingClientRect().width || 720;
    const columns = Math.max(1, Math.floor(canvasWidth / (nodeWidth + gridSize)));
    const nextPoint = point ?? {
      x: gridSize + (index % columns) * (nodeWidth + gridSize),
      y: gridSize + Math.floor(index / columns) * (nodeHeight + gridSize),
    };
    const component: PlacedBuilderComponent = {
      instanceId: createInstanceId(componentId),
      componentId,
      label: definition.label,
      ...(definition.functionalRole ? { assignedRole: definition.functionalRole } : {}),
      ...(definition.kind === 'electrode'
        ? { materialBinding: { materialId: 'generic-conductor', specificity: 'generic' as const } }
        : {}),
      x: snapped(nextPoint.x),
      y: snapped(nextPoint.y),
    };
    update({ ...value, components: [...value.components, component] });
    setSnapFlash({ x: component.x, y: component.y, key: component.instanceId });
  };

  const removeComponent = (instanceId: string) => {
    update({
      components: value.components.filter((component) => component.instanceId !== instanceId),
      connections: value.connections.filter(
        (connection) => connection.from !== instanceId && connection.to !== instanceId,
      ),
    });
    if (connectionStart === instanceId) setConnectionStart(null);
  };

  const moveComponent = (instanceId: string, point: { x: number; y: number }) => {
    const nextPoint = { x: snapped(point.x), y: snapped(point.y) };
    update({
      ...value,
      components: value.components.map((component) => component.instanceId === instanceId
        ? { ...component, ...nextPoint }
        : component),
    });
    setSnapFlash({ ...nextPoint, key: `${instanceId}-${nextPoint.x}-${nextPoint.y}` });
  };

  const connect = (instanceId: string) => {
    if (!connectionStart) {
      setConnectionStart(instanceId);
      return;
    }
    if (connectionStart === instanceId) {
      setConnectionStart(null);
      return;
    }
    const nextCarrier = showDirection
      ? connectionKind === 'electron-path' ? 'electron' : carrier
      : undefined;
    const duplicate = value.connections.some((connection) =>
      connection.from === connectionStart
      && connection.to === instanceId
      && connection.kind === connectionKind
      && connection.carrier === nextCarrier);
    if (!duplicate) {
      update({
        ...value,
        connections: [
          ...value.connections,
          {
            id: createInstanceId('connection'),
            from: connectionStart,
            to: instanceId,
            kind: connectionKind,
            ...(nextCarrier ? { carrier: nextCarrier } : {}),
          },
        ],
      });
    }
    setConnectionStart(null);
  };

  const preview = previewCircuitClosure(graphFor(value), config);
  const componentByInstance = new Map(value.components.map((component) => [component.instanceId, component]));
  const canvasContentHeight = value.components.reduce(
    (height, component) => Math.max(height, component.y + nodeHeight + gridSize),
    0,
  );

  const submit = () => {
    try {
      const assessment = assessBuilderTopology(graphFor(value), config);
      setSubmitError(null);
      onSubmit(value, assessment);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="builder-layout">
      <aside className="component-tray" aria-label="组件托盘">
        <h3>组件托盘</h3>
        <div className="component-tray__list">
          {config.components.map((component) => {
            const presentation = presentationFor(component.id, component.label);
            const Icon = presentation.Icon;
            return (
              <button
                className="tray-item"
                draggable
                key={component.id}
                onClick={() => addComponent(component.id)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'copy';
                  event.dataTransfer.setData(dragMime, component.id);
                }}
                type="button"
                aria-label={`添加 ${presentation.functionalLabel}`}
              >
                <span className="tray-item__visual" aria-hidden="true">
                  {presentation.image
                    ? <img src={presentation.image} alt="" />
                    : Icon ? <Icon /> : <CircleDot />}
                </span>
                <span>
                  <strong>{presentation.functionalLabel}</strong>
                  <small>{component.kind === 'distractor' ? '干扰项' : component.label}</small>
                </span>
                <Plus className="tray-item__add" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </aside>

      <section className="builder-workspace" aria-label="搭建画布">
        <div className="builder-toolbar" aria-label="连线工具">
          <div className="segmented-control" aria-label="路径类型">
            <button
              className={connectionKind === 'electron-path' ? 'is-active' : ''}
              onClick={() => { setConnectionKind('electron-path'); setConnectionStart(null); }}
              type="button"
              aria-pressed={connectionKind === 'electron-path'}
            >
              <Cable aria-hidden="true" />电子路径
            </button>
            <button
              className={connectionKind === 'ion-path' ? 'is-active' : ''}
              onClick={() => { setConnectionKind('ion-path'); setConnectionStart(null); }}
              type="button"
              aria-pressed={connectionKind === 'ion-path'}
            >
              <CircleDot aria-hidden="true" />离子路径
            </button>
          </div>
          <label className="toggle-control">
            <input
              type="checkbox"
              checked={showDirection}
              onChange={(event) => setShowDirection(event.target.checked)}
            />
            标注方向
          </label>
          {connectionKind === 'ion-path' ? (
            <label className="select-control">
              <span>方向载流粒子</span>
              <select value={carrier} onChange={(event) => setCarrier(event.target.value as BuilderCarrier)}>
                <option value="cation">阳离子</option>
                <option value="anion">阴离子</option>
              </select>
            </label>
          ) : null}
          <span className="builder-toolbar__selection" aria-live="polite">
            <MousePointer2 aria-hidden="true" />
            {connectionStart ? '选择终点' : '选择起点'}
          </span>
        </div>

        <div
          ref={canvasRef}
          className="builder-canvas"
          data-snap-flash={snapFlash ? 'true' : 'false'}
          data-testid="builder-canvas"
          style={{ '--builder-content-height': `${canvasContentHeight}px` } as React.CSSProperties}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const componentId = event.dataTransfer.getData(dragMime);
            const instanceId = event.dataTransfer.getData(moveMime);
            const bounds = canvasRef.current?.getBoundingClientRect();
            if (!bounds || (!componentId && !instanceId)) return;
            const maxX = Math.max(0, Math.floor((bounds.width - nodeWidth) / gridSize) * gridSize);
            const maxY = Math.max(0, Math.floor((bounds.height - nodeHeight) / gridSize) * gridSize);
            const point = {
              x: Math.min(maxX, event.clientX - bounds.left - nodeWidth / 2),
              y: Math.min(maxY, event.clientY - bounds.top - nodeHeight / 2),
            };
            if (instanceId) moveComponent(instanceId, point);
            else addComponent(componentId, point);
          }}
        >
          <svg className="builder-connections" aria-hidden="true">
            {value.connections.map((connection) => {
              const from = componentByInstance.get(connection.from);
              const to = componentByInstance.get(connection.to);
              if (!from || !to) return null;
              return (
                <line
                  className={`builder-connection builder-connection--${connection.kind}`}
                  key={connection.id}
                  x1={from.x + nodeWidth / 2}
                  y1={from.y + nodeHeight / 2}
                  x2={to.x + nodeWidth / 2}
                  y2={to.y + nodeHeight / 2}
                  markerEnd={connection.carrier
                    ? connection.kind === 'electron-path'
                      ? 'url(#builder-arrow-electron)'
                      : 'url(#builder-arrow-ion)'
                    : undefined}
                />
              );
            })}
            <defs>
              <marker id="builder-arrow-electron" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path className="builder-arrow--electron" d="M0 0 L8 4 L0 8 Z" />
              </marker>
              <marker id="builder-arrow-ion" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path className="builder-arrow--ion" d="M0 0 L8 4 L0 8 Z" />
              </marker>
            </defs>
          </svg>

          {snapFlash ? (
            <span
              className="builder-snap-flash"
              key={snapFlash.key}
              style={{ left: snapFlash.x, top: snapFlash.y + nodeHeight - 18 }}
              onAnimationEnd={() => setSnapFlash(null)}
              aria-hidden="true"
            />
          ) : null}

          {value.components.map((component) => {
            const definition = definitionById.get(component.componentId)!;
            const presentation = presentationFor(component.componentId, definition.label);
            const Icon = presentation.Icon;
            return (
              <div
                className={`builder-node${connectionStart === component.instanceId ? ' is-connection-start' : ''}`}
                draggable
                key={component.instanceId}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(moveMime, component.instanceId);
                }}
                style={{ left: component.x, top: component.y }}
              >
                <button
                  className="builder-node__target"
                  onClick={() => connect(component.instanceId)}
                  type="button"
                  aria-label={`画布组件 ${presentation.functionalLabel}`}
                >
                  <span className="builder-node__visual" aria-hidden="true">
                    {presentation.image
                      ? <img src={presentation.image} alt="" />
                      : Icon ? <Icon /> : <CircleDot />}
                  </span>
                  <strong>{presentation.functionalLabel}</strong>
                </button>
                {definition.kind === 'electrode' ? (
                  <label className="builder-node__material">
                    <span>材料</span>
                    <select
                      value={component.materialBinding?.materialId ?? 'generic-conductor'}
                      onChange={(event) => {
                        const selected = materialOptions.find((option) => option.id === event.target.value)!;
                        update({
                          ...value,
                          components: value.components.map((entry) => entry.instanceId === component.instanceId
                            ? { ...entry, materialBinding: {
                                materialId: selected.id,
                                specificity: selected.specificity,
                              } }
                            : entry),
                        });
                      }}
                    >
                      {materialOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button
                  className="icon-button builder-node__remove"
                  onClick={() => removeComponent(component.instanceId)}
                  type="button"
                  aria-label={`移除 ${presentation.functionalLabel}`}
                  title={`移除 ${presentation.functionalLabel}`}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="topology-preview" aria-live="polite">
          <span data-closed={preview.electronClosed}>{preview.electronClosed ? '电子路径已闭合' : '电子路径未闭合'}</span>
          <span data-closed={preview.ionClosed}>{preview.ionClosed ? '离子路径已闭合' : '离子路径未闭合'}</span>
        </div>

        <div className="builder-connections-list" aria-label="已连接路径">
          {value.connections.map((connection) => (
            <div key={connection.id}>
              <span>{connection.kind === 'electron-path' ? '电子路径' : '离子路径'}</span>
              <span>{connection.carrier === 'electron' ? 'e⁻' : connection.carrier === 'cation' ? '阳离子' : connection.carrier === 'anion' ? '阴离子' : '未标方向'}</span>
              <button
                className="icon-button"
                onClick={() => update({
                  ...value,
                  connections: value.connections.filter((entry) => entry.id !== connection.id),
                })}
                type="button"
                aria-label="删除连线"
                title="删除连线"
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        {submitError ? <p className="form-error" role="alert">{submitError}</p> : null}
        <button className="primary-button builder-submit" onClick={submit} type="button">提交搭建</button>
      </section>
    </div>
  );
}
