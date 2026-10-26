import { fork } from 'node:child_process';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { parseTerminalInput, TERMINAL_ENDPOINT, type TerminalOutput } from './terminal-protocol.js';

/** Owns terminal connections. Native PTYs live in a separate, reusable Node host. */
export function attachTerminalServer(
  server: Server,
  options: {
    authorize: (request: IncomingMessage) => boolean;
    workspace: (sessionId: string) => string | null | Promise<string | null>;
  },
): () => void {
  const connections = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const alive = new Set<WebSocket>();
  let closed = false;
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (closed || url.pathname !== TERMINAL_ENDPOINT || !request.headers.origin || !options.authorize(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let cwd: string | null;
    try {
      cwd = await options.workspace(url.searchParams.get('sessionId') ?? '');
    } catch {
      cwd = null;
    }
    if (closed || socket.destroyed || !cwd || connections.clients.size >= 8) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    connections.handleUpgrade(request, socket, head, (connection) => {
      connections.emit('connection', connection, request);
      const host = fork(new URL('./terminal-host.mjs', import.meta.url), [], {
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const send = (message: TerminalOutput) => {
        if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
      };
      let finished = false;
      host.on('message', (message: TerminalOutput) => {
        if (connection.bufferedAmount > 1024 * 1024) {
          connection.close(1009, 'Terminal output overflow');
          if (host.connected) host.disconnect();
          return;
        }
        send(message);
        if (message.type === 'exit' || message.type === 'error') {
          finished = true;
          connection.close(message.type === 'exit' ? 1000 : 1011);
        }
      });
      host.on('error', (error) => {
        send({ type: 'error', message: error.message });
        connection.close(1011);
      });
      // Drain native diagnostics; failure is reported through the typed protocol.
      host.stderr?.resume();
      host.once('exit', () => {
        if (!finished) send({ type: 'error', message: 'Terminal host stopped.' });
        connection.close(finished ? 1000 : 1011);
      });
      connection.on('message', (raw, binary) => {
        try {
          const message = binary ? null : parseTerminalInput(JSON.parse(raw.toString()));
          if (!message) return connection.close(1008, 'Invalid terminal message');
          if (host.connected) host.send(message);
        } catch {
          connection.close(1008, 'Invalid terminal message');
        }
      });
      connection.once('close', () => {
        alive.delete(connection);
        if (host.connected) host.disconnect();
        // A blocked native host must not survive a closed tab indefinitely.
        const timeout = setTimeout(() => host.kill(), 3000);
        timeout.unref();
        host.once('exit', () => clearTimeout(timeout));
      });
      connection.on('error', () => connection.terminate());
      connection.on('pong', () => alive.add(connection));
      alive.add(connection);
      host.send({ type: 'start', cwd });
    });
  });
  const heartbeat = setInterval(() => {
    for (const connection of connections.clients) {
      if (!alive.delete(connection)) connection.terminate();
      else connection.ping();
    }
  }, 30000);
  heartbeat.unref();
  return () => {
    closed = true;
    clearInterval(heartbeat);
    for (const connection of connections.clients) connection.terminate();
    connections.close();
  };
}
