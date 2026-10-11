import { describe, expect, it, vi } from 'vitest';
import { createSessionMessageTool } from '../../src/tools/session-message.js';

describe('session_message tool', () => {
  it('passes the trimmed input and the sender session id from the execution context', async () => {
    const send = vi.fn(async () => ({ status: 'delivered', session: 'abc', queued: false }));
    const tool = createSessionMessageTool(send);
    const result = await tool.execute({ session: ' abcd1234 ', text: 'Wrap up.' }, undefined, { sessionId: 'sender-1' });
    expect(send).toHaveBeenCalledWith({ session: 'abcd1234', text: 'Wrap up.' }, 'sender-1');
    expect(result).toEqual({ status: 'delivered', session: 'abc', queued: false });
  });

  it('rejects empty or oversized input without calling the host', async () => {
    const send = vi.fn();
    const tool = createSessionMessageTool(send);
    expect(await tool.execute({ session: '', text: 'hi' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ session: 'abcd', text: '   ' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ session: 'abcd', text: 'x'.repeat(2_001) })).toMatchObject({ status: 'invalid' });
    expect(send).not.toHaveBeenCalled();
  });

  it('maps host failures to an error result and stays a pre-approved host tool', async () => {
    const tool = createSessionMessageTool(() => {
      throw new Error('boom');
    });
    expect(await tool.execute({ session: 'abcd', text: 'hello' })).toMatchObject({
      status: 'error',
      error: expect.stringContaining('boom'),
    });
    expect(tool.autoApprove?.({}, undefined)).toBe(true);
    expect(tool.name).toBe('session_message');
    expect(tool.effect).toEqual({ change: 'none', data: 'sensitive', network: 'none', reversible: 'full', outbound: 'model' });
  });
});
