/**
 * Deterministic routing decisions for the Telegram channel.
 *
 * The owner's Telegram chat is one line: every inbound message resolves to
 * exactly one session at arrival (reply-correlation, then the fixed binding,
 * then the custodian's current conversation), and outbound messages carry the
 * session that authored them. No pointer decision is made at delivery time,
 * so a session switch elsewhere can never re-route the channel.
 */

export function telegramBindingKey(userId: string): string {
  return `telegram:binding:${userId}`;
}

export function telegramMessageOriginKey(chatId: string, messageId: number): string {
  return `telegram:message:${chatId}:${messageId}`;
}

export interface TelegramTargetResolution {
  /** Session that authored the message being replied to, when the reply chain identifies one. */
  replyOriginSessionId?: string | null;
  /** The fixed Telegram line for this owner chat. */
  bindingSessionId?: string | null;
  /** Fallback for the first message after an upgrade: the custodian's conversation. */
  custodianSessionId?: string | null;
  /** Rejects targets whose session no longer exists, so a stale id falls through. */
  exists: (sessionId: string) => boolean;
}

/**
 * Reply-correlation > fixed binding > custodian current. Returns null only
 * when nothing resolves; the caller then falls back to the custodian
 * controller and freezes that conversation as the binding.
 */
export function resolveTelegramTargetSession(input: TelegramTargetResolution): string | null {
  if (input.replyOriginSessionId && input.exists(input.replyOriginSessionId)) return input.replyOriginSessionId;
  if (input.bindingSessionId && input.exists(input.bindingSessionId)) return input.bindingSessionId;
  if (input.custodianSessionId && input.exists(input.custodianSessionId)) return input.custodianSessionId;
  return null;
}

/**
 * An owner-inbox row is visible only to its target session. A row without a
 * resolvable target (legacy events, or a deleted session) stays open exactly
 * like the pre-binding inbox, so no message ever becomes unreadable.
 */
export function ownerInboxVisibleTo(targetSessionId: string | null, readerSessionId: string): boolean {
  return targetSessionId === null || targetSessionId === readerSessionId;
}

/**
 * Outbound label for messages sent from a session other than the bound line,
 * so the owner can tell which chat a Telegram message came from. The bound
 * session (or a host notice without a sender) stays unlabeled.
 */
export function telegramOutboundLabel(input: {
  senderSessionId?: string | null;
  boundSessionId?: string | null;
  senderTitle?: string | null;
}): string {
  if (!input.senderSessionId || input.senderSessionId === input.boundSessionId) return '';
  const title = input.senderTitle?.replace(/\s+/g, ' ').trim();
  return title ? `[${title.slice(0, 120)}]` : `[session ${input.senderSessionId.slice(0, 8)}]`;
}
