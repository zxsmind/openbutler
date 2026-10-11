/**
 * Guided Telegram onboarding helpers.
 *
 * Pure, testable pieces of the `ranite telegram setup` flow: bot-token shape
 * and live validation against the Bot API, user-environment persistence, and
 * the pairing wait loop. CLI prompting and host calls stay in `cli-main.ts`.
 * The token lives in memory and the host environment only — it is never
 * written to the settings file, and error messages never contain it.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class TelegramSetupError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'network',
  ) {
    super(message);
  }
}

const TOKEN_FORMAT = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const ENV_NAME_FORMAT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** New hosts launched by an older Windows shell can inherit a stale environment. */
export async function resolveTokenEnv(name: string): Promise<string | undefined> {
  if (!ENV_NAME_FORMAT.test(name)) throw new Error('Invalid Telegram token environment variable name.');
  const inherited = process.env[name]?.trim();
  if (inherited) return inherited;
  if (process.platform !== 'win32') return undefined;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::Write([Environment]::GetEnvironmentVariable($env:RANITE_TOKEN_ENV_NAME, 'User'))",
      ],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, RANITE_TOKEN_ENV_NAME: name } },
    );
    return stdout.trim() || undefined;
  } catch {
    // Do not expose process output: it can contain the token.
    return undefined;
  }
}

/** Message the setup flow sends to prove the owner channel works end to end. */
export const TELEGRAM_SETUP_TEST_MESSAGE =
  'Ranite Telegram channel is connected. Send a message here any time; /approvals re-sends pending approvals and /stop stops the current run.';

/** Shape check only — fast typo feedback before any network call. */
export function isPlausibleBotToken(value: string): boolean {
  return TOKEN_FORMAT.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Verify a pasted token with a direct `getMe` call. Throws
 * `TelegramSetupError` with kind `invalid` (wrong token) or `network`
 * (unreachable API, unreadable response). The token never appears in errors.
 */
export async function verifyBotToken(token: string, fetchApi: typeof fetch = fetch): Promise<{ username: string }> {
  const clean = token.trim();
  if (!isPlausibleBotToken(clean))
    throw new TelegramSetupError(
      'That does not look like a Telegram bot token (expected digits, a colon, then the secret part).',
      'invalid',
    );
  let response: Response;
  try {
    response = await fetchApi(`https://api.telegram.org/bot${clean}/getMe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TelegramSetupError('Could not reach api.telegram.org. Check the network connection and try again.', 'network');
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new TelegramSetupError('Telegram returned an unreadable response. Try again.', 'network');
  }
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result) || parsed.result.is_bot !== true)
    throw new TelegramSetupError('Telegram rejected that token. Ask @BotFather for the token with /token and try again.', 'invalid');
  if (typeof parsed.result.username !== 'string')
    throw new TelegramSetupError('Telegram returned a bot without a username. Give the bot a username in @BotFather first.', 'invalid');
  return { username: parsed.result.username };
}

/** Quote a value for POSIX shell `export` lines. */
export function shellEscape(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`;
}

/**
 * Add or replace an `export NAME='value'` line in shell profile text.
 * Matches both `NAME=...` and `export NAME=...` forms.
 */
export function upsertProfileExport(profileText: string, name: string, value: string): string {
  if (!ENV_NAME_FORMAT.test(name)) throw new Error('Refusing to write an invalid environment variable name.');
  const line = `export ${name}=${shellEscape(value)}`;
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}=.*$`, 'm');
  if (pattern.test(profileText)) return profileText.replace(pattern, line);
  const trimmed = profileText.replace(/\s+$/, '');
  return `${trimmed ? `${trimmed}\n` : ''}${line}\n`;
}

/**
 * Persist a token to the user environment so the background host and future
 * logins see it: `setx` on Windows, an `export` line in `~/.profile`
 * elsewhere. Returns a human-readable location for status output.
 */
export async function persistTokenEnv(name: string, value: string, homeDir: string = homedir()): Promise<{ location: string }> {
  if (!ENV_NAME_FORMAT.test(name)) throw new Error('Refusing to persist an invalid environment variable name.');
  if (process.platform === 'win32') {
    try {
      await execFileAsync('setx', [name, value], { windowsHide: true });
    } catch {
      throw new Error(`Could not save ${name} with setx. Set it manually in the user environment, then re-run \`ranite telegram setup\`.`);
    }
    return { location: `user environment (${name})` };
  }
  const profile = join(homeDir, '.profile');
  const current = existsSync(profile) ? readFileSync(profile, 'utf8') : '';
  writeFileSync(profile, upsertProfileExport(current, name, value), { mode: 0o600 });
  chmodSync(profile, 0o600);
  return { location: profile };
}

/**
 * Remove an `export NAME=...` (or bare `NAME=...`) line from shell profile
 * text. Returns the filtered text and whether anything changed.
 */
export function removeProfileExport(profileText: string, name: string): { text: string; changed: boolean } {
  if (!ENV_NAME_FORMAT.test(name)) throw new Error('Refusing to edit an invalid environment variable name.');
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}=.*(?:\\r?\\n|$)`, 'gm');
  const text = profileText.replace(pattern, '');
  return { text, changed: text !== profileText };
}

/**
 * Format one systemd `EnvironmentFile` line (`NAME="value"`). systemd files
 * do not take the `export` keyword, unlike shell profiles.
 */
export function formatSystemdEnvLine(name: string, value: string): string {
  if (!ENV_NAME_FORMAT.test(name)) throw new Error('Refusing to write an invalid environment variable name.');
  if (/[\r\n\0]/.test(value)) throw new Error('Refusing to write a multi-line environment value.');
  return `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Login-daemon env file holding the bot token (0600) for systemd units. */
export function telegramEnvFilePath(dataDir: string): string {
  return join(dataDir, 'telegram.env');
}

/** Write the token env file for login-daemon consumption. */
export function writeTelegramEnvFile(filePath: string, name: string, value: string): void {
  writeFileSync(filePath, `${formatSystemdEnvLine(name, value)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

/** Remove the token env file. Returns true when a file was removed. */
export function removeTelegramEnvFile(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Remove a token from the user environment: true registry deletion on
 * Windows (`setx` cannot delete), profile-line removal elsewhere.
 */
export async function removeTokenEnv(name: string, homeDir: string = homedir()): Promise<{ location: string; removed: boolean }> {
  if (!ENV_NAME_FORMAT.test(name)) throw new Error('Refusing to remove an invalid environment variable name.');
  if (process.platform === 'win32') {
    try {
      await execFileAsync('reg.exe', ['delete', 'HKCU\\Environment', '/V', name, '/f'], { windowsHide: true });
    } catch {
      throw new Error(
        `Could not remove ${name} from the user environment. Delete it manually with \`reg delete HKCU\\Environment /V ${name} /f\`.`,
      );
    }
    return { location: `user environment (${name})`, removed: true };
  }
  const profile = join(homeDir, '.profile');
  if (!existsSync(profile)) return { location: profile, removed: false };
  const { text, changed } = removeProfileExport(readFileSync(profile, 'utf8'), name);
  if (changed) writeFileSync(profile, text);
  return { location: profile, removed: changed };
}

/**
 * Poll until the Telegram adapter settles (`polling`/`error`) or the timeout
 * hits. A fresh host boot or restart needs a moment before its first status
 * is meaningful; reading once races the boot.
 */
export async function waitForSettledState(
  readState: () => Promise<'polling' | 'error' | 'pending'>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<'polling' | 'error' | 'timeout'> {
  const timeout = options.timeoutMs ?? 30_000;
  const interval = options.intervalMs ?? 1000;
  const now = options.now ?? Date.now;
  const pause = options.sleepFn ?? sleep;
  const started = now();
  for (;;) {
    const state = await readState();
    if (state !== 'pending') return state;
    if (now() - started >= timeout) return 'timeout';
    await pause(Math.min(interval, Math.max(0, timeout - (now() - started))));
  }
}

/**
 * Poll until the owner chat pairs or the code expires. Pure polling logic —
 * the caller supplies the status check and only renders `onTick`.
 */
export async function waitForPairing(
  isPaired: () => Promise<boolean>,
  options: {
    deadlineMs: number;
    intervalMs?: number;
    now?: () => number;
    sleepFn?: (ms: number) => Promise<void>;
    onTick?: (remainingMs: number) => void;
  },
): Promise<'paired' | 'expired'> {
  const interval = options.intervalMs ?? 3000;
  const now = options.now ?? Date.now;
  const pause = options.sleepFn ?? sleep;
  for (;;) {
    if (await isPaired()) return 'paired';
    const remaining = options.deadlineMs - now();
    if (remaining <= 0) return 'expired';
    options.onTick?.(remaining);
    await pause(Math.min(interval, remaining));
  }
}
