import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TelegramSetupError,
  resolveTokenEnv,
  formatSystemdEnvLine,
  isPlausibleBotToken,
  removeProfileExport,
  removeTelegramEnvFile,
  telegramEnvFilePath,
  upsertProfileExport,
  verifyBotToken,
  waitForPairing,
  waitForSettledState,
  writeTelegramEnvFile,
} from '../src/telegram-setup.js';

const VALID = '123456:ABCdef-ghi_JKLmnoPQRstuVWXyz0123456789';

describe('token environment resolution', () => {
  it('uses the explicitly inherited environment and validates the variable name', async () => {
    const name = 'RANITE_FIXTURE_TOKEN_LOOKUP';
    const previous = process.env[name];
    process.env[name] = `  ${VALID}  `;
    try {
      await expect(resolveTokenEnv(name)).resolves.toBe(VALID);
      await expect(resolveTokenEnv('bad;name')).rejects.toThrow('Invalid Telegram token environment');
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});

function stubFetch(handler: (url: string) => unknown) {
  return (async (url: string) => {
    const outcome = handler(url);
    if (outcome instanceof Error) throw outcome;
    return { json: async () => outcome };
  }) as unknown as typeof fetch;
}

describe('isPlausibleBotToken', () => {
  it('accepts BotFather-shaped tokens', () => {
    expect(isPlausibleBotToken(VALID)).toBe(true);
    expect(isPlausibleBotToken(`  ${VALID}\n`)).toBe(true);
  });

  it('rejects garbage, empty, and truncated values', () => {
    expect(isPlausibleBotToken('')).toBe(false);
    expect(isPlausibleBotToken('not-a-token')).toBe(false);
    expect(isPlausibleBotToken('123456')).toBe(false);
    expect(isPlausibleBotToken('1234:short')).toBe(false);
    expect(isPlausibleBotToken('abc:ABCdef-ghi_JKLmnoPQRstuVWXyz0123456789')).toBe(false);
  });
});

describe('verifyBotToken', () => {
  it('returns the bot username for a valid token', async () => {
    const fetchApi = stubFetch((url) => {
      expect(url).toContain('/getMe');
      return { ok: true, result: { is_bot: true, username: 'ranite_bot' } };
    });
    await expect(verifyBotToken(VALID, fetchApi)).resolves.toEqual({ username: 'ranite_bot' });
  });

  it('reports invalid for rejected tokens without leaking the token', async () => {
    const fetchApi = stubFetch(() => ({ ok: false, description: 'Unauthorized' }));
    const error = await verifyBotToken(VALID, fetchApi).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TelegramSetupError);
    expect((error as TelegramSetupError).kind).toBe('invalid');
    expect(String(error)).not.toContain(VALID);
  });

  it('reports invalid for malformed tokens before any network call', async () => {
    let calls = 0;
    const fetchApi = stubFetch(() => {
      calls += 1;
      return { ok: true, result: {} };
    });
    await expect(verifyBotToken('garbage', fetchApi)).rejects.toMatchObject({ kind: 'invalid' });
    expect(calls).toBe(0);
  });

  it('reports network when the API is unreachable or unreadable', async () => {
    const down = stubFetch(() => new Error('socket hangup'));
    await expect(verifyBotToken(VALID, down)).rejects.toMatchObject({ kind: 'network' });
    const jsonThrower = (async () => ({
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    await expect(verifyBotToken(VALID, jsonThrower)).rejects.toMatchObject({ kind: 'network' });
  });

  it('reports invalid when the identity is not a usable bot', async () => {
    const notBot = stubFetch(() => ({ ok: true, result: { is_bot: false, username: 'someone' } }));
    await expect(verifyBotToken(VALID, notBot)).rejects.toMatchObject({ kind: 'invalid' });
    const noUsername = stubFetch(() => ({ ok: true, result: { is_bot: true } }));
    await expect(verifyBotToken(VALID, noUsername)).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('upsertProfileExport', () => {
  it('appends the export when the variable is missing', () => {
    expect(upsertProfileExport('# comment\n', 'TELEGRAM_BOT_TOKEN', 'abc')).toBe("# comment\nexport TELEGRAM_BOT_TOKEN='abc'\n");
    expect(upsertProfileExport('', 'TELEGRAM_BOT_TOKEN', 'abc')).toBe("export TELEGRAM_BOT_TOKEN='abc'\n");
  });

  it('replaces an existing plain or exported assignment', () => {
    expect(upsertProfileExport('TELEGRAM_BOT_TOKEN=old\nPATH=x\n', 'TELEGRAM_BOT_TOKEN', 'new')).toBe(
      "export TELEGRAM_BOT_TOKEN='new'\nPATH=x\n",
    );
    expect(upsertProfileExport("export TELEGRAM_BOT_TOKEN='old'\n", 'TELEGRAM_BOT_TOKEN', 'new')).toBe("export TELEGRAM_BOT_TOKEN='new'\n");
  });

  it('quotes values for POSIX shells', () => {
    expect(upsertProfileExport('', 'X', `a'b`)).toBe(`export X='a'\\''b'\n`);
  });

  it('refuses invalid variable names', () => {
    expect(() => upsertProfileExport('', '123 NOPE', 'x')).toThrow(/invalid environment variable name/);
  });
});

describe('removeProfileExport', () => {
  it('removes exported and bare assignments, keeping the rest', () => {
    expect(removeProfileExport("export TELEGRAM_BOT_TOKEN='a'\nPATH=x\n", 'TELEGRAM_BOT_TOKEN')).toEqual({
      text: 'PATH=x\n',
      changed: true,
    });
    expect(removeProfileExport('TELEGRAM_BOT_TOKEN=old\n', 'TELEGRAM_BOT_TOKEN')).toEqual({ text: '', changed: true });
  });

  it('leaves unrelated variables alone and reports no change', () => {
    expect(removeProfileExport('PATH=x\nOTHER=1\n', 'TELEGRAM_BOT_TOKEN')).toEqual({
      text: 'PATH=x\nOTHER=1\n',
      changed: false,
    });
    expect(removeProfileExport('  export TELEGRAM_BOT_TOKEN_X=1\n', 'TELEGRAM_BOT_TOKEN')).toMatchObject({ changed: false });
  });

  it('refuses invalid variable names', () => {
    expect(() => removeProfileExport('', 'NOPE!')).toThrow(/invalid environment variable name/);
  });
});

describe('formatSystemdEnvLine', () => {
  it('formats a systemd EnvironmentFile line without the export keyword', () => {
    expect(formatSystemdEnvLine('TELEGRAM_BOT_TOKEN', '123:abc')).toBe('TELEGRAM_BOT_TOKEN="123:abc"');
  });

  it('escapes quotes and backslashes', () => {
    expect(formatSystemdEnvLine('X', 'a"b\\c')).toBe('X="a\\"b\\\\c"');
  });

  it('rejects line breaks and invalid names', () => {
    expect(() => formatSystemdEnvLine('X', 'a\nb')).toThrow(/multi-line/);
    expect(() => formatSystemdEnvLine('9X', 'v')).toThrow(/invalid environment variable name/);
  });
});

describe('telegram env file roundtrip', () => {
  it('writes systemd-format content and removes the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ranite-tg-env-'));
    try {
      const file = telegramEnvFilePath(dir);
      expect(file.endsWith('telegram.env')).toBe(true);
      writeTelegramEnvFile(file, 'TELEGRAM_BOT_TOKEN', '123:abc');
      expect(readFileSync(file, 'utf8')).toBe('TELEGRAM_BOT_TOKEN="123:abc"\n');
      expect(removeTelegramEnvFile(file)).toBe(true);
      expect(removeTelegramEnvFile(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('waitForSettledState', () => {
  it('returns the first settled state without sleeping', async () => {
    let sleeps = 0;
    await expect(waitForSettledState(async () => 'polling', { sleepFn: async () => void (sleeps += 1) })).resolves.toBe('polling');
    await expect(waitForSettledState(async () => 'error', { sleepFn: async () => void (sleeps += 1) })).resolves.toBe('error');
    expect(sleeps).toBe(0);
  });

  it('waits out pending reads until the state settles', async () => {
    let reads = 0;
    const outcome = await waitForSettledState(async () => (++reads < 3 ? 'pending' : 'polling'), {
      intervalMs: 10,
      now: () => reads * 10,
      sleepFn: async () => {},
    });
    expect(outcome).toBe('polling');
    expect(reads).toBe(3);
  });

  it('times out on a host that never settles', async () => {
    let now = 0;
    const outcome = await waitForSettledState(async () => 'pending', {
      timeoutMs: 25,
      intervalMs: 100,
      now: () => now,
      sleepFn: async (ms) => void (now += ms),
    });
    expect(outcome).toBe('timeout');
  });
});
describe('waitForPairing', () => {
  it('returns paired without sleeping when already paired', async () => {
    let polls = 0;
    let sleeps = 0;
    const outcome = await waitForPairing(
      async () => {
        polls += 1;
        return true;
      },
      { deadlineMs: 60_000, sleepFn: async () => void (sleeps += 1) },
    );
    expect(outcome).toBe('paired');
    expect(polls).toBe(1);
    expect(sleeps).toBe(0);
  });

  it('polls until paired', async () => {
    let polls = 0;
    const seen: number[] = [];
    const outcome = await waitForPairing(async () => (++polls >= 3 ? true : false), {
      deadlineMs: 60_000,
      intervalMs: 10,
      now: () => polls * 10,
      sleepFn: async (ms) => void seen.push(ms),
      onTick: () => {},
    });
    expect(outcome).toBe('paired');
    expect(polls).toBe(3);
    expect(seen).toEqual([10, 10]);
  });

  it('expires at the deadline and caps the last sleep', async () => {
    let now = 0;
    const seen: number[] = [];
    const ticks: number[] = [];
    const outcome = await waitForPairing(async () => false, {
      deadlineMs: 25,
      intervalMs: 100,
      now: () => now,
      sleepFn: async (ms) => {
        seen.push(ms);
        now += ms;
      },
      onTick: (remaining) => void ticks.push(remaining),
    });
    expect(outcome).toBe('expired');
    expect(seen).toEqual([25]);
    expect(ticks).toEqual([25]);
  });
});
