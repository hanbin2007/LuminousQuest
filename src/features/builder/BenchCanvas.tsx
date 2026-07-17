import { useEffect, useRef } from 'react';

import { renderBench, type BenchScene } from './bench-renderer';

interface BenchCanvasProps {
  scene: Omit<BenchScene, 'width' | 'height' | 'dpr' | 'flash' | 'time'>;
  /** 吸附/落位闪光请求:key 变化触发一次 ~360ms 突发动画。 */
  flash: { x: number; y: number; key: string } | null;
  reducedMotion: boolean;
}

/**
 * 工作台画布宿主:按需重画(状态变化/图片就绪/尺寸变化),默认无常驻 rAF;
 * 仅两处动画:吸附闪光的短促突发,和装置结构闭合期间的运行气泡循环
 * (reduced-motion 下退化为静态气泡帧)。画布严格贴合舞台尺寸(固定舞台,不产生滚动)。
 * jsdom/无 2D 上下文时整体空转(命中层照常工作)。
 */
export function BenchCanvas({ scene, flash, reducedMotion }: BenchCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const flashRef = useRef<{ x: number; y: number; progress: number } | null>(null);
  const timeRef = useRef(0);

  const paint = () => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    renderBench(context, {
      ...sceneRef.current,
      width,
      height,
      dpr,
      time: timeRef.current,
      flash: flashRef.current,
    }, () => paint());
  };

  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    paintRef.current();
  });

  const runningActive = scene.running.size > 0;
  useEffect(() => {
    if (!runningActive || reducedMotion) {
      timeRef.current = 0;
      paintRef.current();
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      timeRef.current = now;
      paintRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      timeRef.current = 0;
    };
  }, [runningActive, reducedMotion]);

  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => paintRef.current());
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!flash) return;
    if (reducedMotion) {
      flashRef.current = null;
      paintRef.current();
      return;
    }
    const startedAt = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const progress = Math.min((now - startedAt) / 360, 1);
      flashRef.current = progress < 1 ? { x: flash.x, y: flash.y, progress } : null;
      paintRef.current();
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      flashRef.current = null;
    };
  }, [flash, reducedMotion]);

  return <canvas className="bench-canvas-layer" ref={canvasRef} aria-hidden="true" />;
}
