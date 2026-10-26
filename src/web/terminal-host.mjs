// Native PTY work runs outside the web process, without development loaders.
// Electron can use this same host with ELECTRON_RUN_AS_NODE.
import { spawn } from 'node-pty';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { release } from 'node:os';

let terminal;
let exited = false;
function send(message) {
  if (process.connected) process.send(message);
}
function stop() {
  if (!terminal || exited) process.exit(0);
  try {
    terminal.kill();
    // Windows enumerates and stops console children asynchronously.
    setTimeout(() => process.exit(0), 1500);
  } catch {
    process.exit(0);
  }
}
process.on('disconnect', stop);
process.on('message', (message) => {
  try {
    if (message.type === 'start' && !terminal) {
      terminal = spawn(
        process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh',
        process.platform === 'win32' ? ['-NoLogo'] : [],
        {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: message.cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
        },
      );
      terminal.onData((data) => send({ type: 'output', data }));
      terminal.onExit(({ exitCode }) => {
        exited = true;
        send({ type: 'exit', code: exitCode });
        if (process.connected) process.disconnect();
        else process.exit(0);
      });
      send({
        type: 'ready',
        cwd: message.cwd,
        ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: Number(release().split('.')[2]) } } : {}),
      });
    } else if (message.type === 'input') terminal?.write(message.data);
    else if (message.type === 'resize') terminal?.resize(message.cols, message.rows);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    stop();
  }
});
