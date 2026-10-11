import type { ResolvedTheme } from './theme.js';

/**
 * Terminal background detection for the System theme. COLORFGBG is checked first
 * because it costs nothing; otherwise a single OSC 11 query is sent and the reply
 * is parsed with a short timeout, so terminals that do not answer never block the
 * startup. Anything unknown resolves to Dark.
 */

export function terminalThemeFromColorFgBg(value: string | undefined = process.env.COLORFGBG): ResolvedTheme | null {
  if (!value) return null;
  const parts = value.split(';');
  const background = Number.parseInt(parts[parts.length - 1] ?? '', 10);
  if (!Number.isInteger(background) || background < 0 || background > 255) return null;
  return background >= 7 ? 'light' : 'dark';
}

export function terminalThemeFromRgbResponse(response: string): ResolvedTheme | null {
  const match = /\u001b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(response);
  if (!match) return null;
  const luminance = 0.2126 * channelValue(match[1]!) + 0.7152 * channelValue(match[2]!) + 0.0722 * channelValue(match[3]!);
  return luminance > 0.5 ? 'light' : 'dark';
}

export async function detectTerminalTheme(timeoutMs = 120): Promise<ResolvedTheme | null> {
  const fromEnvironment = terminalThemeFromColorFgBg();
  if (fromEnvironment) return fromEnvironment;
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function' || !process.stdout.isTTY) return null;
  return await new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const finish = (result: ResolvedTheme | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        /* the terminal may have already closed raw mode */
      }
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const theme = terminalThemeFromRgbResponse(buffer);
      if (theme) finish(theme);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      stdin.setRawMode(true);
    } catch {
      finish(null);
      return;
    }
    stdin.on('data', onData);
    process.stdout.write('\u001b]11;?\u0007');
  });
}

function channelValue(hex: string): number {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) return 0;
  const maximum = hex.length >= 3 ? 0xffff : hex.length === 2 ? 0xff : 0xf;
  return value / maximum;
}
