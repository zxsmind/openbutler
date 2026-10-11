import { describe, expect, it, vi } from 'vitest';
import { createSubagentPollTool } from '../../src/tools/subagent-poll.js';

describe('subagent_poll tool', () => {
  it('passes the worker reference and the caller session id from the execution context', async () => {
    const poll = vi.fn(async () => ({ status: 'finished', session: 'worker-1', notes: [], report: 'done' }));
    const tool = createSubagentPollTool(poll);
    const result = await tool.execute({ session: 'worker-1' }, undefined, { sessionId: 'parent-1' });
    expect(poll).toHaveBeenCalledWith({ session: 'worker-1' }, 'parent-1');
    expect(result).toEqual({ status: 'finished', session: 'worker-1', notes: [], report: 'done' });
  });

  it('rejects empty input without calling the host', async () => {
    const poll = vi.fn();
    const tool = createSubagentPollTool(poll);
    expect(await tool.execute({ session: '' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({})).toMatchObject({ status: 'invalid' });
    expect(poll).not.toHaveBeenCalled();
  });

  it('maps host failures to an error result and stays a pre-approved host tool', () => {
    const tool = createSubagentPollTool(() => {
      throw new Error('boom');
    });
    expect(tool.name).toBe('subagent_poll');
    expect(tool.providerId).toBe('host');
    expect(tool.autoApprove?.({}, undefined)).toBe(true);
    expect(tool.effect).toEqual({ change: 'none', data: 'sensitive', network: 'none', reversible: 'full', outbound: 'model' });
    return expect(tool.execute({ session: 'abcd' })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('boom'),
    });
  });
});
