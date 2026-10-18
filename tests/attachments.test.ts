import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentReferences, isStoredAttachmentPath, storeAttachment } from '../src/attachments.js';
import { sessionFilePath, sessionAttachmentsDirectory, legacySessionFilePath } from '../src/session-paths.js';
import { createReadTool } from '../src/tools/file-read.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C9sAAAAASUVORK5CYII=', 'base64');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-session-attachments-'));
  vi.stubEnv('RANITE_DATA_DIR', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('session-owned attachments', () => {
  it('stores files only beneath the owning session and retries preserve the same immutable file', () => {
    const first = storeAttachment(FIRST, PNG, 'first.png', 'image/png');
    const retry = storeAttachment(FIRST, PNG, 'renamed.png', 'image/png');
    const other = storeAttachment(SECOND, PNG, 'second.png', 'image/png');
    expect(dirname(first.path)).toBe(join(root, 'sessions', FIRST, 'attachments'));
    expect(retry.path).toBe(first.path);
    expect(other.path).not.toBe(first.path);
    expect(readFileSync(first.path)).toEqual(PNG);
    expect(existsSync(join(root, 'attachments'))).toBe(false);
    expect(attachmentReferences([first, other])).toBe(`[image#1=${JSON.stringify(first.path)}]\n[image#2=${JSON.stringify(other.path)}]`);
    expect(attachmentReferences([other])).toContain('[image#1=');
  });

  it('pre-authorizes only verified file reads and refuses corrupt content or invalid owners', async () => {
    expect(() => storeAttachment('../escape', PNG)).toThrow('Invalid session id');
    const file = storeAttachment(FIRST, PNG, 'image.png', 'image/png');
    const tool = createReadTool(['image'], root);
    expect(tool.hostPreAuthorized?.({ path: file.path }, file.path)).toBe(true);
    writeFileSync(file.path, Buffer.from('damaged'));
    expect(isStoredAttachmentPath(file.path)).toBe(false);
    await expect(tool.execute({ path: file.path })).rejects.toThrow('integrity');
    expect(() => storeAttachment(FIRST, PNG, 'image.png', 'image/png')).toThrow('integrity');
    expect(readFileSync(file.path).toString()).toBe('damaged');
  });

  it('keeps transcript, files, registry and legacy loading on one session layout', async () => {
    const store = await import('../src/session-store.js');
    const session = { ...store.createSession('fixture', 'fixture'), id: FIRST };
    session.entries.push({ kind: 'user', text: 'Inspect [image#1].' });
    store.saveSession(session);
    const file = storeAttachment(FIRST, PNG, 'image.png', 'image/png');
    expect(existsSync(sessionFilePath(FIRST))).toBe(true);
    expect(dirname(dirname(file.path))).toBe(dirname(sessionFilePath(FIRST)));
    renameSync(sessionFilePath(FIRST), legacySessionFilePath(FIRST));
    expect(store.loadSavedSession(FIRST)?.id).toBe(FIRST);
    store.saveSession({ ...store.loadSavedSession(FIRST)!, title: 'Current directory format' });
    expect(store.listSessionFiles()).toHaveLength(1);
    expect(store.listSavedSessions()[0]?.title).toBe('Current directory format');
    expect(store.listSessionFiles()[0]?.path).toBe(sessionFilePath(FIRST));
    expect(existsSync(file.path)).toBe(true);
    store.removeSavedSession(FIRST);
    expect(existsSync(sessionFilePath(FIRST))).toBe(false);
    expect(existsSync(legacySessionFilePath(FIRST))).toBe(false);
    expect(existsSync(sessionAttachmentsDirectory(FIRST))).toBe(false);
  });
});
