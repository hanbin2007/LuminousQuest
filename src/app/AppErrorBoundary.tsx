import { Download, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { exportSession } from '../../shared/session/session';
import type { StudentSession } from '../../shared/session/schema';

interface AppErrorBoundaryProps {
  children: ReactNode;
  session: StudentSession;
  onReset: () => void;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render failed', error, info.componentStack);
  }

  private download = () => {
    const blob = new Blob([exportSession(this.props.session)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `luminous-quest-${this.props.session.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  private reset = () => {
    this.props.onReset();
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-state" role="alert">
        <h1>页面暂时无法继续</h1>
        <p>可以先导出当前会话，再重置本地状态继续作答。</p>
        <div className="fatal-state__actions">
          <button className="secondary-button" onClick={this.download} type="button">
            <Download aria-hidden="true" />导出会话
          </button>
          <button className="primary-button" onClick={this.reset} type="button">
            <RotateCcw aria-hidden="true" />重置
          </button>
        </div>
      </main>
    );
  }
}
