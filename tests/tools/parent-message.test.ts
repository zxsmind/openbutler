import { describe, expect, it, vi } from 'vitest';
import { createParentMessageTool } from '../../src/tools/parent-message.js';

describe('parent_message tool', () => {
  it('passes the note and the worker session id from the execution context', async () => {
    const send = vi.fn(async () => ({ status: 'stored', session: 'worker-1' }));
    const tool = createParentMessageTool(send);
    const result = await tool.execute({ text: 'Halfway done.' }, undefined, { sessionId: 'worker-1' });
    expect(send).toHaveBeenCalledWith({ text: 'Halfway done.' }, 'worker-1');
    expect(result).toEqual({ status: 'stored', session: 'worker-1' });
  });

  it('rejects empty or oversized input without calling the host', async () => {
    const send = vi.fn();
    const tool = createParentMessageTool(send);
    expect(await tool.execute({ text: '' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ text: '   ' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ text: 'x'.repeat(2_001) })).toMatchObject({ status: 'invalid' });
    expect(send).not.toHaveBeenCalled();
  });

  it('maps host failures to an error result, stays pre-approved', () => {
    const tool = createParentMessageTool(() => {
      throw new Error('boom');
    });
    expect(tool.name).toBe('parent_message');
    expect(tool.providerId).toBe('host');
    expect(tool.autoApprove?.({}, undefined)).toBe(true);
    expect(tool.effect).toEqual({ change: 'none', data: 'sensitive', network: 'none', reversible: 'full', outbound: 'model' });
    return expect(tool.execute({ text: 'Ping.' })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('boom'),
    });
  });
});
