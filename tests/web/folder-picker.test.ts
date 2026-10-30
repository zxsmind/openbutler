import { describe, expect, it } from 'vitest';

/**
 * The picker registry is the one platform switch in the folder picker, so the
 * platform-neutral contract it exposes is what these tests pin down: a picker
 * on every platform OpenButler serves, and an explanation instead of silence
 * anywhere else.
 */

async function registry() {
  return await import('../../src/web/pickers/index.js');
}

describe('folder picker registry', () => {
  it('offers a picker on every platform OpenButler serves', async () => {
    const { folderPickerFor } = await registry();
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(typeof folderPickerFor(platform)).toBe('function');
    }
  });

  it('explains itself on a platform that ships no picker', async () => {
    const { folderPickerFor } = await registry();
    await expect(folderPickerFor('freebsd')()).rejects.toThrow(/no native folder picker/i);
  });

  it('keeps the pickers distinct so one platform cannot answer for another', async () => {
    const { folderPickerFor } = await registry();
    expect(folderPickerFor('win32')).not.toBe(folderPickerFor('darwin'));
    expect(folderPickerFor('darwin')).not.toBe(folderPickerFor('linux'));
  });
});
