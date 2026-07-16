import { GraduationCap } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

import { useAppContext } from './AppContext';
import { ElectronFlowProgress } from './ElectronFlowProgress';
import { buildLearnerProfile } from '../../shared/scoring/profile';
import { SessionControls } from '../session/SessionControls';

export function AppShell() {
  const {
    config,
    session,
    setSession,
    persistenceError,
    historicalSessions,
    pretestComplete,
  } = useAppContext();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <NavLink className="brand" to="/pretest" aria-label="LuminousQuest 前测">
            <span>LQ</span>
            <strong>LuminousQuest</strong>
          </NavLink>
          <ElectronFlowProgress pretestComplete={pretestComplete} />
          <NavLink className="teacher-link" to="/teacher">
            <GraduationCap aria-hidden="true" />教师视图
          </NavLink>
        </div>
        <div className="session-bar">
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
          {persistenceError ? (
            <span className="session-persistence-error" role="alert">{persistenceError}</span>
          ) : null}
        </div>
      </header>
      <Outlet />
    </div>
  );
}
