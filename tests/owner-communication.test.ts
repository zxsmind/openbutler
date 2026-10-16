import { describe, expect, it } from 'vitest';
import { resolveApprovalFanout, resolveOwnerNotificationRoute, sameReplyRoute } from '../src/communication.js';

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
  it('decides approval in exactly one place: live terminal or Telegram, never both', () => {
    expect(resolveApprovalFanout(true)).toEqual({ telegram: false, broadcast: false });
    expect(resolveApprovalFanout(false)).toEqual({ telegram: true, broadcast: true });
  });
});
