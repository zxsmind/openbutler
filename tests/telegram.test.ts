import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import { TelegramAdapter, TelegramApiError, escapeTelegramHtml, splitTelegramText } from '../src/telegram.js';
import type { TelegramSettings } from '../src/settings.js';
import type { ToolCallRequest } from '../src/tools/registry.js';

const TOKEN = '123456:fixture-token-only';
let ledger: ActivityLedger;
let adapter: TelegramAdapter | undefined;
beforeEach(() => {
  ledger = new ActivityLedger(':memory:');
  vi.stubEnv('RANITE_TEST_TELEGRAM_TOKEN', TOKEN);
});
afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
  ledger.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function transport(webhook = '') {
  let waiting: ((updates: unknown[]) => void) | null = null;
  const queued: unknown[][] = [];
  const sent: Array<Record<string, unknown>> = [];
  let messageId = 0;
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    let result: unknown = true;
    if (method === 'getMe') result = { is_bot: true, username: 'fixture_bot' };
    if (method === 'getWebhookInfo') result = { url: webhook };
    if (method === 'sendMessage') {
      sent.push(body);
      result = { message_id: ++messageId };
    }
    if (method === 'getUpdates') {
      result =
        queued.shift() ??
        (await new Promise<unknown[]>((resolveUpdates, rejectUpdates) => {
          const signal = init?.signal;
          const onAbort = () => {
            waiting = null;
            rejectUpdates(new Error('Fixture polling aborted.'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          waiting = (updates) => {
            signal?.removeEventListener('abort', onAbort);
            waiting = null;
            resolveUpdates(updates);
          };
        }));
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });
  return {
    fetcher: fetcher as unknown as typeof fetch,
    calls: fetcher,
    sent,
    emit(updates: unknown[]) {
      if (waiting) waiting(updates);
      else queued.push(updates);
    },
  };
}

function callbacks() {
  return { message: vi.fn(async (_id: number, _text: string) => {}), approval: vi.fn(() => true), paired: vi.fn(), log: vi.fn() };
}

function config(paired = false): TelegramSettings {
  return {
    enabled: true,
    tokenEnv: 'RANITE_TEST_TELEGRAM_TOKEN',
    workspaceRoot: process.cwd(),
    ...(paired ? { chatId: '100', userId: '100' } : {}),
  };
}

const message = (id: number, chatId: number, text: string) => ({
  update_id: id,
  message: { chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false }, text },
});

describe('owner Telegram authentication and replay protection', () => {
  it('does not expose the token when a transport error includes its request URL', async () => {
    adapter = new TelegramAdapter(config(true), ledger, callbacks(), async () => {
      throw new Error(`Failed URL https://api.telegram.org/bot${TOKEN}/getMe`);
    });
    await expect(adapter.start()).rejects.toThrow('connection failed');
    expect(adapter.getStatus().error).not.toContain(TOKEN);
  });
  it('exposes a native stop control only for the paired owner and current draft', async () => {
    const api = transport();
    adapter = new TelegramAdapter(config(true), ledger, callbacks(), api.fetcher);
    await adapter.start();
    const stop = vi.fn();
    const id = adapter.beginLiveDraft(stop)!;
    await vi.waitFor(() => expect(api.calls.mock.calls.some(([url]) => String(url).endsWith('sendMessageDraft'))).toBe(true));
    const draftCall = api.calls.mock.calls.find(([url]) => String(url).endsWith('sendMessageDraft'))!;
    expect(JSON.parse(String(draftCall[1]?.body))).toMatchObject({ draft_id: id, text: '', can_stop: true });
    api.emit([{ update_id: 1, stopped_message_generation: { chat: { id: 200 }, draft_id: id } }]);
    await vi.waitFor(() =>
      expect(ledger.getState(`telegram:offset:${createHash('sha256').update(TOKEN).digest('hex').slice(0, 24)}`)).toBe('2'),
    );
    expect(stop).not.toHaveBeenCalled();
    api.emit([{ update_id: 2, stopped_message_generation: { chat: { id: 100 }, draft_id: id } }]);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await adapter.finishLiveDraft(id);
    api.emit([{ update_id: 3, stopped_message_generation: { chat: { id: 100 }, draft_id: id } }]);
    await vi.waitFor(() =>
      expect(ledger.getState(`telegram:offset:${createHash('sha256').update(TOKEN).digest('hex').slice(0, 24)}`)).toBe('4'),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('pairs only with the one-time code, ignores unpaired senders, and persists its update cursor', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(), ledger, hooks, api.fetcher);
    await adapter.start();
    const pairing = adapter.beginPairing();
    api.emit([message(1, 200, '/start wrong-code'), message(2, 100, `/start ${pairing.code}`)]);
    await vi.waitFor(() => expect(hooks.paired).toHaveBeenCalledWith('100', '100'));
    api.emit([message(3, 200, 'unauthorized request'), message(4, 100, 'authorized request')]);
    await vi.waitFor(() => expect(hooks.message).toHaveBeenCalledWith(4, 'authorized request'));
    expect(hooks.message).toHaveBeenCalledTimes(1);
    const key = `telegram:offset:${createHash('sha256').update(TOKEN).digest('hex').slice(0, 24)}`;
    await vi.waitFor(() => expect(ledger.getState(key)).toBe('5'));
    api.emit([message(4, 100, 'duplicate request')]);
    await vi.waitFor(() =>
      expect(api.calls.mock.calls.filter(([url]) => String(url).endsWith('getUpdates')).length).toBeGreaterThanOrEqual(4),
    );
    expect(hooks.message).toHaveBeenCalledTimes(1);
  });

  it('binds an approval to its owner, request, message, and one use', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    const request: ToolCallRequest = {
      requestId: randomUUID(),
      providerId: 'host',
      name: 'execute_command',
      input: { command: 'inspect', apiKey: 'SECRET_SHOULD_NOT_BE_SENT' },
      effect: { change: 'execute', data: 'local', network: 'none', reversible: 'unknown', outbound: 'model' },
    };
    await adapter.requestApproval(request, process.cwd());
    expect(String(api.sent[0]?.text)).not.toContain('SECRET_SHOULD_NOT_BE_SENT');
    const callback = (id: number, userId: number) => ({
      update_id: id,
      callback_query: {
        id: String(id),
        from: { id: userId },
        message: { message_id: 1, chat: { id: 100 } },
        data: `ra:${request.requestId}:a`,
      },
    });
    api.emit([callback(1, 200), callback(2, 100), callback(3, 100)]);
    await vi.waitFor(() => expect(hooks.approval).toHaveBeenCalledWith(request.requestId, 'allow'));
    await vi.waitFor(() => expect(api.calls.mock.calls.filter(([url]) => String(url).endsWith('answerCallbackQuery'))).toHaveLength(3));
    expect(hooks.approval).toHaveBeenCalledTimes(1);
  });

  it('rejects expired approval buttons and refuses to take over an existing webhook', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    const request: ToolCallRequest = {
      requestId: randomUUID(),
      providerId: 'host',
      name: 'inspect',
      input: {},
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
    };
    await adapter.requestApproval(request, process.cwd());
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    api.emit([
      {
        update_id: 1,
        callback_query: {
          id: 'expired',
          from: { id: 100 },
          message: { message_id: 1, chat: { id: 100 } },
          data: `ra:${request.requestId}:a`,
        },
      },
    ]);
    await vi.waitFor(() => expect(api.calls.mock.calls.some(([url]) => String(url).endsWith('answerCallbackQuery'))).toBe(true));
    expect(hooks.approval).not.toHaveBeenCalled();
    await adapter.close();
    const occupied = transport('https://existing.example/webhook');
    adapter = new TelegramAdapter(config(), ledger, hooks, occupied.fetcher);
    await expect(adapter.start()).rejects.toThrow('already has a webhook');
    expect(occupied.calls.mock.calls.some(([url]) => String(url).endsWith('deleteWebhook'))).toBe(false);
  });

  it('retains Telegram retry timing for durable notification retries', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    api.calls.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too many requests', parameters: { retry_after: 90 } }), {
        status: 429,
      }),
    );
    await expect(adapter.sendOwner('A requested notification')).rejects.toMatchObject({ retryAfterSeconds: 90 });
    expect(TelegramApiError.prototype).toBeInstanceOf(Error);
  });
});

it('splits long output without cutting Unicode characters or exceeding the Telegram limit', () => {
  const text = 'Sample café naïve 👋\n'.repeat(1000);
  const chunks = splitTelegramText(text);
  expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
  expect(chunks.join('')).toBe(text);
  expect(chunks.some((chunk) => /[\uD800-\uDBFF]$/.test(chunk) || /^[\uDC00-\uDFFF]/.test(chunk))).toBe(false);
  expect(() => splitTelegramText('👋', 1)).toThrow('between 2');
});

describe('Telegram native channel UI', () => {
  it('escapes text for HTML parse_mode', () => {
    expect(escapeTelegramHtml('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d"e');
  });

  it('registers the owner command menu on start when paired', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    const menus = api.calls.mock.calls.filter(([url]) => String(url).endsWith('setMyCommands'));
    expect(menus).toHaveLength(1);
    const body = JSON.parse(String(menus[0]![1]?.body ?? '{}')) as Record<string, unknown>;
    expect(body.scope).toEqual({ type: 'chat', chat_id: '100' });
    expect(body.commands).toEqual([
      { command: 'start', description: 'Show help and pairing info' },
      { command: 'approvals', description: 'Re-send pending approval buttons' },
      { command: 'stop', description: 'Stop the current run (or a schedule: /stop <schedule-id>)' },
      { command: 'clear', description: 'Start a new chat' },
      { command: 'sessions', description: 'Show the last 10 chats' },
    ]);
  });

  it('pairs with a reply keyboard and refreshes the menu', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(), ledger, hooks, api.fetcher);
    await adapter.start();
    const pairing = adapter.beginPairing();
    api.emit([message(1, 100, `/start ${pairing.code}`)]);
    await vi.waitFor(() => expect(hooks.paired).toHaveBeenCalledWith('100', '100'));
    await vi.waitFor(() => expect(api.calls.mock.calls.some(([url]) => String(url).endsWith('setMyCommands'))).toBe(true));
    const confirmation = api.sent.at(-1)!;
    expect(confirmation.reply_markup).toMatchObject({ keyboard: [[{ text: '/approvals' }, { text: '/stop' }]] });
    expect(confirmation.parse_mode).toBe('HTML');
    expect(String(confirmation.text).startsWith('<b>')).toBe(false);
  });

  it('answers /help with the reply keyboard', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    api.emit([message(1, 100, '/help')]);
    await vi.waitFor(() => expect(api.sent.length).toBeGreaterThan(0));
    expect(api.sent.at(-1)!.reply_markup).toMatchObject({ keyboard: [[{ text: '/approvals' }, { text: '/stop' }]] });
  });

  it('sends approvals as escaped HTML with the inline buttons intact', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    await adapter.requestApproval(
      {
        requestId: randomUUID(),
        providerId: 'host',
        name: 'execute_command',
        input: { command: 'run <this> & that' },
        effect: { change: 'execute', data: 'local', network: 'none', reversible: 'unknown', outbound: 'model' },
      },
      process.cwd(),
    );
    const sent = api.sent[0]!;
    expect(sent.parse_mode).toBe('HTML');
    expect(String(sent.text)).toContain('<b>Action approval</b>');
    expect(String(sent.text)).toContain('run &lt;this&gt; &amp; that');
    expect(String(sent.text)).not.toContain('run <this>');
    expect(sent.reply_markup).toMatchObject({ inline_keyboard: [[{ text: 'Allow once' }, { text: 'Deny' }, { text: 'Always allow' }]] });
  });

  it('falls back to plain text when Telegram rejects the markup', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    api.calls.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }), { status: 400 }),
    );
    await adapter.sendOwnerNotification('Title & more', 'Body <here>');
    const sends = api.calls.mock.calls.filter(([url]) => String(url).endsWith('sendMessage'));
    expect(sends).toHaveLength(2);
    const retry = JSON.parse(String(sends[1]![1]?.body ?? '{}')) as Record<string, unknown>;
    expect(retry.parse_mode).toBeUndefined();
    expect(String(retry.text)).toContain('Title & more');
    expect(String(retry.text)).not.toContain('<b>');
  });

  it('chunks long HTML notifications without cutting entities', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    await adapter.sendOwnerNotification('News', `${'a&b<c>d'.repeat(900)} end`);
    expect(api.sent.length).toBeGreaterThan(1);
    for (const chunk of api.sent) {
      expect(String(chunk.text).length).toBeLessThanOrEqual(4096);
      expect(String(chunk.text)).not.toMatch(/&[a-zA-Z]+$/);
    }
    expect(api.sent[0]!.parse_mode).toBe('HTML');
    expect(String(api.sent[0]!.text).startsWith('<b>News</b>')).toBe(true);
  });

  it('removes the reply keyboard on request', async () => {
    const api = transport();
    const hooks = callbacks();
    adapter = new TelegramAdapter(config(true), ledger, hooks, api.fetcher);
    await adapter.start();
    await adapter.removeReplyKeyboard();
    expect(api.sent.at(-1)).toMatchObject({ reply_markup: { remove_keyboard: true } });
  });
});
