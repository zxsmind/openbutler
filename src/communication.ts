/** Host-owned communication facts; channel adapters never choose agent identity. */
export type OwnerReplyRoute = { channel: 'terminal' } | { channel: 'telegram'; chatId: string };
export type TurnCommunication = {
  source: 'terminal' | 'telegram' | 'owner-inbox' | 'background';
  replyTo?: OwnerReplyRoute;
};
export type OwnerInboxMessage = {
  id: string;
  source: 'telegram';
  receivedAt: string;
  text: string;
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
