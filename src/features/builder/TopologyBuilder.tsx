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
import { deriveAssembly, runningElectrodeIds } from './assembly';
import { BenchCanvas } from './BenchCanvas';
import { benchGeometryFor, presentationFor } from './presentation';

const dragMime = 'application/x-lq-component';
const layoutMargin = 24;
const layoutCellWidth = 170;
const layoutCellHeight = 200;
/** 拖动判定阈值:超过才算拖,保住点击选中。 */
const dragThreshold = 3;

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

interface DragSession {
  instanceId: string;
  pointerId: number;
  originX: number;
  originY: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

export function TopologyBuilder({ config, initialValue, onChange, onSubmit }: TopologyBuilderProps) {
  const [value, setValue] = useState<BuilderAnswer>(initialValue ?? { components: [], connections: [] });
  const [annotate, setAnnotate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapFlash, setSnapFlash] = useState<{ x: number; y: number; key: string } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  /** 拖动结束后吞掉紧随的 click,避免误触发选中切换。 */
  const suppressClickRef = useRef(false);
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
  const running = useMemo(
    () => runningElectrodeIds(assembly, value.components, definitionById),
    [assembly, value.components, definitionById],
  );

  const valueRef = useRef(value);
  valueRef.current = value;

  const answerFor = (components: PlacedBuilderComponent[]): BuilderAnswer => ({
    components,
    connections: deriveAssembly(components, definitionById).connections,
  });

  const update = (components: PlacedBuilderComponent[]) => {
    const next = answerFor(components);
    setValue(next);
    onChange?.(next);
  };

  /** 钳制到舞台内(固定舞台无滚动,器材必须整体可见)。 */
  const clampToStage = (point: { x: number; y: number }, componentId: string) => {
    const geometry = benchGeometryFor(componentId);
    const bounds = canvasRef.current?.getBoundingClientRect();
    const maxX = Math.max(0, (bounds?.width ?? 720) - geometry.width);
    const maxY = Math.max(0, (bounds?.height ?? 480) - geometry.height);
    return {
      x: Math.min(maxX, Math.max(0, point.x)),
      y: Math.min(maxY, Math.max(0, point.y)),
    };
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
    const columns = Math.max(1, Math.floor(canvasWidth / (layoutCellWidth + layoutMargin)));
    const nextPoint = clampToStage(point ?? {
      x: layoutMargin + (index % columns) * (layoutCellWidth + layoutMargin),
      y: layoutMargin + Math.floor(index / columns) * (layoutCellHeight + layoutMargin),
    }, componentId);
    const component: PlacedBuilderComponent = {
      instanceId: createInstanceId(componentId),
      componentId,
      label: definition.label,
      ...(definition.kind === 'electrode'
        ? { materialBinding: { materialId: 'generic-conductor', specificity: 'generic' as const } }
        : {}),
      ...nextPoint,
    };
    update([...value.components, component]);
    setSnapFlash({ x: component.x, y: component.y, key: component.instanceId });
  };

  const removeComponent = (instanceId: string) => {
    update(value.components.filter((component) => component.instanceId !== instanceId));
    if (selected === instanceId) setSelected(null);
  };

  /**
   * 指针拖动:1:1 跟手,装配关系(咬合/浸没)边拖边算;仅在松手时通知上游持久化。
   * 按下后监听挂在 window 上——不用指针捕获(捕获会把派生 click 重定向,杀掉
   * "点击弹属性泡"),也不怕指针一步跳出节点丢事件。
   */
  const beginDrag = (component: PlacedBuilderComponent, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    const session: DragSession = {
      instanceId: component.instanceId,
      pointerId: event.pointerId,
      originX: component.x,
      originY: component.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    dragRef.current = session;
    const { componentId, instanceId } = component;

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== session.pointerId) return;
      const dx = moveEvent.clientX - session.startClientX;
      const dy = moveEvent.clientY - session.startClientY;
      if (!session.moved) {
        if (Math.hypot(dx, dy) < dragThreshold) return;
        session.moved = true;
        setDraggingId(instanceId);
      }
      const point = clampToStage({ x: session.originX + dx, y: session.originY + dy }, componentId);
      setValue((previous) => answerFor(previous.components.map((entry) =>
        entry.instanceId === instanceId ? { ...entry, ...point } : entry)));
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== session.pointerId) return;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      dragRef.current = null;
      setDraggingId(null);
      if (session.moved && endEvent.type === 'pointerup') {
        suppressClickRef.current = true;
        onChange?.(valueRef.current);
      }
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
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
          onClick={(event) => {
            if (event.target === canvasRef.current) setSelected(null);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const componentId = event.dataTransfer.getData(dragMime);
            const bounds = canvasRef.current?.getBoundingClientRect();
            if (!bounds || !componentId) return;
            const geometry = benchGeometryFor(componentId);
            addComponent(componentId, {
              x: event.clientX - bounds.left - geometry.width / 2,
              y: event.clientY - bounds.top - geometry.height / 2,
            });
          }}
        >
          <BenchCanvas
            scene={{
              components: value.components,
              definitionById,
              assembly,
              selectedId: selected,
              annotate,
              running,
            }}
            flash={snapFlash}
            reducedMotion={reducedMotion}
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
                className={`builder-node${selected === component.instanceId ? ' is-selected' : ''}${contained ? ' is-contained' : ''}${draggingId === component.instanceId ? ' is-dragging' : ''}${zClass}`}
                key={component.instanceId}
                onPointerDown={(event) => beginDrag(component, event)}
                style={{ left: component.x, top: component.y, width: geometry.width }}
              >
                <button
                  className="builder-node__target"
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
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
