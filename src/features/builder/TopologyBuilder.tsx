import { CircleDot, Compass } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { PretestConfig } from '../../../shared/config/schemas';
import {
  assessBuilderTopology,
  configuredRoleWhitelist,
  maximumBuilderComponents,
  type BuilderGraph,
  type BuilderGraphComponent,
  type BuilderTopologyAssessment,
} from '../../../shared/scoring/topology';
import { useReducedMotion } from '../../app/useReducedMotion';
import { deriveAssembly } from './assembly';
import { BenchCanvas } from './BenchCanvas';
import { benchGeometryFor, presentationFor } from './presentation';

const dragMime = 'application/x-lq-component';
const moveMime = 'application/x-lq-instance';
const gridSize = 24;
const layoutCellWidth = 170;
const layoutCellHeight = 200;

const roleLabels = {
  'oxidation-site': '氧化反应位置',
  'reduction-site': '还原反应位置',
  'electron-conductor': '外电路传导',
  'ion-conductor': '内电路传导',
} as const;

export interface PlacedBuilderComponent extends BuilderGraphComponent {
  x: number;
  y: number;
  /** 方向箭头的指向(客户端专属,提交时已烧入推导边,不入会话)。 */
  flipped?: boolean;
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

const shelfGroups = [
  { id: 'electrode', label: '电极' },
  { id: 'link', label: '连接' },
  { id: 'medium', label: '介质' },
  { id: 'container', label: '容器' },
  { id: 'marker', label: '标注' },
] as const;

type ShelfGroupId = (typeof shelfGroups)[number]['id'];

/** 按表面语义归组(干扰项按其可选角色落组,绝不暴露 distractor 身份)。 */
function shelfGroupFor(component: PretestConfig['builder']['components'][number]): ShelfGroupId {
  switch (component.kind) {
    case 'electrode': return 'electrode';
    case 'electron-conductor': return 'link';
    case 'ion-conductor': return 'medium';
    case 'container': return 'container';
    case 'direction-marker': return 'marker';
    default:
      return component.allowedRoles?.includes('ion-conductor') ? 'medium' : 'link';
  }
}

const arrowKindByComponent: Record<string, 'electron' | 'cation' | 'anion'> = {
  'electron-arrow': 'electron',
  'cation-arrow': 'cation',
  'anion-arrow': 'anion',
};

const arrowColors = { electron: '#8fb8ff', cation: '#ffb84d', anion: '#45e0d2' } as const;

function ArrowGlyph({ kind, width, height }: { kind: 'electron' | 'cation' | 'anion'; width: number; height: number }) {
  return (
    <svg viewBox="0 0 56 24" width={width} height={height} style={{ color: arrowColors[kind] }}>
      <line x1="4" y1="12" x2="44" y2="12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M42 4 L54 12 L42 20 Z" fill="currentColor" />
    </svg>
  );
}

function createInstanceId(componentId: string) {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${componentId}-${suffix}`;
}

function graphFor(value: BuilderAnswer, connections: BuilderGraph['connections']): BuilderGraph {
  return {
    components: value.components.map(({ x: _x, y: _y, flipped: _flipped, ...component }) => component),
    connections,
  };
}

function snapped(value: number) {
  return Math.max(0, Math.round(value / gridSize) * gridSize);
}

export function TopologyBuilder({ config, initialValue, onChange, onSubmit }: TopologyBuilderProps) {
  const [value, setValue] = useState<BuilderAnswer>(initialValue ?? { components: [], connections: [] });
  const [annotate, setAnnotate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapFlash, setSnapFlash] = useState<{ x: number; y: number; key: string } | null>(null);
  const reducedMotion = useReducedMotion();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const definitionById = useMemo(
    () => new Map(config.components.map((component) => [component.id, component])),
    [config.components],
  );

  useEffect(() => {
    if (initialValue) setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    if (!snapFlash) return;
    const timer = window.setTimeout(() => setSnapFlash(null), 420);
    return () => window.clearTimeout(timer);
  }, [snapFlash]);

  useEffect(() => {
    if (!selected) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [selected]);

  const assembly = useMemo(
    () => deriveAssembly(value.components, definitionById),
    [value.components, definitionById],
  );

  const update = (components: PlacedBuilderComponent[]) => {
    const next: BuilderAnswer = {
      components,
      connections: deriveAssembly(components, definitionById).connections,
    };
    setValue(next);
    onChange?.(next);
  };

  const addComponent = (componentId: string, point?: { x: number; y: number }) => {
    const definition = definitionById.get(componentId);
    if (!definition) return;
    if (value.components.length >= maximumBuilderComponents) {
      setSubmitError(`搭建组件数量不能超过 ${maximumBuilderComponents}`);
      return;
    }
    const index = value.components.length;
    const canvasWidth = canvasRef.current?.getBoundingClientRect().width || 720;
    const columns = Math.max(1, Math.floor(canvasWidth / (layoutCellWidth + gridSize)));
    const nextPoint = point ?? {
      x: gridSize + (index % columns) * (layoutCellWidth + gridSize),
      y: gridSize + Math.floor(index / columns) * (layoutCellHeight + gridSize),
    };
    const component: PlacedBuilderComponent = {
      instanceId: createInstanceId(componentId),
      componentId,
      label: definition.label,
      ...(definition.kind === 'electrode'
        ? { materialBinding: { materialId: 'generic-conductor', specificity: 'generic' as const } }
        : {}),
      x: snapped(nextPoint.x),
      y: snapped(nextPoint.y),
    };
    update([...value.components, component]);
    setSnapFlash({ x: component.x, y: component.y, key: component.instanceId });
  };

  const removeComponent = (instanceId: string) => {
    update(value.components.filter((component) => component.instanceId !== instanceId));
    if (selected === instanceId) setSelected(null);
  };

  const moveComponent = (instanceId: string, point: { x: number; y: number }) => {
    const nextPoint = { x: snapped(point.x), y: snapped(point.y) };
    update(value.components.map((component) => component.instanceId === instanceId
      ? { ...component, ...nextPoint }
      : component));
    setSnapFlash({ ...nextPoint, key: `${instanceId}-${nextPoint.x}-${nextPoint.y}` });
  };

  const patchComponent = (
    instanceId: string,
    patch: (entry: PlacedBuilderComponent) => PlacedBuilderComponent,
  ) => {
    update(value.components.map((entry) => entry.instanceId === instanceId ? patch(entry) : entry));
  };

  const preview = {
    electronClosed: assembly.wireAttachments.length > 0,
    ionClosed: [...assembly.containment.values()].some((inside) => inside.length >= 2),
  };
  const componentByInstance = new Map(value.components.map((component) => [component.instanceId, component]));
  const labelOf = (instanceId: string) =>
    componentByInstance.get(instanceId)?.label
      ?? definitionById.get(componentByInstance.get(instanceId)?.componentId ?? '')?.label
      ?? instanceId;
  const canvasContentHeight = value.components.reduce(
    (height, component) =>
      Math.max(height, component.y + benchGeometryFor(component.componentId).height + 48),
    0,
  );

  const submit = () => {
    try {
      const assessment = assessBuilderTopology(graphFor(value, assembly.connections), config);
      setSubmitError(null);
      onSubmit(value, assessment);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    }
  };

  const selectedComponent = selected ? componentByInstance.get(selected) : undefined;
  const selectedDefinition = selectedComponent
    ? definitionById.get(selectedComponent.componentId)
    : undefined;

  return (
    <div className="bench">
      <div className="bench__topbar">
        <button
          className={`bench__annotate${annotate ? ' is-active' : ''}`}
          onClick={() => setAnnotate((current) => !current)}
          type="button"
          aria-pressed={annotate}
        >
          <Compass aria-hidden="true" />标注方向
        </button>
        <span className="bench__hint" aria-live="polite">
          {annotate
            ? '把方向箭头拖到导线上或池中,点击箭头可翻转方向'
            : '电极放入池中、导线拖近两个电极即自动连接;点击器材设置属性'}
        </span>
        <div className="topology-preview bench__preview" aria-live="polite">
          <span data-closed={preview.electronClosed}>{preview.electronClosed ? '电子路径已闭合' : '电子路径未闭合'}</span>
          <span data-closed={preview.ionClosed}>{preview.ionClosed ? '离子路径已闭合' : '离子路径未闭合'}</span>
        </div>
        <button className="primary-button builder-submit" onClick={submit} type="button">提交搭建</button>
      </div>

      <div className="bench__stage">
        <div
          ref={canvasRef}
          className="builder-canvas bench__canvas"
          data-snap-flash={snapFlash ? 'true' : 'false'}
          data-testid="builder-canvas"
          style={{ '--builder-content-height': `${canvasContentHeight}px` } as React.CSSProperties}
          onClick={(event) => {
            if (event.target === canvasRef.current) setSelected(null);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const componentId = event.dataTransfer.getData(dragMime);
            const instanceId = event.dataTransfer.getData(moveMime);
            const bounds = canvasRef.current?.getBoundingClientRect();
            if (!bounds || (!componentId && !instanceId)) return;
            const moving = instanceId ? componentByInstance.get(instanceId) : undefined;
            const geometry = benchGeometryFor(moving?.componentId ?? componentId);
            const maxX = Math.max(0, Math.floor((bounds.width - geometry.width) / gridSize) * gridSize);
            const maxY = Math.max(0, Math.floor((bounds.height - geometry.height) / gridSize) * gridSize);
            const point = {
              x: Math.min(maxX, event.clientX - bounds.left - geometry.width / 2),
              y: Math.min(maxY, event.clientY - bounds.top - geometry.height / 2),
            };
            if (instanceId) moveComponent(instanceId, point);
            else addComponent(componentId, point);
          }}
        >
          <BenchCanvas
            scene={{
              components: value.components,
              definitionById,
              assembly,
              selectedId: selected,
              annotate,
            }}
            flash={snapFlash}
            reducedMotion={reducedMotion}
            contentHeight={canvasContentHeight}
          />


          {value.components.map((component) => {
            const definition = definitionById.get(component.componentId);
            if (!definition) return null;
            const geometry = benchGeometryFor(component.componentId);
            const arrowKind = arrowKindByComponent[component.componentId];
            if (arrowKind && !annotate) return null;
            const attached = assembly.wireAttachments.some((entry) => entry.wireId === component.instanceId);
            const contained = definition.kind === 'electrode'
              && [...assembly.containment.values()].some((inside) => inside.includes(component.instanceId));
            const zClass = definition.kind === 'electrode'
              ? ' bench-z-electrode'
              : arrowKind
                ? ' bench-z-arrow'
                : attached
                  ? ' bench-z-grip'
                  : ' bench-z-vessel';
            return (
              <div
                className={`builder-node${selected === component.instanceId ? ' is-selected' : ''}${contained ? ' is-contained' : ''}${zClass}`}
                draggable
                key={component.instanceId}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(moveMime, component.instanceId);
                }}
                style={{ left: component.x, top: component.y, width: geometry.width }}
              >
                <button
                  className="builder-node__target"
                  onClick={() => {
                    setSelected((current) => current === component.instanceId ? null : component.instanceId);
                  }}
                  type="button"
                  aria-label={`画布组件 ${definition.label}`}
                  aria-expanded={selected === component.instanceId}
                >
                  <span
                    className={`builder-node__hit${attached ? ' is-grip' : ''}`}
                    style={attached ? undefined : { width: geometry.width, height: geometry.height }}
                    aria-hidden="true"
                  />
                  <strong className="sr-only">{definition.label}</strong>
                </button>
              </div>
            );
          })}

          {(() => {
            if (!selectedComponent || !selectedDefinition) return null;
            const component = selectedComponent;
            const definition = selectedDefinition;
            const geometry = benchGeometryFor(component.componentId);
            const allowedRoles = configuredRoleWhitelist(definition);
            const arrowKind = arrowKindByComponent[component.componentId];
            const canvasWidth = canvasRef.current?.clientWidth ?? 720;
            const flip = component.x + geometry.width + 248 > canvasWidth;
            return (
              <div
                className={`bench-popover${flip ? ' bench-popover--flip' : ''}`}
                style={{
                  left: flip ? component.x - 236 : component.x + geometry.width + 14,
                  top: Math.max(8, component.y - 4),
                }}
                role="dialog"
                aria-label={`${definition.label} 属性`}
              >
                <header>{definition.label}</header>
                {allowedRoles.length > 0 ? (
                  <label className="bench-popover__row">
                    <span>功能</span>
                    <select
                      aria-label={`${definition.label} 的功能角色`}
                      value={component.assignedRole ?? ''}
                      onChange={(event) => {
                        const assignedRole = event.target.value as BuilderGraphComponent['assignedRole'] | '';
                        patchComponent(component.instanceId, (entry) => {
                          const { assignedRole: _assignedRole, ...unassigned } = entry;
                          return assignedRole ? { ...unassigned, assignedRole } : unassigned;
                        });
                      }}
                    >
                      <option value="">不指定</option>
                      {allowedRoles.map((role) => (
                        <option key={role} value={role}>{roleLabels[role]}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {definition.kind === 'electrode' ? (
                  <label className="bench-popover__row">
                    <span>材料</span>
                    <select
                      aria-label={`${definition.label} 的电极材料`}
                      value={component.materialBinding?.materialId ?? 'generic-conductor'}
                      onChange={(event) => {
                        const selectedOption = materialOptions.find((option) => option.id === event.target.value)!;
                        patchComponent(component.instanceId, (entry) => ({
                          ...entry,
                          materialBinding: {
                            materialId: selectedOption.id,
                            specificity: selectedOption.specificity,
                          },
                        }));
                      }}
                    >
                      {materialOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {arrowKind ? (
                  <button
                    className="bench-popover__flip-direction"
                    onClick={() => patchComponent(component.instanceId, (entry) => ({
                      ...entry,
                      flipped: !entry.flipped,
                    }))}
                    type="button"
                    aria-label={`翻转 ${definition.label}`}
                  >
                    翻转方向({component.flipped ? '当前向左' : '当前向右'})
                  </button>
                ) : null}
                <button
                  className="bench-popover__delete"
                  onClick={() => removeComponent(component.instanceId)}
                  type="button"
                  aria-label={`移除 ${definition.label}`}
                >
                  删除
                </button>
              </div>
            );
          })()}
        </div>

        <aside className="bench__drawer component-tray" aria-label="组件托盘">
          <h3>器材库</h3>
          {shelfGroups.map((group) => {
            if (group.id === 'marker' && !annotate) return null;
            const members = config.components.filter(
              (component) => shelfGroupFor(component) === group.id,
            );
            if (members.length === 0) return null;
            return (
              <section className="bench__shelf-group" key={group.id}>
                <h4>{group.label}</h4>
                <div className="component-tray__list">
                  {members.map((component) => {
                    const presentation = presentationFor(component.id);
                    const arrowKind = arrowKindByComponent[component.id];
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
                        aria-label={`添加 ${component.label}`}
                      >
                        <span className="tray-item__visual" aria-hidden="true">
                          {arrowKind
                            ? <ArrowGlyph kind={arrowKind} width={44} height={19} />
                            : presentation.image
                              ? <img src={presentation.image} alt="" draggable={false} />
                              : <CircleDot />}
                        </span>
                        <span>{component.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </aside>
      </div>

      <div className="bench__footer">
        <div className="bench__assembly" aria-label="装配状态" aria-live="polite">
          {[...assembly.containment.entries()].map(([beakerId, inside]) => (
            <span className="bench__assembly-chip" key={beakerId}>
              {labelOf(beakerId)}:{inside.map(labelOf).join('、')}
            </span>
          ))}
          {assembly.wireAttachments.map((attachment) => (
            <span className="bench__assembly-chip" key={attachment.wireId}>
              {labelOf(attachment.wireId)}:{labelOf(attachment.a.electrodeId)} ↔ {labelOf(attachment.b.electrodeId)}
            </span>
          ))}
          {assembly.containment.size === 0 && assembly.wireAttachments.length === 0 ? (
            <span className="bench__assembly-chip bench__assembly-chip--empty">尚未装配:先把电极放入池中</span>
          ) : null}
        </div>
        {submitError ? <p className="form-error" role="alert">{submitError}</p> : null}
        <p className="bench__notice">电极浸入液面即接通内电路;导线夹自动咬合电极顶端。</p>
      </div>
    </div>
  );
}
