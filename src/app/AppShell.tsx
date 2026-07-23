import { CircleDot } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { AgentActivityPanel } from '../agent/AgentActivityPanel';
import { AmbientChemistryBackdrop } from './AmbientChemistryBackdrop';
import { useAppContext } from './AppContext';
import { AppUtilityMenu } from './AppUtilityMenu';
import { ElectronFlowProgress } from './ElectronFlowProgress';
import { routeContextLabel, routeDocumentTitle } from './route-config';

interface LLMHealth {
  provider: string;
  model: string;
  status: 'ok' | 'degraded' | 'down';
  detail: string;
}

function parseLLMHealth(value: unknown): LLMHealth {
  if (
    !value
    || typeof value !== 'object'
    || !('provider' in value)
    || typeof value.provider !== 'string'
    || !('model' in value)
    || typeof value.model !== 'string'
    || !('status' in value)
    || !['ok', 'degraded', 'down'].includes(String(value.status))
    || !('detail' in value)
    || typeof value.detail !== 'string'
  ) {
    throw new Error('Invalid LLM health response');
  }
  return value as LLMHealth;
}

export function AppShell() {
  const { pathname } = useLocation();
  const {
    config,
    executionMode,
    pretestComplete,
    trainingComplete,
  } = useAppContext();
  const [llmHealth, setLLMHealth] = useState<LLMHealth | null>(null);
  const contextLabel = routeContextLabel(config, pathname);

  useEffect(() => {
    document.title = routeDocumentTitle(config, pathname);
  }, [config, pathname]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/llm/health', {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`LLM health returned ${response.status}`);
        const health = parseLLMHealth(await response.json());
        if (active) setLLMHealth(health);
      } catch {
        if (active) {
          setLLMHealth({
            provider: 'unavailable',
            model: 'unavailable',
            status: 'down',
            detail: 'AI 通道状态无法读取',
          });
        }
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [executionMode]);

  const badge = executionMode === 'demo' || llmHealth?.provider === 'mock'
    ? {
        state: 'demo',
        label: 'demo',
        title: llmHealth?.detail ?? '演示回放模式，未调用在线 AI',
      }
    : llmHealth?.status === 'ok'
      ? {
          state: 'live',
          label: 'live',
          title: `${llmHealth.provider} / ${llmHealth.model}：${llmHealth.detail}`,
        }
      : llmHealth
        ? {
            state: 'fault',
            label: '故障',
            title: 'AI 通道不可用，作答将转人工复核。',
          }
        : {
            state: 'checking',
            label: '检测中',
            title: '正在检查 AI 通道',
          };

  return (
    <div className="app-shell">
      <AmbientChemistryBackdrop />
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
            <div
              aria-label={`AI 通道状态：${badge.label}`}
              aria-live="polite"
              className={`llm-provider-badge llm-provider-badge--${badge.state}`}
              role="status"
              title={badge.title}
            >
              <i aria-hidden="true" />
              <span>{badge.label}</span>
            </div>
            <AppUtilityMenu />
          </div>
        </div>
      </header>
      <Suspense fallback={<main className="route-loading" aria-label="页面载入中" />}>
        <Outlet />
      </Suspense>
      <AgentActivityPanel />
    </div>
  );
}
