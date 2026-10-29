import { beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledgeFileLink,
  lineEndOffset,
  lineStartOffset,
  openFileRequest,
  resetFileLinks,
  subscribeFileLink,
  type FileLinkRequest,
} from './file-links.js';

beforeEach(() => {
  resetFileLinks();
});

describe('a citation request reaches the surface that applies it', () => {
  it('notifies every subscriber with the target and its nonce', () => {
    const seen: FileLinkRequest[] = [];
    const seenToo: FileLinkRequest[] = [];
    subscribeFileLink((request) => seen.push(request));
    subscribeFileLink((request) => seenToo.push(request));
    openFileRequest({ path: 'src/a.ts', line: 79 });
    expect(seen).toEqual([{ path: 'src/a.ts', line: 79, nonce: 1 }]);
    expect(seenToo).toEqual(seen);
  });

  it('replays a still-pending request to a subscriber that mounts later', () => {
    openFileRequest({ path: 'src/a.ts' });
    const late: FileLinkRequest[] = [];
    subscribeFileLink((request) => late.push(request));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ path: 'src/a.ts' });
  });

  it('stops replaying once the request has been acknowledged', () => {
    openFileRequest({ path: 'src/a.ts' });
    const first: FileLinkRequest[] = [];
    subscribeFileLink((request) => first.push(request));
    acknowledgeFileLink(first[0].nonce);

    const second: FileLinkRequest[] = [];
    subscribeFileLink((request) => second.push(request));
    expect(second).toHaveLength(0);
  });

  it('ignores an acknowledgement that belongs to an older request', () => {
    openFileRequest({ path: 'src/old.ts' });
    const old: FileLinkRequest[] = [];
    subscribeFileLink((request) => old.push(request));
    const staleNonce = old[0].nonce;

    openFileRequest({ path: 'src/new.ts' });
    acknowledgeFileLink(staleNonce);

    const current: FileLinkRequest[] = [];
    subscribeFileLink((request) => current.push(request));
    expect(current[0]).toMatchObject({ path: 'src/new.ts' });
  });

  it('keeps a nonces increasing so one click cannot clear the next', () => {
    openFileRequest({ path: 'src/one.ts' });
    openFileRequest({ path: 'src/two.ts' });
    const seen: FileLinkRequest[] = [];
    subscribeFileLink((request) => seen.push(request));
    acknowledgeFileLink(seen[0].nonce - 1);
    const after: FileLinkRequest[] = [];
    subscribeFileLink((request) => after.push(request));
    expect(after[0]).toMatchObject({ path: 'src/two.ts' });
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const seen: FileLinkRequest[] = [];
    const unsubscribe = subscribeFileLink((request) => seen.push(request));
    unsubscribe();
    openFileRequest({ path: 'src/a.ts' });
    expect(seen).toHaveLength(0);
  });
});

describe('a cited line resolves to the exact text a preview can select', () => {
  const content = 'first line\nsecond line\nthird line';

  it('finds the start of every line', () => {
    expect(lineStartOffset(content, 1)).toBe(0);
    expect(lineStartOffset(content, 2)).toBe(11);
    expect(lineStartOffset(content, 3)).toBe(23);
  });

  it('includes the newline in the selected range so an empty line still lights up', () => {
    expect(lineEndOffset(content, 1)).toBe(11);
    expect(lineEndOffset('a\n\nb', 2)).toBe(3);
  });

  it('handles a trailing newline as a real last line', () => {
    expect(lineStartOffset('a\nb\n', 3)).toBe(4);
    expect(lineEndOffset('a\nb\n', 3)).toBe(4);
  });

  it('refuses lines the file does not have and nonsensical input', () => {
    expect(lineStartOffset(content, 4)).toBe(-1);
    expect(lineStartOffset(content, 0)).toBe(-1);
    expect(lineStartOffset(content, 1.5)).toBe(-1);
    expect(lineEndOffset(content, 99)).toBe(-1);
    expect(lineStartOffset('', 1)).toBe(0);
  });
});
