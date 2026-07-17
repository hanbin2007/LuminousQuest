/**
 * 3D 舞台共享相机物理(模块三 KnowledgeScene 与训练分屏 CellScene 同手感)。
 *
 * 流体交互三件套(Designing Fluid Interfaces 的 web/3D 落地):
 * - 拖拽 1:1 且持续追踪指针速度;松手把速度交接给惯性,按指数衰减滑行(动量投射);
 * - 俯仰越界不硬停:拖拽中按 rubber-band 渐进阻尼,松手用临界阻尼弹簧拉回边界;
 * - 滚轮只改目标半径,每帧指数趋近,缩放不再瞬跳。
 * reduced-motion 下无惯性、无回弹动画、缩放直达——拖拽仍 1:1。
 * 全部状态就地更新,useFrame 路径零分配。
 */

export interface OrbitState {
  yaw: number;
  pitch: number;
  radius: number;
  targetRadius: number;
  /** rad/s,由 pointermove 历史指数平滑而来,松手后驱动惯性。 */
  yawVelocity: number;
  pitchVelocity: number;
  dragging: boolean;
  lastX: number;
  lastY: number;
  lastT: number;
  idleAt: number;
}

export interface OrbitBounds {
  minPitch: number;
  maxPitch: number;
  minRadius: number;
  maxRadius: number;
}

const DRAG_YAW = 0.005; // rad/px
const DRAG_PITCH = 0.004;
const INERTIA_DECAY = 4.2; // s⁻¹:松手滑行 ~0.24s 衰减至 1/e,近滚动减速手感
const PITCH_SPRING = 90; // 越界回弹弹簧刚度(配临界阻尼)
const ZOOM_SMOOTH = 11; // 缩放每秒趋近速率
const VELOCITY_BLEND = 0.4; // 速度低通:新样本权重
const SETTLE = 0.002; // 低于此速度视为静止

export function createOrbitState(initial: { yaw: number; pitch: number; radius: number }): OrbitState {
  return {
    yaw: initial.yaw,
    pitch: initial.pitch,
    radius: initial.radius,
    targetRadius: initial.radius,
    yawVelocity: 0,
    pitchVelocity: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    idleAt: 0,
  };
}

/** 拖拽越界时的渐进阻力:越深越跟不动,永不硬停。 */
function overshootResistance(overshoot: number) {
  return 1 / (1 + 9 * Math.abs(overshoot));
}

export interface OrbitHooks {
  down?: (event: PointerEvent) => void;
  move?: (event: PointerEvent) => void;
  up?: () => void;
  /** 任意输入(含滚轮)后调用;demand 帧循环下宿主用它触发 invalidate,保证拖拽/缩放 1:1 出帧。 */
  input?: () => void;
}

export function attachOrbitControls(
  element: HTMLElement,
  state: OrbitState,
  bounds: OrbitBounds,
  hooks?: OrbitHooks,
) {
  const down = (event: PointerEvent) => {
    state.dragging = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastT = event.timeStamp;
    // 抓住滑行中的场景:从当前值继续,旧动量立即归拖拽接管
    state.yawVelocity = 0;
    state.pitchVelocity = 0;
    hooks?.down?.(event);
    hooks?.input?.();
  };
  const move = (event: PointerEvent) => {
    if (!state.dragging) return;
    hooks?.move?.(event);
    const dt = Math.max((event.timeStamp - state.lastT) / 1000, 1 / 240);
    const dyaw = -(event.clientX - state.lastX) * DRAG_YAW;
    let dpitch = (event.clientY - state.lastY) * DRAG_PITCH;
    const over = state.pitch < bounds.minPitch
      ? state.pitch - bounds.minPitch
      : state.pitch > bounds.maxPitch
        ? state.pitch - bounds.maxPitch
        : 0;
    if (over !== 0 && Math.sign(dpitch) === Math.sign(over)) {
      dpitch *= overshootResistance(over);
    }
    state.yaw += dyaw;
    state.pitch += dpitch;
    state.yawVelocity = state.yawVelocity * (1 - VELOCITY_BLEND) + (dyaw / dt) * VELOCITY_BLEND;
    state.pitchVelocity = state.pitchVelocity * (1 - VELOCITY_BLEND) + (dpitch / dt) * VELOCITY_BLEND;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastT = event.timeStamp;
    state.idleAt = performance.now();
    hooks?.input?.();
  };
  const up = () => {
    state.dragging = false;
    state.idleAt = performance.now();
    hooks?.up?.();
    hooks?.input?.();
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    state.targetRadius = Math.min(
      bounds.maxRadius,
      Math.max(bounds.minRadius, state.targetRadius + event.deltaY * 0.01),
    );
    state.idleAt = performance.now();
    hooks?.input?.();
  };
  element.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  element.addEventListener('wheel', wheel, { passive: false });
  return () => {
    element.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    element.removeEventListener('wheel', wheel);
  };
}

/** 每帧推进惯性/回弹/缩放。必须在 useFrame 中调用;零分配。 */
export function stepOrbit(
  state: OrbitState,
  bounds: OrbitBounds,
  delta: number,
  reducedMotion: boolean,
) {
  const dt = Math.min(delta, 1 / 20);
  if (reducedMotion) {
    state.yawVelocity = 0;
    state.pitchVelocity = 0;
    state.radius = state.targetRadius;
    if (!state.dragging) {
      state.pitch = Math.min(bounds.maxPitch, Math.max(bounds.minPitch, state.pitch));
    }
    return;
  }
  if (!state.dragging) {
    // 动量滑行 + 指数衰减(松手速度无缝交接)
    state.yaw += state.yawVelocity * dt;
    state.yawVelocity *= Math.exp(-INERTIA_DECAY * dt);
    if (Math.abs(state.yawVelocity) < SETTLE) state.yawVelocity = 0;

    const bound = state.pitch < bounds.minPitch
      ? bounds.minPitch
      : state.pitch > bounds.maxPitch
        ? bounds.maxPitch
        : null;
    if (bound !== null) {
      // 临界阻尼弹簧拉回边界:无过冲,承接当前速度
      state.pitchVelocity += (bound - state.pitch) * PITCH_SPRING * dt;
      state.pitchVelocity *= Math.exp(-2 * Math.sqrt(PITCH_SPRING) * dt);
      state.pitch += state.pitchVelocity * dt;
      if (Math.abs(bound - state.pitch) < 0.0005 && Math.abs(state.pitchVelocity) < SETTLE) {
        state.pitch = bound;
        state.pitchVelocity = 0;
      }
    } else {
      state.pitch += state.pitchVelocity * dt;
      state.pitchVelocity *= Math.exp(-INERTIA_DECAY * dt);
      if (Math.abs(state.pitchVelocity) < SETTLE) state.pitchVelocity = 0;
    }
  }
  state.radius += (state.targetRadius - state.radius) * (1 - Math.exp(-ZOOM_SMOOTH * dt));
}
