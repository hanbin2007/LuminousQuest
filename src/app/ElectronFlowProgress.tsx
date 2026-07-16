import { NavLink, useLocation } from 'react-router-dom';

interface ElectronFlowProgressProps {
  pretestComplete: boolean;
  trainingComplete: boolean;
}

const stages = [
  { path: '/pretest', label: '前测' },
  { path: '/training', label: '训练' },
  { path: '/model', label: '外显' },
] as const;

export function ElectronFlowProgress({ pretestComplete, trainingComplete }: ElectronFlowProgressProps) {
  const { pathname } = useLocation();
  const routeIndex = Math.max(0, stages.findIndex((stage) => pathname.startsWith(stage.path)));
  const completed = trainingComplete ? 2 : pretestComplete ? 1 : 0;
  const progress = Math.min(100, completed * 50);
  const flowing = completed > 0 && completed < stages.length;

  return (
    <nav className="electron-progress" aria-label="电子流进度">
      <div className="electron-progress__track" style={{ '--progress': `${progress}%` } as React.CSSProperties}>
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
    </nav>
  );
}
