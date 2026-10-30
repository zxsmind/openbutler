import { describe, expect, it, vi } from 'vitest';
import {
  createTeamGroupTool,
  createTeamHistoryTool,
  createTeamSendTool,
  createTeamStatusTool,
} from '../../src/tools/team-communication.js';
import { shouldWakeForTeamDms } from '../../src/team/service.js';

describe('team_send tool', () => {
  it('defaults to the group channel and passes an explicit recipient through', async () => {
    const send = vi.fn(async () => ({ status: 'sent' }));
    const tool = createTeamSendTool(send);
    await tool.execute!({ text: 'hello' });
    expect(send).toHaveBeenCalledWith({ recipient: 'group', text: 'hello' });
    await tool.execute!({ text: 'psst', recipient: 'Atreus-OpenButler', replyTo: 'm_1' });
    expect(send).toHaveBeenLastCalledWith({ recipient: 'Atreus-OpenButler', text: 'psst', replyTo: 'm_1' });
  });

  it('refuses an empty body without calling the host', async () => {
    const send = vi.fn(async () => ({ status: 'sent' }));
    const tool = createTeamSendTool(send);
    const result = (await tool.execute!({ text: '   ' })) as { status: string };
    expect(result.status).toBe('invalid');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('team_group tool', () => {
  it('reads the group with a limit and validates it', async () => {
    const group = vi.fn(async () => ({ status: 'ok', count: 0, messages: [] }));
    const tool = createTeamGroupTool(group);
    await tool.execute!({ limit: 10 });
    expect(group).toHaveBeenCalledWith(10);
    const bad = (await tool.execute!({ limit: 0 })) as { status: string };
    expect(bad.status).toBe('invalid');
    expect(group).toHaveBeenCalledTimes(1);
  });
});

describe('team_status tool', () => {
  it('returns the roster from the host', async () => {
    const status = vi.fn(async () => ({ status: 'ok', memberCount: 2 }));
    const tool = createTeamStatusTool(status);
    const result = (await tool.execute!({})) as { memberCount: number };
    expect(result.memberCount).toBe(2);
    expect(status).toHaveBeenCalledTimes(1);
  });
});

describe('team_history tool', () => {
  it('reads the group and a dm conversation, requiring a peer for dm', async () => {
    const history = vi.fn(async () => ({ status: 'ok', messages: [] }));
    const tool = createTeamHistoryTool(history);
    await tool.execute!({ scope: 'group', limit: 10 });
    expect(history).toHaveBeenLastCalledWith({ scope: 'group', limit: 10 });
    await tool.execute!({ scope: 'dm', peer: 'Atreus-OpenButler' });
    expect(history).toHaveBeenLastCalledWith({ scope: 'dm', peer: 'Atreus-OpenButler' });

    const bad = (await tool.execute!({ scope: 'dm' })) as { status: string };
    expect(bad.status).toBe('invalid');
    expect(history).toHaveBeenCalledTimes(2);
  });
});

describe('team wake decision', () => {
  it('wakes on a new direct message, in progress or idle', () => {
    expect(shouldWakeForTeamDms({ count: 1, highestSeq: 5, seenSeq: 0 })).toBe(true);
    // A burst after a first wake does not wake again.
    expect(shouldWakeForTeamDms({ count: 3, highestSeq: 5, seenSeq: 5 })).toBe(false);
    // A message that arrives while a run is in progress still wakes: the controller steers it in.
    expect(shouldWakeForTeamDms({ count: 1, highestSeq: 6, seenSeq: 5 })).toBe(true);
    // Nothing unread never wakes.
    expect(shouldWakeForTeamDms({ count: 0, highestSeq: 9, seenSeq: 0 })).toBe(false);
  });
});
