import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryIndex } from '../src/memory-index.js';

const child = vi.hoisted(() => {
  class FakeChild {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    stdout = { resume() {} };
    stderr = { on: () => {} };
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    off(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== listener),
      );
      return this;
    }
    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
    kill() {}
    succeed() {
      this.emit('message', { type: 'done' });
      this.emit('exit', 0);
    }
    fail(message: string) {
      this.emit('message', { type: 'error', message });
      this.emit('exit', 1);
    }
  }
  return { FakeChild, instance: undefined as InstanceType<typeof FakeChild> | undefined, fork: vi.fn() };
});

vi.mock('node:child_process', () => ({ fork: child.fork }));

const modelState = vi.hoisted(() => ({ ready: false }));
vi.mock('../src/memory-index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/memory-index.js')>()),
  isMemoryEmbeddingModelPrepared: vi.fn(async () => modelState.ready),
}));

const match = {
  path: 'C:\\memory\\user\\notes\\note.md',
  startLine: 1,
  endLine: 2,
  type: 'user' as const,
  title: 'Note',
  description: '',
  heading: 'Note > Summary',
  score: 0.5,
  snippet: 'text',
};

beforeEach(() => {
  vi.resetModules();
  modelState.ready = false;
  child.instance = undefined;
  child.fork.mockReset();
  child.fork.mockImplementation(() => {
    child.instance = new child.FakeChild();
    return child.instance;
  });
});

describe('memory model preparation lifecycle', () => {
  it('prepares once, holds a failure behind a cooldown, and allows an explicit retry', async () => {
    const preparation = await import('../src/memory-model-preparation.js');
    expect(preparation.memoryModelPreparationStatus()).toEqual({ state: 'idle' });
    expect(preparation.ensureMemoryModelPreparation()).toEqual({ state: 'preparing' });
    expect(preparation.ensureMemoryModelPreparation()).toEqual({ state: 'preparing' });
    expect(child.fork).toHaveBeenCalledTimes(1);
    child.instance!.fail('download boom');
    await vi.waitFor(() => expect(preparation.memoryModelPreparationStatus()).toEqual({ state: 'failed', error: 'download boom' }));
    expect(preparation.ensureMemoryModelPreparation()).toEqual({ state: 'failed', error: 'download boom' });
    expect(child.fork).toHaveBeenCalledTimes(1);
    expect(preparation.ensureMemoryModelPreparation({ retryCooldownMs: 0 })).toEqual({ state: 'preparing' });
    expect(child.fork).toHaveBeenCalledTimes(2);
  });
});

describe('memory_search model states', () => {
  function toolFor(): MemoryIndex {
    return {
      search: vi.fn(async () => ({ matches: [match], indexedSources: 1, indexedChunks: 1, emptyMemory: false })),
    } as unknown as MemoryIndex;
  }

  it('reports model_preparing while the background download runs, then searches once ready', async () => {
    const { createMemorySearchTool } = await import('../src/tools/memory-search.js');
    const { memoryModelPreparationStatus } = await import('../src/memory-model-preparation.js');
    const index = toolFor();
    const searchTool = createMemorySearchTool(index);
    expect(await searchTool.execute({ query: 'anything' })).toMatchObject({ status: 'model_preparing' });
    expect(index.search).not.toHaveBeenCalled();
    child.instance!.succeed();
    await vi.waitFor(() => expect(memoryModelPreparationStatus().state).toBe('idle'));
    modelState.ready = true;
    expect(await searchTool.execute({ query: 'anything' })).toMatchObject({ status: 'completed' });
    expect(index.search).toHaveBeenCalledWith('anything', 5);
  });

  it('reports model_unavailable with the failure reason and never searches', async () => {
    const { createMemorySearchTool } = await import('../src/tools/memory-search.js');
    const { memoryModelPreparationStatus } = await import('../src/memory-model-preparation.js');
    const index = toolFor();
    const searchTool = createMemorySearchTool(index);
    await searchTool.execute({ query: 'anything' });
    child.instance!.fail('disk full');
    await vi.waitFor(() => expect(memoryModelPreparationStatus().state).toBe('failed'));
    const result = (await searchTool.execute({ query: 'anything' })) as { message?: unknown };
    expect(result).toMatchObject({ status: 'model_unavailable' });
    expect(String(result.message)).toContain('disk full');
    expect(index.search).not.toHaveBeenCalled();
  });
});
