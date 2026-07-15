import { spawn } from 'node:child_process';

export function openBrowser(url: string, environment: NodeJS.ProcessEnv = process.env) {
  if (environment.LQ_NO_OPEN === '1' || environment.CI === 'true') return;

  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : { file: 'xdg-open', args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  child.on('error', (error) => {
    console.error(`[startup] Browser could not be opened automatically: ${error.message}`);
  });
}

