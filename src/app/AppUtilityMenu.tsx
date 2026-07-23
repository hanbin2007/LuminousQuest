import { Clapperboard, GraduationCap, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { buildLearnerProfile } from '../../shared/scoring/profile';
import { SessionControls } from '../session/SessionControls';
import { useAppContext } from './AppContext';

export function AppUtilityMenu() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const {
    config,
    session,
    setSession,
    persistenceError,
    historicalSessions,
    executionMode,
    demoModePending,
    demoModeError,
    toggleDemoMode,
  } = useAppContext();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = 'app-utility-menu-popover';
  const open = openPath === pathname;

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenPath(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenPath(null);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>('.app-utility-menu__popover button, .app-utility-menu__popover a')
        ?.focus();
    });
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="app-utility-menu" data-open={open || undefined} ref={rootRef}>
      <button
        aria-controls={popoverId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="课程与会话工具"
        className="app-utility-menu__trigger"
        onClick={() => setOpenPath((current) => current === pathname ? null : pathname)}
        ref={triggerRef}
        title="课程与会话工具"
        type="button"
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open ? (
        <div
          aria-label="课程与会话工具"
          className="app-utility-menu__popover ds-frame"
          id={popoverId}
          role="dialog"
        >
          <div className="session-bar__identity">
            <span>{session.anonymousStudentId}</span>
            <small>{config.pretest.version}</small>
          </div>
          <SessionControls
            session={session}
            historicalSessions={historicalSessions}
            onImport={(imported) => {
              if (JSON.stringify(imported.configVersions) !== JSON.stringify(session.configVersions)) {
                throw new Error('导入会话与当前配置版本不匹配');
              }
              try {
                buildLearnerProfile(imported, config);
              } catch {
                throw new Error('会话内容未通过深度校验，请确认文件未损坏或篡改。');
              }
              setSession(imported);
            }}
          />
          <div className="demo-mode-control">
            <button
              aria-checked={executionMode === 'demo'}
              aria-label="演示回放"
              className="demo-mode-switch"
              disabled={demoModePending}
              onClick={async () => {
                try {
                  const mode = await toggleDemoMode();
                  if (mode === 'demo') {
                    setOpenPath(null);
                    navigate('/training');
                  }
                } catch {
                  // The contextual error remains visible beside the control.
                }
              }}
              role="switch"
              type="button"
            >
              <Clapperboard aria-hidden="true" />
              <span>演示回放</span>
              <i aria-hidden="true" />
            </button>
            {executionMode === 'demo' ? <small>executionMode=demo</small> : null}
            {demoModeError ? <small className="demo-mode-error" role="alert">{demoModeError}</small> : null}
          </div>
          <NavLink className="teacher-link" to="/teacher">
            <GraduationCap aria-hidden="true" />教师视图
          </NavLink>
          {persistenceError ? (
            <span className="session-persistence-error" role="alert">{persistenceError}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
