import { Eraser, Pencil, RotateCcw, ScanSearch } from 'lucide-react';
import { useRef, useState } from 'react';

interface HandDrawingPanelProps {
  onReview: (imageData: string) => Promise<string>;
  onFinish: () => void;
}

type DrawingTool = 'pen' | 'eraser';

export function HandDrawingPanel({ onReview, onFinish }: HandDrawingPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [tool, setTool] = useState<DrawingTool>('pen');
  const [review, setReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const context = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    if (canvas.width !== Math.max(1, Math.round(bounds.width * devicePixelRatio))) {
      canvas.width = Math.max(1, Math.round(bounds.width * devicePixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * devicePixelRatio));
    }
    const value = canvas.getContext('2d');
    value?.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    return value;
  };

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  return (
    <section className="drawing-panel" aria-labelledby="drawing-title">
      <header>
        <div>
          <span>可选彩蛋</span>
          <h2 id="drawing-title">手绘你的通用模型</h2>
        </div>
        <div className="drawing-tools" aria-label="画板工具">
          <button
            className={tool === 'pen' ? 'is-active' : ''}
            onClick={() => setTool('pen')}
            type="button"
            aria-pressed={tool === 'pen'}
          >
            <Pencil aria-hidden="true" />画笔
          </button>
          <button
            className={tool === 'eraser' ? 'is-active' : ''}
            onClick={() => setTool('eraser')}
            type="button"
            aria-pressed={tool === 'eraser'}
          >
            <Eraser aria-hidden="true" />橡皮
          </button>
          <button
            onClick={() => {
              const canvas = canvasRef.current;
              const value = context();
              if (canvas && value) value.clearRect(0, 0, canvas.width, canvas.height);
              setReview(null);
            }}
            type="button"
          >
            <RotateCcw aria-hidden="true" />清空
          </button>
        </div>
      </header>
      <canvas
        ref={canvasRef}
        className="drawing-canvas"
        aria-label="手绘画板"
        onPointerDown={(event) => {
          const value = context();
          if (!value) return;
          const start = point(event);
          drawing.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          value.beginPath();
          value.moveTo(start.x, start.y);
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const value = context();
          if (!value) return;
          const next = point(event);
          const styles = getComputedStyle(document.documentElement);
          value.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
          value.strokeStyle = styles.getPropertyValue('--ink').trim();
          value.lineWidth = tool === 'eraser' ? 18 : 3;
          value.lineCap = 'round';
          value.lineJoin = 'round';
          value.lineTo(next.x, next.y);
          value.stroke();
        }}
        onPointerUp={() => { drawing.current = false; }}
        onPointerCancel={() => { drawing.current = false; }}
      />
      {review ? <aside className="drawing-review"><ScanSearch aria-hidden="true" /><p>{review}</p></aside> : null}
      <div className="drawing-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={async () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            setBusy(true);
            try {
              const imageData = canvas.toDataURL('image/png').split(',', 2)[1] ?? '';
              setReview(await onReview(imageData));
            } catch (error) {
              setReview(error instanceof Error ? error.message : '手绘点评暂不可用');
            } finally {
              setBusy(false);
            }
          }}
          type="button"
        >
          <ScanSearch aria-hidden="true" />{busy ? '正在点评' : '提交手绘点评'}
        </button>
        <button className="primary-button" onClick={onFinish} type="button">
          {review ? '查看诊断' : '跳过手绘，查看诊断'}
        </button>
      </div>
    </section>
  );
}
