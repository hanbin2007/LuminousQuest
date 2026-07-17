import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useAppContext } from './AppContext';

interface ElectronFlowProgressProps {
  pretestComplete: boolean;
  trainingComplete: boolean;
}

const stages = [
  { path: '/pretest', label: '前测' },
  { path: '/training', label: '训练' },
  { path: '/model', label: '外显' },
] as const;

/** 测试阶段的手动阶段跳转(LQ_TEST_NAV=1 才渲染;悬浮面板,不改变头部高度)。 */
function TestStageJumps() {
  const { config, requestStageJump } = useAppContext();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const pretestStops = useMemo(() => [
    { label: '搭建', step: 0 },
    ...config.pretest.questions.map((_, index) => ({ label: `题${index + 1}`, step: index + 1 })),
    { label: '手绘', step: config.pretest.questions.length + 1 },
    { label: '诊断', step: config.pretest.questions.length + 2 },
  ], [config.pretest.questions]);
  const trainingStops = useMemo(() => [...config.cases]
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry, index) => ({
      label: entry.caseType === 'transfer' ? '冷迁移' : `案例${index + 1}`,
      caseId: entry.id,
    })), [config.cases]);

  const jumpPretest = (step: number) => {
    requestStageJump({ module: 'pretest', step });
    navigate('/pretest');
    setOpen(false);
  };
  const jumpTraining = (caseId: string) => {
    requestStageJump({ module: 'training', caseId });
    navigate('/training');
    setOpen(false);
  };
  const jumpRoute = (path: string) => {
    navigate(path);
    setOpen(false);
  };

  return (
    <div className="test-nav" ref={rootRef}>
      <button
        type="button"
        className="test-nav__trigger"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((current) => !current)}
      >
        测试
      </button>
      {open ? (
        <div className="test-nav__panel" role="group" aria-label="测试阶段跳转">
          <div className="test-nav__row" data-active={pathname.startsWith('/pretest') || undefined}>
            <span>前测</span>
            <div>
              {pretestStops.map((stop) => (
                <button key={stop.step} type="button" className="test-nav__stop" onClick={() => jumpPretest(stop.step)}>
                  {stop.label}
                </button>
              ))}
            </div>
          </div>
          <div className="test-nav__row" data-active={pathname.startsWith('/training') || undefined}>
            <span>训练</span>
            <div>
              {trainingStops.map((stop) => (
                <button key={stop.caseId} type="button" className="test-nav__stop" onClick={() => jumpTraining(stop.caseId)}>
                  {stop.label}
                </button>
              ))}
            </div>
          </div>
          <div className="test-nav__row" data-active={(pathname.startsWith('/model') || pathname.startsWith('/teacher')) || undefined}>
            <span>页面</span>
            <div>
              <button type="button" className="test-nav__stop" onClick={() => jumpRoute('/model')}>外显</button>
              <button type="button" className="test-nav__stop" onClick={() => jumpRoute('/teacher')}>教师</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ElectronFlowProgress({ pretestComplete, trainingComplete }: ElectronFlowProgressProps) {
  const { pathname } = useLocation();
  const { testNavigation } = useAppContext();
  const routeIndex = Math.max(0, stages.findIndex((stage) => pathname.startsWith(stage.path)));
  const completed = trainingComplete ? 2 : pretestComplete ? 1 : 0;
  const progress = Math.min(100, completed * 50);
  const flowing = completed > 0 && completed < stages.length;

  return (
    <nav className="electron-progress" aria-label="电子流进度">
      <div
        className="electron-progress__track"
        style={{ '--progress': `${progress}%`, '--progress-scale': `${progress / 100}` } as React.CSSProperties}
      >
        <span className="electron-progress__completed" />
        {flowing ? (
          <span className="electron-progress__dots" aria-hidden="true">
            <i /><i /><i />
          </span>
        ) : null}
      </div>
      <ol>
        {stages.map((stage, index) => (
          <li key={stage.path} data-complete={index < completed} data-current={index === routeIndex}>
            <NavLink to={stage.path}>{stage.label}</NavLink>
          </li>
        ))}
      </ol>
      {testNavigation ? <TestStageJumps /> : null}
    </nav>
  );
}
