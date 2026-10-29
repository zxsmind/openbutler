import { describe, expect, it } from 'vitest';
import {
  ownerInboxVisibleTo,
  resolveTelegramTargetSession,
  telegramBindingKey,
  telegramMessageOriginKey,
  telegramOutboundLabel,
} from '../src/telegram-routing.js';

describe('Telegram routing decisions', () => {
  it('prefers the reply origin, then the binding, then the custodian conversation', () => {
    const exists = () => true;
    expect(
      resolveTelegramTargetSession({ replyOriginSessionId: 'origin', bindingSessionId: 'bound', custodianSessionId: 'custodian', exists }),
    ).toBe('origin');
    expect(resolveTelegramTargetSession({ bindingSessionId: 'bound', custodianSessionId: 'custodian', exists })).toBe('bound');
    expect(resolveTelegramTargetSession({ custodianSessionId: 'custodian', exists })).toBe('custodian');
  });

  it('falls through targets whose session no longer exists', () => {
    const exists = (sessionId: string) => sessionId === 'custodian';
    expect(
      resolveTelegramTargetSession({ replyOriginSessionId: 'dead', bindingSessionId: 'gone', custodianSessionId: 'custodian', exists }),
    ).toBe('custodian');
    expect(resolveTelegramTargetSession({ bindingSessionId: 'gone', custodianSessionId: 'custodian', exists })).toBe('custodian');
    expect(resolveTelegramTargetSession({ exists })).toBeNull();
  });

  it('scopes an unread inbox row to its target session and keeps a resolved null row open', () => {
    expect(ownerInboxVisibleTo('target', 'target')).toBe(true);
    expect(ownerInboxVisibleTo('target', 'other')).toBe(false);
    expect(ownerInboxVisibleTo(null, 'other')).toBe(true);
  });

  it('labels outbound from any session other than the bound line', () => {
    expect(telegramOutboundLabel({ senderSessionId: 'bound', boundSessionId: 'bound', senderTitle: 'Main chat' })).toBe('');
    expect(telegramOutboundLabel({ senderSessionId: null, boundSessionId: 'bound' })).toBe('');
    expect(telegramOutboundLabel({ senderSessionId: 'chat-b', boundSessionId: 'bound', senderTitle: 'Setup  \n job' })).toBe('[Setup job]');
    expect(telegramOutboundLabel({ senderSessionId: 'chat-b', boundSessionId: 'bound', senderTitle: '   ' })).toBe('[session chat-b]');
    expect(telegramOutboundLabel({ senderSessionId: 'chat-b', boundSessionId: null, senderTitle: 'x'.repeat(200) })).toBe(
      `[${'x'.repeat(120)}]`,
    );
  });

  it('builds stable ledger keys for the binding and the reply-correlation map', () => {
    expect(telegramBindingKey('7')).toBe('telegram:binding:7');
    expect(telegramMessageOriginKey('42', 91)).toBe('telegram:message:42:91');
  });
});
