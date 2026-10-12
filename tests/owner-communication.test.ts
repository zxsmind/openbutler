import { describe, expect, it } from 'vitest';
import { resolveOwnerNotificationRoute, sameReplyRoute } from '../src/communication.js';

describe('host-owned owner routes', () => {
  it('uses presence only for proactive auto delivery and keeps explicit Telegram replies independent', () => {
    expect(resolveOwnerNotificationRoute('auto', true, '42')).toEqual({ channel: 'terminal' });
    expect(resolveOwnerNotificationRoute('auto', false, '42')).toEqual({ channel: 'telegram', chatId: '42' });
    expect(resolveOwnerNotificationRoute('telegram', true, '42')).toEqual({ channel: 'telegram', chatId: '42' });
    expect(() => resolveOwnerNotificationRoute('terminal', false, '42')).toThrow('No owner terminal');
    expect(() => resolveOwnerNotificationRoute('auto', false, undefined)).toThrow('No owner Telegram');
  });
  it('admits steering only within the same captured reply route', () => {
    expect(sameReplyRoute({ channel: 'telegram', chatId: '42' }, { channel: 'telegram', chatId: '42' })).toBe(true);
    expect(sameReplyRoute({ channel: 'telegram', chatId: '42' }, { channel: 'telegram', chatId: '7' })).toBe(false);
    expect(sameReplyRoute({ channel: 'terminal' }, { channel: 'telegram', chatId: '42' })).toBe(false);
    expect(sameReplyRoute(undefined, undefined)).toBe(false);
  });
});
