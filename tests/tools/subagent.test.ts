import { describe, expect, it, vi } from 'vitest';
import { createSubagentTool } from '../../src/tools/subagent.js';

describe('subagent tool', () => {
  it('passes the chosen mode and background flag with the trimmed task, context, sender id and signal', async () => {
    const spawn = vi.fn(async () => ({ status: 'completed', report: 'done' }));
    const tool = createSubagentTool(spawn);
    const signal = new AbortController().signal;
    const result = await tool.execute(
      {
        task: '  Inspect the repo.  ',
        mode: 'executor',
        background: false,
        context: { paths: ['src/agent.ts'], notes: 'Focus on tool wiring.' },
      },
      signal,
      { sessionId: 'sender-1' },
    );
    expect(spawn).toHaveBeenCalledWith(
      {
        task: 'Inspect the repo.',
        mode: 'executor',
        background: false,
        context: { paths: ['src/agent.ts'], notes: 'Focus on tool wiring.' },
      },
      'sender-1',
      signal,
    );
    expect(result).toEqual({ status: 'completed', report: 'done' });
  });

  it('accepts an explorer background request without a context object', async () => {
    const spawn = vi.fn(async () => ({ status: 'completed', report: 'found' }));
    const tool = createSubagentTool(spawn);
    await tool.execute({ task: 'Find the config reader.', mode: 'explorer', background: true });
    expect(spawn).toHaveBeenCalledWith(
      { task: 'Find the config reader.', mode: 'explorer', background: true, context: { paths: [] } },
      undefined,
      undefined,
    );
  });

  it('rejects empty, oversized and malformed input without calling the host', async () => {
    const spawn = vi.fn();
    const tool = createSubagentTool(spawn);
    expect(await tool.execute({ task: '' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: '   ' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: 'x'.repeat(8_001) })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: 'ok', background: false })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: 'ok', mode: 'worker', background: false })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: 'ok', mode: 'executor' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: 'ok', mode: 'explorer', background: 'yes' })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: 'ok', mode: 'executor', background: false, context: [] })).toMatchObject({ status: 'invalid' });
    expect(await tool.execute({ task: 'ok', mode: 'executor', background: false, context: { paths: 'src' } })).toMatchObject({
      status: 'invalid',
    });
    expect(
      await tool.execute({
        task: 'ok',
        mode: 'executor',
        background: false,
        context: { paths: Array.from({ length: 51 }, () => 'a') },
      }),
    ).toMatchObject({
      status: 'invalid',
    });
    expect(await tool.execute({ task: 'ok', mode: 'executor', background: false, context: { notes: 'x'.repeat(20_001) } })).toMatchObject({
      status: 'invalid',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('maps host failures to an error result and stays a pre-approved host tool', () => {
    const tool = createSubagentTool(() => {
      throw new Error('boom');
    });
    expect(tool.name).toBe('subagent');
    expect(tool.providerId).toBe('host');
    expect(tool.autoApprove?.({}, undefined)).toBe(true);
    expect(tool.effect).toEqual({ change: 'none', data: 'sensitive', network: 'none', reversible: 'full', outbound: 'model' });
    return expect(tool.execute({ task: 'Run it.', mode: 'executor', background: false })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('boom'),
    });
  });
});
