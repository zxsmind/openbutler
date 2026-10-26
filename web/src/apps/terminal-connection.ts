import { TERMINAL_ENDPOINT, type TerminalInput, type TerminalOutput } from '../../../src/web/terminal-protocol.js';

/** Browser transport stays outside terminal rendering so a desktop host can replace it. */
export function connectTerminal(sessionId: string, receive: (message: TerminalOutput) => void, closed: () => void) {
  const url = new URL(TERMINAL_ENDPOINT, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('sessionId', sessionId);
  const socket = new WebSocket(url);
  socket.onmessage = (event) => {
    try {
      receive(JSON.parse(event.data) as TerminalOutput);
    } catch {
      socket.close();
    }
  };
  socket.onclose = closed;
  return {
    send(message: TerminalInput) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    dispose() {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    },
  };
}
