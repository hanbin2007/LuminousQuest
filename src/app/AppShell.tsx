import { CircleDot } from 'lucide-react';
import { Suspense, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { useAppContext } from './AppContext';
import { AppUtilityMenu } from './AppUtilityMenu';
import { ElectronFlowProgress } from './ElectronFlowProgress';
import { routeContextLabel, routeDocumentTitle } from './route-config';

export function AppShell() {
  const { pathname } = useLocation();
  const {
    config,
    pretestComplete,
    trainingComplete,
  } = useAppContext();
  const contextLabel = routeContextLabel(config, pathname);

  useEffect(() => {
    document.title = routeDocumentTitle(config, pathname);
  }, [config, pathname]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <NavLink className="brand" to="/pretest" aria-label="LuminousQuest 前测">
            <CircleDot aria-hidden="true" />
            <strong>LuminousQuest</strong>
          </NavLink>
          <ElectronFlowProgress
            pretestComplete={pretestComplete}
            trainingComplete={trainingComplete}
          />
          <div className="app-header__context">
            <span aria-live="polite">{contextLabel}</span>
            <AppUtilityMenu />
          </div>
        </div>
      </header>
      <Suspense fallback={<main className="route-loading" aria-label="页面载入中" />}>
        <Outlet />
      </Suspense>
    </div>
  );
}
