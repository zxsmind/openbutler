import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTerminalServer } from '../../src/web/terminal-server.js';
import { parseTerminalInput } from '../../src/web/terminal-protocol.js';

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    fork: vi.fn(() => {
      const host = Object.assign(new EventEmitter(), {
        connected: true,
        send: vi.fn((message: { type: string }) => {
          if (message.type === 'start') queueMicrotask(() => host.emit('message', { type: 'ready', cwd: tmpdir() }));
        }),
        disconnect: vi.fn(() => {
          host.connected = false;
          queueMicrotask(() => host.emit('exit', 0));
        }),
        kill: vi.fn(),
      });
      return host;
    }),
  };
});

let server: Server;
let closeTerminals: () => void;
let url: string;
beforeEach(async () => {
  vi.clearAllMocks();
  server = createServer();
  closeTerminals = attachTerminalServer(server, {
    authorize: (request) => request.headers.cookie === 'paired=yes' && request.headers.origin === 'http://localhost',
    workspace: (sessionId) => (sessionId === 'current' ? tmpdir() : null),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  url = `ws://127.0.0.1:${address.port}/api/terminal?sessionId=current`;
});
afterEach(async () => {
  closeTerminals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const open = () => new WebSocket(url, { origin: 'http://localhost', headers: { cookie: 'paired=yes' } });
const ready = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.once('message', () => resolve());
    socket.once('error', reject);
  });

describe('workspace terminal host', () => {
  it('refuses unpaired and cross-origin upgrades before starting a shell', async () => {
    for (const options of [{ origin: 'http://localhost' }, { origin: 'http://other', headers: { cookie: 'paired=yes' } }]) {
      const socket = new WebSocket(url, options);
      await expect(new Promise((_, reject) => socket.once('error', reject))).rejects.toThrow('403');
    }
    expect(fork).not.toHaveBeenCalled();
  });
  it('refuses a stale session rather than choosing an unintended workspace', async () => {
    url = url.replace('current', 'stale');
    await expect(ready(open())).rejects.toThrow('409');
    expect(fork).not.toHaveBeenCalled();
  });
  it('delivers input and resize and disposes the shell when the connection closes', async () => {
    const socket = open();
    await ready(socket);
    const host = vi.mocked(fork).mock.results[0].value;
    socket.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledWith({ type: 'resize', cols: 100, rows: 30 }));
    expect(host.send).toHaveBeenCalledWith({ type: 'input', data: 'pwd\r' });
    socket.close();
    await vi.waitFor(() => expect(host.disconnect).toHaveBeenCalledOnce());
  });
  it('rejects invalid sizes and input without forwarding them to the shell', async () => {
    expect(parseTerminalInput({ type: 'resize', cols: 0, rows: 30 })).toBeNull();
    expect(parseTerminalInput({ type: 'resize', cols: 80.5, rows: 30 })).toBeNull();
    expect(parseTerminalInput({ type: 'input', data: 'x'.repeat(16385) })).toBeNull();
    const socket = open();
    await ready(socket);
    const host = vi.mocked(fork).mock.results[0].value;
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'resize', cols: -1, rows: 30 }));
    expect(await closed).toBe(1008);
    expect(host.send).toHaveBeenCalledExactlyOnceWith({ type: 'start', cwd: tmpdir() });
  });
});
