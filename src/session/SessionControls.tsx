import { Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

import { exportSession, importSession } from '../../shared/session/session';
import type { StudentSession } from '../../shared/session/schema';

interface SessionControlsProps {
  session: StudentSession;
  onImport: (session: StudentSession) => void;
}

export function SessionControls({ session, onImport }: SessionControlsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const download = () => {
    const blob = new Blob([exportSession(session)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `luminous-quest-${session.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage('会话已导出');
  };

  return (
    <div className="session-controls">
      <button className="secondary-button" onClick={download} type="button">
        <Download aria-hidden="true" />导出会话 JSON
      </button>
      <button className="secondary-button" onClick={() => fileInput.current?.click()} type="button">
        <Upload aria-hidden="true" />导入会话 JSON
      </button>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        aria-label="导入会话 JSON 文件"
        accept="application/json,.json"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            const imported = importSession(await file.text());
            onImport(imported);
            setMessage('会话已导入');
          } catch (error) {
            setMessage(error instanceof Error ? error.message : '会话导入失败');
          } finally {
            event.target.value = '';
          }
        }}
      />
      {message ? <span className="session-controls__message" role="status">{message}</span> : null}
    </div>
  );
}
