import type { PretestConfig } from '../../../shared/config/schemas';
import { liquidRectOf, type AssemblyState } from './assembly';
import {
  benchGeometryFor,
  electrodeImageFor,
  presentationFor,
} from './presentation';
import type { PlacedBuilderComponent } from './TopologyBuilder';

/**
 * 工作台 Canvas2D 渲染器(NOBOOK 式单画布精灵引擎的专用轻量版)。
 * 只负责"画":全部状态来自组件坐标 + deriveAssembly 推导,自身零状态、可任意重画。
 * 关键真实感均靠绘制次序与裁剪完成:
 *   网格 → 烧杯(玻璃+液体位图)→ 电极精灵 → 液面区域二次覆绘(半透明,成浸没)
 *   → 导线弧(描边电缆质感+鳄鱼夹)→ 方向箭头(标注图层)→ 选中辉光 / 吸附闪光。
 */

export interface BenchScene {
  components: readonly PlacedBuilderComponent[];
  definitionById: ReadonlyMap<string, PretestConfig['builder']['components'][number]>;
  assembly: AssemblyState;
  selectedId: string | null;
  annotate: boolean;
  /** 结构闭合、正在"工作"的电极(纯视觉运行迹象,不进判分)。 */
  running: ReadonlySet<string>;
  width: number;
  height: number;
  dpr: number;
  /** 运行动画时钟(ms);0 = 静态帧(reduced-motion / 非运行态)。 */
  time: number;
  /** 吸附闪光(短促 rAF 突发):progress 0→1。 */
  flash?: { x: number; y: number; progress: number } | null;
}

const COLORS = {
  bg: '#e8ecef',
  label: '#26262b',
  labelShadow: 'rgba(255, 255, 255, 0.92)',
  wireCore: '#5d86d8',
  wireOutline: 'rgba(28, 34, 42, 0.76)',
  wireInsulated: '#676f78',
  clip: '#aeb5be',
  select: 'rgba(122, 167, 255, 0.95)',
  flash: 'rgba(69, 224, 210, 0.85)',
  arrow: { electron: '#8fb8ff', cation: '#ffb84d', anion: '#45e0d2' } as const,
};

const arrowKindByComponent: Record<string, 'electron' | 'cation' | 'anion'> = {
  'electron-arrow': 'electron',
  'cation-arrow': 'cation',
  'anion-arrow': 'anion',
};

/** 位图缓存:加载完成后通过 onReady 请求宿主重画。 */
const imageCache = new Map<string, HTMLImageElement>();

function getImage(url: string, onReady: () => void): HTMLImageElement | null {
  const cached = imageCache.get(url);
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  image.onload = onReady;
  imageCache.set(url, image);
  return null;
}

function spriteUrlFor(
  component: PlacedBuilderComponent,
  definition: PretestConfig['builder']['components'][number],
): string | undefined {
  if (definition.kind === 'electrode') return electrodeImageFor(component.materialBinding?.materialId);
  return presentationFor(component.componentId).image;
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  component: PlacedBuilderComponent,
  definition: PretestConfig['builder']['components'][number],
  onReady: () => void,
) {
  const geometry = benchGeometryFor(component.componentId);
  const url = spriteUrlFor(component, definition);
  if (!url) return;
  const image = getImage(url, onReady);
  if (!image) return;
  ctx.save();
  ctx.shadowColor = 'rgba(35, 40, 60, 0.22)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  ctx.drawImage(image, component.x, component.y, geometry.width, geometry.height);
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.save();
  ctx.font = '600 12px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.shadowColor = COLORS.labelShadow;
  ctx.shadowBlur = 4;
  ctx.fillStyle = COLORS.label;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawWire(
  ctx: CanvasRenderingContext2D,
  scene: BenchScene,
  wire: PlacedBuilderComponent,
  insulated: boolean,
) {
  const attachment = scene.assembly.wireAttachments.find((entry) => entry.wireId === wire.instanceId);
  if (!attachment) return false;
  const geometry = benchGeometryFor(wire.componentId);
  const grip = { x: wire.x + geometry.width / 2, y: wire.y + geometry.height / 2 };
  const sagA = Math.max(attachment.a.y, grip.y) + 18;
  const sagB = Math.max(attachment.b.y, grip.y) + 18;

  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(attachment.a.x, attachment.a.y);
    ctx.quadraticCurveTo((attachment.a.x + grip.x) / 2, sagA, grip.x, grip.y);
    ctx.quadraticCurveTo((grip.x + attachment.b.x) / 2, sagB, attachment.b.x, attachment.b.y);
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.wireOutline;
  ctx.lineWidth = 7;
  trace();
  ctx.stroke();
  ctx.strokeStyle = insulated ? COLORS.wireInsulated : COLORS.wireCore;
  ctx.lineWidth = 4.5;
  trace();
  ctx.stroke();

  for (const end of [attachment.a, attachment.b]) {
    ctx.fillStyle = COLORS.clip;
    ctx.strokeStyle = COLORS.wireOutline;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(end.x - 6, end.y - 5, 12, 10, 2.5);
    else ctx.rect(end.x - 6, end.y - 5, 12, 10);
    ctx.fill();
    ctx.stroke();
  }

  // 抓握点(与命中层的小圆点同位)
  ctx.fillStyle = 'rgba(38, 43, 50, 0.82)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(grip.x, grip.y, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  return true;
}

function seedOf(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function unitPhase(value: number) {
  if (!Number.isFinite(value)) return 0;
  return ((value % 1) + 1) % 1;
}

/**
 * 运行迹象:沿浸没电极两侧上浮的空心小气泡(STYLE §3 气泡惯例)。
 * time=0 时输出确定性的静态分布(reduced-motion 同样能读出"在工作")。
 */
function drawRunningBubbles(
  ctx: CanvasRenderingContext2D,
  electrode: PlacedBuilderComponent,
  liquidTop: number,
  time: number,
) {
  const geometry = benchGeometryFor(electrode.componentId);
  const bottom = electrode.y + geometry.height * 0.96;
  const travel = bottom - liquidTop - 6;
  if (travel <= 12) return;
  const seed = seedOf(electrode.instanceId);
  const animationTime = Number.isFinite(time) ? time : 0;
  ctx.save();
  ctx.lineWidth = 1.2;
  for (let index = 0; index < 7; index += 1) {
    // Unsigned shifts keep UUID-derived seeds in the expected [0, n) range.
    const offset = ((seed >>> (index * 3)) % 97) / 97;
    const speed = 0.00009 + (((seed >>> (index * 2)) % 13) / 13) * 0.00006;
    const phase = unitPhase(offset + animationTime * speed);
    const side = index % 2 === 0 ? -3 : geometry.width + 3;
    const wobble = Math.sin(animationTime * 0.003 + index * 2.1 + offset * 6) * 1.6;
    const x = electrode.x + side + wobble;
    const y = bottom - phase * travel;
    const radius = 1.1 + phase * 1.5;
    ctx.strokeStyle = `rgba(255, 255, 255, ${(0.55 * (1 - phase * 0.55)).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  component: PlacedBuilderComponent,
  kind: 'electron' | 'cation' | 'anion',
  bound: boolean,
) {
  const geometry = benchGeometryFor(component.componentId);
  const cx = component.x + geometry.width / 2;
  const cy = component.y + geometry.height / 2;
  ctx.save();
  ctx.translate(cx, cy);
  if (component.flipped) ctx.scale(-1, 1);
  ctx.globalAlpha = bound ? 1 : 0.45;
  ctx.strokeStyle = COLORS.arrow[kind];
  ctx.fillStyle = COLORS.arrow[kind];
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 5;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-geometry.width / 2 + 6, 0);
  ctx.lineTo(geometry.width / 2 - 14, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(geometry.width / 2 - 16, -8);
  ctx.lineTo(geometry.width / 2 - 2, 0);
  ctx.lineTo(geometry.width / 2 - 16, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function renderBench(ctx: CanvasRenderingContext2D, scene: BenchScene, onReady: () => void) {
  const { width, height, dpr } = scene;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // 底色(自由摆放,无网格)
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const byKind = (predicate: (definition: PretestConfig['builder']['components'][number]) => boolean) =>
    scene.components.filter((component) => {
      const definition = scene.definitionById.get(component.componentId);
      return definition ? predicate(definition) : false;
    });

  const beakers = byKind((definition) => definition.kind === 'ion-conductor'
    || definition.kind === 'container'
    || (definition.kind === 'distractor' && Boolean(definition.allowedRoles?.includes('ion-conductor'))));
  const electrodes = byKind((definition) => definition.kind === 'electrode');
  const wires = byKind((definition) => definition.kind === 'electron-conductor'
    || (definition.kind === 'distractor' && !definition.allowedRoles?.includes('ion-conductor')));

  // 1. 烧杯(背景层)
  for (const beaker of beakers) {
    const definition = scene.definitionById.get(beaker.componentId)!;
    drawSprite(ctx, beaker, definition, onReady);
  }

  // 2. 电极
  for (const electrode of electrodes) {
    const definition = scene.definitionById.get(electrode.componentId)!;
    drawSprite(ctx, electrode, definition, onReady);
  }

  // 3. 液面区域二次覆绘:被容纳电极呈浸没态(液体+玻璃盖在其上)
  for (const beaker of beakers) {
    const inside = scene.assembly.containment.get(beaker.instanceId);
    if (!inside || inside.length === 0) continue;
    const definition = scene.definitionById.get(beaker.componentId)!;
    const geometry = benchGeometryFor(beaker.componentId);
    const url = spriteUrlFor(beaker, definition);
    const image = url ? getImage(url, onReady) : null;
    if (!image) continue;
    const rect = liquidRectOf(beaker);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
    ctx.clip();
    ctx.globalAlpha = 0.6;
    ctx.drawImage(image, beaker.x, beaker.y, geometry.width, geometry.height);
    ctx.restore();

    // 3b. 运行迹象:结构闭合后,浸没电极表面冒出上浮气泡(液面矩形内裁剪)
    const runningInside = inside.filter((id) => scene.running.has(id));
    if (runningInside.length > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
      ctx.clip();
      for (const electrodeId of runningInside) {
        const electrode = scene.components.find((entry) => entry.instanceId === electrodeId);
        if (electrode) drawRunningBubbles(ctx, electrode, rect.top, scene.time);
      }
      ctx.restore();
    }
  }

  // 4. 导线(已咬合画电缆弧;未咬合画位图) + 5. 其余精灵
  const attachedWireIds = new Set<string>();
  for (const wire of wires) {
    const definition = scene.definitionById.get(wire.componentId)!;
    const drawn = drawWire(ctx, scene, wire, definition.kind === 'distractor');
    if (drawn) attachedWireIds.add(wire.instanceId);
    else drawSprite(ctx, wire, definition, onReady);
  }

  // 6. 方向箭头(标注图层)
  if (scene.annotate) {
    for (const component of scene.components) {
      const kind = arrowKindByComponent[component.componentId];
      if (!kind) continue;
      drawArrow(ctx, component, kind, scene.assembly.arrowBindings.has(component.instanceId));
    }
  }

  // 7. 名称标签(已咬合导线的标签挂在抓握点下)
  for (const component of scene.components) {
    const kind = arrowKindByComponent[component.componentId];
    if (kind && !scene.annotate) continue;
    // 已绑定的箭头颜色与指向自明,省去名称避免池内文字堆叠
    if (kind && scene.assembly.arrowBindings.has(component.instanceId)) continue;
    const definition = scene.definitionById.get(component.componentId);
    if (!definition) continue;
    const geometry = benchGeometryFor(component.componentId);
    const cx = component.x + geometry.width / 2;
    const cy = attachedWireIds.has(component.instanceId)
      ? component.y + geometry.height / 2 + 12
      : component.y + geometry.height + 6;
    drawLabel(ctx, definition.label, cx, cy);
  }

  // 8. 选中辉光
  if (scene.selectedId) {
    const component = scene.components.find((entry) => entry.instanceId === scene.selectedId);
    if (component) {
      const geometry = benchGeometryFor(component.componentId);
      ctx.save();
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = COLORS.select;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(component.x - 6, component.y - 6, geometry.width + 12, geometry.height + 12, 8);
      } else {
        ctx.rect(component.x - 6, component.y - 6, geometry.width + 12, geometry.height + 12);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // 9. 吸附闪光
  if (scene.flash) {
    const { x, y, progress } = scene.flash;
    ctx.save();
    ctx.globalAlpha = (1 - progress) * 0.9;
    ctx.strokeStyle = COLORS.flash;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(x, y, 10 + progress * 26, 5 + progress * 13, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}
