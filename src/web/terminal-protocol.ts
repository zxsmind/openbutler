/** Transport-independent terminal messages, shared by the web client and host. */
export type TerminalInput = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
export type TerminalOutput =
  | { type: 'ready'; cwd: string; windowsPty?: { backend: 'conpty'; buildNumber: number } }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

export const TERMINAL_ENDPOINT = '/api/terminal';

export function parseTerminalInput(value: unknown): TerminalInput | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 16384)
    return { type: 'input', data: message.data };
  if (
    message.type === 'resize' &&
    Number.isInteger(message.cols) &&
    Number.isInteger(message.rows) &&
    Number(message.cols) >= 2 &&
    Number(message.cols) <= 500 &&
    Number(message.rows) >= 1 &&
    Number(message.rows) <= 300
  )
    return { type: 'resize', cols: Number(message.cols), rows: Number(message.rows) };
  return null;
}
