import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let previousDataDir: string | undefined;

const effect = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' } as const;
const request = (input: Record<string, unknown> = {}) => ({
  requestId: 'request-1',
  providerId: 'host',
  name: 'inspect',
  input,
  effect,
});

async function store() {
  return import('../src/review-overrides.js');
}

beforeEach(() => {
  previousDataDir = process.env.RANITE_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'ranite-review-overrides-'));
  process.env.RANITE_DATA_DIR = root;
  vi.resetModules();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.RANITE_DATA_DIR;
  else process.env.RANITE_DATA_DIR = previousDataDir;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ranite-review-overrides-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(root, { recursive: true, force: true });
});

describe('review override store', () => {
  it('records denials without persisting raw inputs, caps at ten, and lists newest first', async () => {
    const overrides = await store();
    for (let index = 0; index < 12; index++) {
      overrides.recordDeniedAction(root, { ...request(), input: { n: index } } as never, `reason ${index}`);
    }
    const listed = overrides.listDeniedActions();
    expect(listed).toHaveLength(10);
    expect(listed[0]!.reason).toBe('reason 11');
    const raw = readFileSync(join(root, 'review-denials.json'), 'utf8');
    expect(raw).not.toContain('reason 0');
    expect(raw).not.toContain('"input"');
  });

  it('approves exactly one retry and consumes the marker on first use', async () => {
    const overrides = await store();
    overrides.recordDeniedAction(root, request() as never, 'Outside the request.');
    const [denied] = overrides.listDeniedActions();
    expect(overrides.approveDeniedAction(denied!.fingerprint)).toMatchObject({ name: 'inspect' });
    expect(overrides.listDeniedActions()).toHaveLength(0);
    expect(overrides.consumeApproval(root, request() as never)).toBe(true);
    expect(overrides.consumeApproval(root, request() as never)).toBe(false);
  });

  it('does not match a different workspace or a different action', async () => {
    const overrides = await store();
    overrides.recordDeniedAction(root, request() as never, 'Outside the request.');
    const [denied] = overrides.listDeniedActions();
    overrides.approveDeniedAction(denied!.fingerprint);
    expect(overrides.consumeApproval(join(root, 'other'), request() as never)).toBe(false);
    expect(overrides.consumeApproval(root, { ...request(), name: 'other-tool' } as never)).toBe(false);
    expect(overrides.consumeApproval(root, request() as never)).toBe(true);
  });

  it('drops expired entries and quarantines corrupt files', async () => {
    const overrides = await store();
    overrides.recordDeniedAction(root, request() as never, 'Old denial.');
    const { writeFileSync } = await import('node:fs');
    const denialsPath = join(root, 'review-denials.json');
    const parsed = JSON.parse(readFileSync(denialsPath, 'utf8')) as { denials: Array<{ deniedAt: number }> };
    parsed.denials[0]!.deniedAt = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(denialsPath, JSON.stringify(parsed));
    vi.resetModules();
    expect((await store()).listDeniedActions()).toHaveLength(0);

    writeFileSync(denialsPath, 'not json{{{');
    vi.resetModules();
    expect((await store()).listDeniedActions()).toEqual([]);
  });
});
