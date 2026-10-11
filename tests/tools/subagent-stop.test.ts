import { describe, expect, it, vi } from 'vitest';
import { createSubagentStopTool } from '../../src/tools/subagent-stop.js';

describe('subagent_stop tool', () => {
  it('passes the worker reference and the caller session id from the execution context', async () => {
    const stop = vi.fn(async () => ({ status: 'stopped', session: 'worker-1' }));
    const tool = createSubagentStopTool(stop);
    const result = await tool.execute({ session: 'worker-1' }, undefined, { sessionId: 'parent-1' });
    expect(stop).toHaveBeenCalledWith({ session: 'worker-1' }, 'parent-1');
    expect(result).toEqual({ status: 'stopped', session: 'worker-1' });
  });

  it('rejects empty input without calling the host', async () => {
    const stop = vi.fn();
    const tool = createSubagentStopTool(stop);
    expect(await tool.execute({ session: '' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({})).toMatchObject({ status: 'invalid' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('maps host failures to an error result and stays a pre-approved host tool', () => {
    const tool = createSubagentStopTool(() => {
      throw new Error('boom');
    });
    expect(tool.name).toBe('subagent_stop');
    expect(tool.providerId).toBe('host');
    expect(tool.autoApprove?.({}, undefined)).toBe(true);
    expect(tool.effect).toEqual({ change: 'none', data: 'sensitive', network: 'none', reversible: 'full', outbound: 'model' });
    return expect(tool.execute({ session: 'abcd' })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('boom'),
    });
  });
});
