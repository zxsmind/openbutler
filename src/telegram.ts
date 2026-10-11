import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type ActivityLedger } from './activity-ledger.js';
import { redactSensitive } from './sensitive-data.js';
import type { ApprovalDecision } from './agent-session.js';
import type { TelegramSettings } from './settings.js';
import type { ToolCallRequest } from './tools/registry.js';
import { resolveTokenEnv } from './telegram-setup.js';

export interface TelegramStatus {
  state: 'disabled' | 'connecting' | 'polling' | 'error' | 'stopped';
  paired: boolean;
  username: string | null;
  error: string | null;
}

type TelegramCallbacks = {
  message: (updateId: number, text: string) => Promise<void>;
  approval: (requestId: string, decision: ApprovalDecision) => boolean;
  paired: (chatId: string, userId: string) => void;
  log: (message: string) => void;
};

type ApprovalRecord = { expiresAt: number; messageId: number | null };
type LiveDraftRecord = {
  text: string;
  onStop: () => void;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  timerDue: number;
  inFlight: Promise<void> | null;
  failed: boolean;
};

const LIVE_DRAFT_INTERVAL_MS = 900;
const LIVE_DRAFT_TEXT_LIMIT = 3900;

const OWNER_COMMANDS = [
  { command: 'start', description: 'Show help and pairing info' },
  { command: 'approvals', description: 'Re-send pending approval buttons' },
  { command: 'stop', description: 'Stop the current run (or a task: /stop <task-id>)' },
];

const OWNER_KEYBOARD = {
  keyboard: [[{ text: '/approvals' }, { text: '/stop' }]],
  resize_keyboard: true,
};

/** Escape text for Telegram HTML `parse_mode` (only `&`, `<`, `>` are special). */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/** Owner-only message adapter. Model runs and permission decisions stay in the host. */
export class TelegramAdapter {
  private readonly abort = new AbortController();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly liveDrafts = new Map<number, LiveDraftRecord>();
  private outboundChain: Promise<unknown> = Promise.resolve();
  private lastMessageSendAt = 0;
  private pairRequest: { hash: Buffer; expiresAt: number } | null = null;
  private polling: Promise<void> | null = null;
  private token = '';
  private offsetKey = '';
  private status: TelegramStatus;

  constructor(
    private readonly settings: TelegramSettings | undefined,
    private readonly ledger: ActivityLedger,
    private readonly callbacks: TelegramCallbacks,
    private readonly fetchApi: typeof fetch = fetch,
  ) {
    this.status = {
      state: settings?.enabled ? 'stopped' : 'disabled',
      paired: Boolean(settings?.chatId && settings.userId),
      username: null,
      error: null,
    };
  }

  getStatus(): TelegramStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    if (!this.settings?.enabled) return;
    this.status.state = 'connecting';
    try {
      const token = await resolveTokenEnv(this.settings.tokenEnv);
      if (!token) throw new Error(`Telegram token environment variable ${this.settings.tokenEnv} is missing in the host process.`);
      this.token = token;
      this.offsetKey = `telegram:offset:${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
      const me = await this.call('getMe', {});
      if (!isRecord(me) || me.is_bot !== true || typeof me.username !== 'string')
        throw new Error('Telegram returned an invalid bot identity.');
      const webhook = await this.call('getWebhookInfo', {});
      if (isRecord(webhook) && typeof webhook.url === 'string' && webhook.url)
        throw new Error('This bot already has a webhook. Remove that integration before using Ranite long polling.');
      this.status = { state: 'polling', paired: Boolean(this.settings.chatId && this.settings.userId), username: me.username, error: null };
      this.polling = this.pollLoop();
      await this.refreshCommandMenu();
    } catch (error) {
      this.status.state = 'error';
      this.status.error = errorText(error);
      throw error;
    }
  }

  beginPairing(): { code: string; expiresAt: string; username: string | null } {
    if (this.status.state !== 'polling')
      throw new Error(
        this.status.error ?? 'Telegram is not running. Configure it, set the token environment variable, and start the host.',
      );
    const code = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 5 * 60_000;
    this.pairRequest = { hash: codeHash(code), expiresAt };
    return { code, expiresAt: new Date(expiresAt).toISOString(), username: this.status.username };
  }

  async sendOwner(text: string, keyboard?: Record<string, unknown>): Promise<boolean> {
    if (!this.readyToSend()) return false;
    const chunks = splitTelegramText(text);
    for (const [index, chunk] of chunks.entries()) {
      await this.call('sendMessage', {
        chat_id: this.settings!.chatId,
        text: chunk,
        link_preview_options: { is_disabled: true },
        ...(keyboard && index === chunks.length - 1 ? { reply_markup: keyboard } : {}),
      });
    }
    return true;
  }

  beginLiveDraft(onStop: () => void): number | null {
    if (!this.readyToSend()) return null;
    let draftId = randomInt(1, 0x7fffffff);
    while (this.liveDrafts.has(draftId)) draftId = randomInt(1, 0x7fffffff);
    const record: LiveDraftRecord = {
      text: '',
      onStop,
      lastSentAt: 0,
      timer: null,
      timerDue: 0,
      inFlight: null,
      failed: false,
    };
    this.liveDrafts.set(draftId, record);
    void this.flushLiveDraft(draftId, record);
    return draftId;
  }

  updateLiveDraft(draftId: number, text: string): void {
    const record = this.liveDrafts.get(draftId);
    if (!record || record.failed) return;
    record.text = telegramDraftPreview(text);
    this.scheduleLiveDraft(draftId, record);
  }

  async finishLiveDraft(draftId: number): Promise<void> {
    const record = this.liveDrafts.get(draftId);
    if (!record) return;
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
    if (record.inFlight) await record.inFlight;
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
    this.liveDrafts.delete(draftId);
  }

  /**
   * Title + body notification with HTML formatting. An empty title sends the
   * body without a heading (used for channel messages that name Ranite
   * themselves). Long bodies are chunked on entity-safe boundaries; a markup
   * rejection falls back to plain text so approvals and notices still arrive.
   */
  async sendOwnerNotification(title: string, message: string, keyboard?: Record<string, unknown>): Promise<boolean> {
    if (!this.readyToSend()) return false;
    const heading = title ? `<b>${escapeTelegramHtml(title)}</b>\n\n` : '';
    const chunks = splitEscapedText(escapeTelegramHtml(message), Math.max(2, 4096 - heading.length));
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      await this.sendHtml(`${index === 0 ? heading : ''}${chunk}`, last ? keyboard : undefined);
    }
    return true;
  }

  /** Remove the persistent reply keyboard, e.g. when the chat is unpaired. */
  async removeReplyKeyboard(): Promise<void> {
    if (!this.readyToSend()) return;
    await this.call('sendMessage', {
      chat_id: this.settings!.chatId,
      text: 'Telegram channel disconnected. Run `ranite telegram pair` in the terminal to reconnect.',
      link_preview_options: { is_disabled: true },
      reply_markup: { remove_keyboard: true },
    });
  }

  /** Whether an outbound owner message can be attempted right now. */
  private readyToSend(): boolean {
    return Boolean(
      this.settings?.chatId && this.token && this.status.username && this.status.state !== 'disabled' && this.status.state !== 'stopped',
    );
  }

  /**
   * One HTML message with a plain-text fallback on markup rejection.
   * Never throws for markup reasons; API and network errors propagate.
   */
  private async sendHtml(text: string, keyboard?: Record<string, unknown>): Promise<unknown> {
    const base = {
      chat_id: this.settings!.chatId,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    };
    try {
      return await this.call('sendMessage', { ...base, text, parse_mode: 'HTML' });
    } catch (error) {
      if (!(error instanceof TelegramApiError) || !/parse|entities|markup/i.test(error.message)) throw error;
      const plain = text
        .replace(/<\/?(b|i|u|s|code|pre)>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      return await this.call('sendMessage', { ...base, text: plain });
    }
  }

  /** Owner-chat command menu (`/` autocomplete). Cosmetic only — never throws. */
  private async refreshCommandMenu(): Promise<void> {
    try {
      if (!this.readyToSend()) return;
      await this.call('setMyCommands', {
        commands: OWNER_COMMANDS,
        scope: { type: 'chat', chat_id: this.settings!.chatId },
      });
    } catch (error) {
      this.callbacks.log(`Telegram command menu: ${errorText(error)}`);
    }
  }

  async requestApproval(request: ToolCallRequest, workspaceRoot: string): Promise<void> {
    if (!this.settings?.chatId || !this.token || !this.status.username || this.approvals.has(request.requestId)) return;
    const record: ApprovalRecord = { expiresAt: Date.now() + 10 * 60_000, messageId: null };
    this.approvals.set(request.requestId, record);
    const header =
      `<b>Action approval</b>\n` +
      `<b>${escapeTelegramHtml(request.providerId)}/${escapeTelegramHtml(request.name)}</b>\n` +
      `Workspace: ${escapeTelegramHtml(workspaceRoot.slice(0, 200))}`;
    const input = JSON.stringify(redactSensitive(request.input), null, 2);
    const budget = Math.max(64, 4000 - header.length - 64);
    const parts = splitTelegramText(input, budget);
    const preview = `<pre>${escapeTelegramHtml(parts[0]!)}</pre>${parts.length > 1 ? '\n… (open this task in Ranite for full details)' : ''}`;
    try {
      const result = await this.sendHtml(`${header}\n\n${preview}`, {
        inline_keyboard: [
          [
            { text: 'Allow once', callback_data: `ra:${request.requestId}:a` },
            { text: 'Deny', callback_data: `ra:${request.requestId}:d` },
            { text: 'Always allow', callback_data: `ra:${request.requestId}:w` },
          ],
        ],
      });
      if (isRecord(result) && typeof result.message_id === 'number') {
        record.messageId = result.message_id;
        if (!this.approvals.has(request.requestId)) await this.clearKeyboard(result.message_id);
      }
    } catch (error) {
      this.approvals.delete(request.requestId);
      throw error;
    }
  }

  retireApproval(requestId: string): void {
    const record = this.approvals.get(requestId);
    this.approvals.delete(requestId);
    if (record?.messageId !== null && record?.messageId !== undefined) void this.clearKeyboard(record.messageId).catch(() => {});
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.pairRequest = null;
    this.approvals.clear();
    for (const draft of this.liveDrafts.values()) if (draft.timer !== null) clearTimeout(draft.timer);
    this.liveDrafts.clear();
    if (this.polling) await this.polling;
    this.status.state = this.settings?.enabled ? 'stopped' : 'disabled';
  }

  private async pollLoop(): Promise<void> {
    let offset = Number(this.ledger.getState(this.offsetKey) ?? '0');
    if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.call('getUpdates', {
          offset,
          timeout: 25,
          limit: 100,
          allowed_updates: ['message', 'callback_query', 'stopped_message_generation'],
        });
        if (!Array.isArray(updates)) throw new Error('Telegram returned an invalid update list.');
        this.status.state = 'polling';
        this.status.error = null;
        failures = 0;
        for (const update of updates) {
          if (!isRecord(update) || !Number.isSafeInteger(update.update_id)) continue;
          const updateId = Number(update.update_id);
          if (updateId < offset) continue;
          await this.handleUpdate(updateId, update);
          offset = updateId + 1;
          this.ledger.setState(this.offsetKey, String(offset));
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        failures += 1;
        this.status.state = 'error';
        this.status.error = errorText(error);
        if (failures === 1) this.callbacks.log(`Telegram: ${this.status.error}`);
        const retryMs = error instanceof TelegramApiError && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0;
        try {
          await delay(Math.max(retryMs, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))), undefined, { signal: this.abort.signal });
        } catch {
          return;
        }
      }
    }
  }

  private async handleUpdate(updateId: number, update: Record<string, unknown>): Promise<void> {
    const stopped = isRecord(update.stopped_message_generation) ? update.stopped_message_generation : null;
    if (stopped && isRecord(stopped.chat) && String(stopped.chat.id) === this.settings?.chatId && Number.isSafeInteger(stopped.draft_id)) {
      const record = this.liveDrafts.get(Number(stopped.draft_id));
      if (record) {
        try {
          record.onStop();
        } catch (error) {
          this.callbacks.log(`Telegram stop request: ${errorText(error)}`);
        }
      }
      return;
    }
    const message = isRecord(update.message) ? update.message : null;
    if (message && isRecord(message.chat) && isRecord(message.from) && message.chat.type === 'private' && message.from.is_bot !== true) {
      const text = typeof message.text === 'string' ? message.text : '';
      if (await this.tryPair(message.chat, message.from, text)) return;
      if (!this.isOwner(message.chat.id, message.from.id)) return;
      if (text === '/start' || text === '/help') {
        await this.sendOwnerNotification(
          '',
          'Send a request to Ranite. /approvals refreshes pending action buttons. /stop cancels this chat run; /stop <task-id> stops a task run.',
          OWNER_KEYBOARD,
        );
      } else if (text.trim()) {
        await this.callbacks.message(updateId, text);
      }
    }
    const callback = isRecord(update.callback_query) ? update.callback_query : null;
    if (!callback || typeof callback.id !== 'string') return;
    const owner =
      isRecord(callback.from) &&
      isRecord(callback.message) &&
      isRecord(callback.message.chat) &&
      this.isOwner(callback.message.chat.id, callback.from.id);
    const match = typeof callback.data === 'string' ? callback.data.match(/^ra:([0-9a-f-]{36}):([adw])$/i) : null;
    const record = match ? this.approvals.get(match[1]!) : undefined;
    const messageId = isRecord(callback.message) ? callback.message.message_id : null;
    let answer = 'This approval is invalid or has expired.';
    if (owner && match && record && record.expiresAt > Date.now() && record.messageId === messageId) {
      this.approvals.delete(match[1]!);
      const decision: ApprovalDecision = match[2] === 'a' ? 'allow' : match[2] === 'w' ? 'always' : 'deny';
      answer = this.callbacks.approval(match[1]!, decision) ? 'Decision received.' : 'This action is no longer waiting for approval.';
      if (record.messageId !== null) await this.clearKeyboard(record.messageId).catch(() => {});
    }
    await this.call('answerCallbackQuery', { callback_query_id: callback.id, text: answer });
  }

  private async tryPair(chat: Record<string, unknown>, from: Record<string, unknown>, text: string): Promise<boolean> {
    const pair = this.pairRequest;
    const code = text.match(/^\/start\s+([a-f0-9]{32})$/i)?.[1];
    if (!pair || !code || pair.expiresAt <= Date.now() || !timingSafeEqual(codeHash(code), pair.hash)) return false;
    if (!Number.isSafeInteger(chat.id) || !Number.isSafeInteger(from.id) || Number(chat.id) <= 0 || Number(from.id) <= 0) return false;
    const chatId = String(chat.id);
    const userId = String(from.id);
    this.callbacks.paired(chatId, userId);
    this.pairRequest = null;
    if (this.settings) {
      this.settings.chatId = chatId;
      this.settings.userId = userId;
    }
    this.status.paired = true;
    await this.sendOwnerNotification(
      '',
      'Ranite is paired with this private chat. You can send requests and approve actions here.',
      OWNER_KEYBOARD,
    );
    await this.refreshCommandMenu();
    return true;
  }

  private isOwner(chatId: unknown, userId: unknown): boolean {
    return (
      Boolean(this.settings?.chatId && this.settings.userId) &&
      String(chatId) === this.settings?.chatId &&
      String(userId) === this.settings?.userId
    );
  }

  private clearKeyboard(messageId: number): Promise<unknown> {
    return this.call('editMessageReplyMarkup', {
      chat_id: this.settings?.chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  private scheduleLiveDraft(draftId: number, record: LiveDraftRecord, heartbeat = false): void {
    if (record.failed || record.inFlight || this.liveDrafts.get(draftId) !== record) return;
    const waitMs = heartbeat ? 15_000 : Math.max(0, LIVE_DRAFT_INTERVAL_MS - (Date.now() - record.lastSentAt));
    const due = Date.now() + waitMs;
    if (record.timer !== null && record.timerDue <= due) return;
    if (record.timer !== null) clearTimeout(record.timer);
    record.timerDue = due;
    record.timer = setTimeout(() => {
      record.timer = null;
      void this.flushLiveDraft(draftId, record);
    }, waitMs);
    record.timer.unref?.();
  }

  private async flushLiveDraft(draftId: number, record: LiveDraftRecord): Promise<void> {
    if (record.failed || this.liveDrafts.get(draftId) !== record || record.inFlight) return;
    const text = record.text;
    const sending = this.call('sendMessageDraft', {
      chat_id: this.settings!.chatId,
      draft_id: draftId,
      text,
      can_stop: true,
      keep_on_stop: true,
    })
      .then(() => {
        record.lastSentAt = Date.now();
      })
      .catch((error: unknown) => {
        record.failed = true;
        if (!this.abort.signal.aborted) this.callbacks.log(`Telegram live draft: ${errorText(error)}`);
      })
      .finally(() => {
        record.inFlight = null;
        if (!record.failed) this.scheduleLiveDraft(draftId, record, record.text === text);
      });
    record.inFlight = sending;
    await sending;
  }

  private call(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    if (method !== 'sendMessage') return this.callNow(method, parameters);
    const sending = this.outboundChain.then(async () => {
      const waitMs = Math.max(0, 1000 - (Date.now() - this.lastMessageSendAt));
      if (waitMs) await delay(waitMs, undefined, { signal: this.abort.signal });
      try {
        return await this.callNow(method, parameters);
      } finally {
        this.lastMessageSendAt = Date.now();
      }
    });
    this.outboundChain = sending.catch(() => {});
    return sending;
  }

  private async callNow(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(35_000)]);
    const response = await this.fetchApi(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters),
      signal,
    }).catch(() => {
      throw new TelegramApiError(`Telegram ${method}: connection failed.`, null);
    });
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error(`Telegram ${method} response exceeded the size limit.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Telegram ${method} returned invalid JSON.`);
    }
    if (!isRecord(parsed) || parsed.ok !== true) {
      const description = isRecord(parsed) && typeof parsed.description === 'string' ? parsed.description : `HTTP ${response.status}`;
      const retry = isRecord(parsed) && isRecord(parsed.parameters) ? parsed.parameters.retry_after : null;
      const retryAfterSeconds = typeof retry === 'number' && Number.isSafeInteger(retry) && retry > 0 && retry <= 86400 ? retry : null;
      throw new TelegramApiError(`Telegram ${method}: ${description.replaceAll(this.token, '[redacted]')}`, retryAfterSeconds);
    }
    return parsed.result;
  }
}

export function splitTelegramText(text: string, maxLength = 4096): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 2 || maxLength > 4096)
    throw new Error('Telegram chunk length must be between 2 and 4096.');
  const chunks: string[] = [];
  if (!text.trim()) return chunks;
  let remaining = text;
  while (remaining) {
    let end = Math.min(maxLength, remaining.length);
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end -= 1;
    const lineBreak = remaining.lastIndexOf('\n', end - 1);
    if (end < remaining.length && lineBreak > end / 2) end = lineBreak + 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

/**
 * Split escaped HTML text without cutting entities (`&amp;`, `&lt;`,
 * `&gt;`): a trailing partial entity moves to the next chunk. A cut entity
 * would render as literal garbage; an unclosed tag would fail the send.
 */
function splitEscapedText(escaped: string, maxLength = 4096): string[] {
  // Reserve the longest escaped entity so moving a partial prefix cannot overflow the next chunk.
  const chunks = splitTelegramText(escaped, Math.max(2, maxLength - 5));
  for (let index = 0; index + 1 < chunks.length; index += 1) {
    const partial = /&[a-zA-Z]+$/.exec(chunks[index]!);
    if (!partial) continue;
    chunks[index] = chunks[index]!.slice(0, -partial[0].length);
    chunks[index + 1] = `${partial[0]}${chunks[index + 1]!}`;
  }
  return chunks;
}

function telegramDraftPreview(text: string): string {
  const source = text.trim() || 'Ranite is working…';
  if (source.length <= LIVE_DRAFT_TEXT_LIMIT) return source;
  let start = source.length - (LIVE_DRAFT_TEXT_LIMIT - 2);
  if (/^[\uDC00-\uDFFF]$/.test(source[start] ?? '') && /[\uD800-\uDBFF]/.test(source[start - 1] ?? '')) start += 1;
  return `…\n${source.slice(start)}`;
}

function codeHash(code: string): Buffer {
  return createHash('sha256').update(code.toLowerCase()).digest();
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
