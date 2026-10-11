import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareLocalMemoryModel, runSetup } from '../../src/cli/setup.js';

const setup = vi.hoisted(() => ({
  select: vi.fn(),
  prepare: vi.fn(),
  save: vi.fn(),
  spinner: { start: vi.fn(), succeed: vi.fn(), fail: vi.fn(), text: '' },
}));

vi.mock('@inquirer/prompts', () => ({ select: setup.select, confirm: vi.fn(), input: vi.fn(), password: vi.fn(), search: vi.fn() }));
vi.mock('../../src/memory-index.js', () => ({ MEMORY_EMBEDDING_DIMENSIONS: 384 }));
vi.mock('../../src/memory-model-preparation.js', () => ({ prepareMemoryEmbeddingModelInChild: setup.prepare }));
vi.mock('../../src/settings.js', () => ({
  loadSettings: () => ({ providers: { configured: { enabled: true, keys: ['existing-test-key'] } } }),
  saveSettings: setup.save,
  getSettingsPath: () => 'unused-test-settings.yaml',
}));
vi.mock('../../src/cli/ui.js', () => ({
  section: vi.fn(),
  kv: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  line: vi.fn(),
  success: vi.fn(),
  bytes: (bytes: number) => `${bytes} B`,
  spinner: () => setup.spinner,
}));

const previousExitCode = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
  setup.select.mockReset();
  setup.prepare.mockReset().mockResolvedValue(undefined);
  setup.spinner.start.mockReturnValue(setup.spinner);
});
afterEach(() => {
  process.exitCode = previousExitCode;
});

describe('setup local memory preparation', () => {
  it('lets an existing installation prepare memory without changing provider settings', async () => {
    setup.select.mockResolvedValueOnce('memory');
    expect(await runSetup()).toBe(true);
    expect(setup.select).toHaveBeenCalledTimes(1);
    expect(setup.prepare).toHaveBeenCalledTimes(1);
    expect(setup.save).not.toHaveBeenCalled();
    expect(setup.spinner.succeed).toHaveBeenCalledWith('Local memory model ready (384 dimensions).');
  });

  it('retries a failed preparation and reports ready only after success', async () => {
    setup.prepare.mockRejectedValueOnce(new Error('download interrupted'));
    setup.select.mockResolvedValueOnce('retry');
    expect(await prepareLocalMemoryModel()).toBe(true);
    expect(setup.prepare).toHaveBeenCalledTimes(2);
    expect(setup.spinner.fail).toHaveBeenCalledTimes(1);
    expect(setup.spinner.succeed).toHaveBeenCalledTimes(1);
  });

  it('reports an incomplete memory model when the user exits after a failure', async () => {
    setup.prepare.mockRejectedValueOnce(new Error('offline and no cache'));
    setup.select.mockResolvedValueOnce('exit');
    expect(await prepareLocalMemoryModel()).toBe(false);
    expect(setup.spinner.succeed).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(setup.save).not.toHaveBeenCalled();
  });

  it('returns incomplete setup to prevent session startup after memory preparation fails', async () => {
    setup.select.mockResolvedValueOnce('memory').mockResolvedValueOnce('exit');
    setup.prepare.mockRejectedValueOnce(new Error('memory inference failed'));
    expect(await runSetup()).toBe(false);
    expect(setup.spinner.succeed).not.toHaveBeenCalled();
    expect(setup.save).not.toHaveBeenCalled();
  });
});
