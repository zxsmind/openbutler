/** Host-owned communication facts; channel adapters never choose agent identity. */
import type { FileAttachment } from './attachments.js';
// Legacy source tags remain readable in saved sessions. All new notifications use inbox.
export const LOCAL_CLIENT_KINDS = ['terminal', 'web'] as const;
export type LocalClientKind = (typeof LOCAL_CLIENT_KINDS)[number];
export const TURN_SOURCES = [
  ...LOCAL_CLIENT_KINDS,
  'telegram',
  'inbox',
  'owner-inbox',
  'schedule',
  'background',
  'team',
  'worker',
] as const;
export type OwnerReplyRoute = { channel: 'terminal' } | { channel: 'telegram'; chatId: string };
export type TurnCommunication = {
  source: (typeof TURN_SOURCES)[number];
  replyTo?: OwnerReplyRoute;
};
export type OwnerInboxMessage = {
  id: string;
  source: 'telegram';
  receivedAt: string;
  text: string;
  attachments?: FileAttachment[];
  /** Legacy saved tool results only. New messages carry file references. */
  image?: { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; filename: string };
};

export function sameReplyRoute(left: OwnerReplyRoute | undefined, right: OwnerReplyRoute | undefined): boolean {
  return Boolean(
    left &&
    right &&
    left.channel === right.channel &&
    (left.channel === 'terminal' || (right.channel === 'telegram' && left.chatId === right.chatId)),
  );
}

export function resolveOwnerNotificationRoute(
  channel: 'auto' | 'terminal' | 'telegram',
  terminalAttached: boolean,
  telegramChatId: string | undefined,
): OwnerReplyRoute {
  if (channel === 'terminal' || (channel === 'auto' && terminalAttached)) {
    if (!terminalAttached) throw new Error('No owner terminal is connected.');
    return { channel: 'terminal' };
  }
  if (!telegramChatId) throw new Error('No owner Telegram chat is configured.');
  return { channel: 'telegram', chatId: telegramChatId };
}

/**
 * Where a fresh approval goes. The owner decides in exactly one place: a
 * terminal attached to that session sees it live, so Telegram stays silent;
 * with no terminal on the session, Telegram pings and every client gets a
 * pointer notice. Never both.
 */
export function resolveApprovalFanout(sessionHasTerminal: boolean): { telegram: boolean; broadcast: boolean } {
  return sessionHasTerminal ? { telegram: false, broadcast: false } : { telegram: true, broadcast: true };
}
