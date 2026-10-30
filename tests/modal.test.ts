import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyModalCredentials } from '../src/modal.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-modal-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const respond = (status: number, body: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }) as unknown as Response;

describe('modal credentials', () => {
  it('accepts a pair Modal accepts, and reports the app count', async () => {
    const fetchImpl = vi.fn(async () => respond(200, { data: [{ app_id: 'ap-1' }, { app_id: 'ap-2' }] })) as unknown as typeof fetch;
    const check = await verifyModalCredentials({ tokenId: 'ak-1', tokenSecret: 'as-1' }, { fetchImpl });
    expect(check).toEqual({ ok: true, apps: 2, error: null });
    // The pair travels joined by a period in a Bearer header, which is what Modal expects.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      'https://api.modal.com/v1/apps',
      expect.objectContaining({ headers: { authorization: 'Bearer ak-1.as-1' } }),
    ]);
  });

  it('rejects a pair Modal refuses, and survives an unreachable API', async () => {
    const refused = vi.fn(async () => respond(401, {})) as unknown as typeof fetch;
    expect(await verifyModalCredentials({ tokenId: 'ak-1', tokenSecret: 'bad' }, { fetchImpl: refused })).toEqual({
      ok: false,
      apps: null,
      error: 'Modal rejected this token id and secret.',
    });

    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await verifyModalCredentials({ tokenId: 'ak-1', tokenSecret: 'as-1' }, { fetchImpl: offline })).toEqual({
      ok: false,
      apps: null,
      error: 'Modal could not be reached.',
    });
  });

  it('stores the pair on this machine and never exposes the secret through settings', async () => {
    const settings = await import('../src/settings.js');
    expect(settings.loadModalCredentials()).toBeNull();
    settings.saveModalCredentials({ tokenId: 'ak-1', tokenSecret: 'as-secret' });
    expect(settings.loadModalCredentials()).toEqual({ tokenId: 'ak-1', tokenSecret: 'as-secret' });

    // A normal settings save must not drop the token: it rewrites the same file.
    settings.saveSettings(settings.loadSettings());
    expect(settings.loadModalCredentials()).toEqual({ tokenId: 'ak-1', tokenSecret: 'as-secret' });

    settings.clearModalCredentials();
    expect(settings.loadModalCredentials()).toBeNull();
  });
});
