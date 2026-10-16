import { describe, expect, it, vi } from 'vitest';
import { createTeamInboxTool, createTeamSendTool } from '../../src/tools/team-communication.js';
import { shouldWakeForTeamDms } from '../../src/team/service.js';

describe('team_send tool', () => {
  it('defaults to the group channel and passes an explicit recipient through', async () => {
    const send = vi.fn(async () => ({ status: 'sent' }));
    const tool = createTeamSendTool(send);
    await tool.execute!({ text: 'hello' });
    expect(send).toHaveBeenCalledWith({ recipient: 'group', text: 'hello' });
    await tool.execute!({ text: 'psst', recipient: 'Atreus-Ranite', replyTo: 'm_1' });
    expect(send).toHaveBeenLastCalledWith({ recipient: 'Atreus-Ranite', text: 'psst', replyTo: 'm_1' });
  });

  it('refuses an empty body without calling the host', async () => {
    const send = vi.fn(async () => ({ status: 'sent' }));
    const tool = createTeamSendTool(send);
    const result = (await tool.execute!({ text: '   ' })) as { status: string };
    expect(result.status).toBe('invalid');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('team_inbox tool', () => {
  it('acknowledges then reads, and validates its inputs', async () => {
    const inbox = vi.fn(async () => ({ status: 'ok', count: 0, messages: [] }));
    const tool = createTeamInboxTool(inbox);
    await tool.execute!({ limit: 5, acknowledge: ['m_1'] });
    expect(inbox).toHaveBeenCalledWith(5, ['m_1']);

    const bad = (await tool.execute!({ limit: 999 })) as { status: string };
    expect(bad.status).toBe('invalid');
    expect(inbox).toHaveBeenCalledTimes(1);
  });
});

describe('team wake decision', () => {
  it('wakes on a new direct message only when the session is idle', () => {
    expect(shouldWakeForTeamDms({ count: 1, highestSeq: 5, seenSeq: 0, busy: false })).toBe(true);
    // A burst after a first wake does not wake again.
    expect(shouldWakeForTeamDms({ count: 3, highestSeq: 5, seenSeq: 5, busy: false })).toBe(false);
    // A busy run is left alone; the same message wakes on a later idle tick.
    expect(shouldWakeForTeamDms({ count: 1, highestSeq: 6, seenSeq: 5, busy: true })).toBe(false);
    // Nothing unread never wakes.
    expect(shouldWakeForTeamDms({ count: 0, highestSeq: 9, seenSeq: 0, busy: false })).toBe(false);
  });
});
