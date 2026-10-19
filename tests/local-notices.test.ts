import { describe, expect, it } from 'vitest';
import { LocalNoticeList, LOCAL_NOTICE_TTL_MS } from '../src/local-notices.js';
import type { SessionEntry } from '../src/session-store.js';

const entry = (text: string): SessionEntry => ({ kind: 'notice', text });
const texts = (entries: SessionEntry[]) => entries.map((item) => (item.kind === 'notice' ? item.text : item.kind));

describe('LocalNoticeList', () => {
  it('puts a notice where it arrived instead of pinning it to the end', () => {
    const notices = new LocalNoticeList();
    const server = [entry('a'), entry('b')];
    // The notice arrives when two server entries exist.
    notices.add(entry('notice'), server.length);
    const stillTwo = notices.merge(server);
    expect(texts(stillTwo)).toEqual(['a', 'b', 'notice']);

    // Two more server entries land afterwards; the notice keeps its place and
    // the new messages appear below it.
    const grown = [...server, entry('c'), entry('d')];
    expect(texts(notices.merge(grown))).toEqual(['a', 'b', 'notice', 'c', 'd']);
  });

  it('keeps the arrival order of notices sharing one anchor', () => {
    const notices = new LocalNoticeList();
    const server = [entry('a')];
    notices.add(entry('first'), 1);
    notices.add(entry('second'), 1);
    expect(texts(notices.merge(server))).toEqual(['a', 'first', 'second']);
  });

  it('clamps an anchor past the end when the server list shrinks', () => {
    const notices = new LocalNoticeList();
    notices.add(entry('notice'), 9);
    expect(texts(notices.merge([entry('a')]))).toEqual(['a', 'notice']);
  });

  it('drops a notice once its time is up', () => {
    const notices = new LocalNoticeList();
    const now = 1_000_000;
    notices.add(entry('notice'), 0, now);
    expect(texts(notices.merge([entry('a')], now + LOCAL_NOTICE_TTL_MS - 1))).toEqual(['notice', 'a']);
    expect(notices.merge([entry('a')], now + LOCAL_NOTICE_TTL_MS)).toEqual([entry('a')]);
    expect(notices.length).toBe(0);
  });

  it('reports a prune only when something expired', () => {
    const notices = new LocalNoticeList();
    notices.add(entry('notice'), 0, 0);
    expect(notices.prune(LOCAL_NOTICE_TTL_MS - 1)).toBe(false);
    expect(notices.prune(LOCAL_NOTICE_TTL_MS)).toBe(true);
  });

  it('keeps the newest notices when the cap is reached', () => {
    const notices = new LocalNoticeList(3, LOCAL_NOTICE_TTL_MS);
    for (const text of ['one', 'two', 'three', 'four']) notices.add(entry(text), 0);
    expect(texts(notices.merge([]))).toEqual(['two', 'three', 'four']);
  });

  it('identifies its own entries so a merged view can be split back into server entries', () => {
    const notices = new LocalNoticeList();
    const own = entry('notice');
    notices.add(own, 1);
    const merged = notices.merge([entry('a'), entry('b')]);
    const ownSet = notices.ownEntries();
    expect(merged.filter((item) => !ownSet.has(item))).toEqual([entry('a'), entry('b')]);
  });

  it('cannot resolve a server index once merged, so the host index is read before merging', () => {
    // The host addresses entries by their server index. A notice merged in
    // front of them shifts that index, so the client must resolve the entry
    // against the server list and only then merge notices in.
    const notices = new LocalNoticeList();
    const server: SessionEntry[] = [entry('a'), entry('b')];
    const streaming: SessionEntry = { kind: 'assistant', text: 'streaming' };
    const patched = [...server, streaming];
    const streamingIndex = 2;
    notices.add(entry('notice'), 2);
    const merged = notices.merge(patched);
    // Resolved before the merge: the streaming entry, as the client does it.
    expect(patched[streamingIndex]).toBe(streaming);
    // Resolved after the merge: the notice, which would mislabel the run.
    expect(merged[streamingIndex]).toEqual(entry('notice'));
    expect(merged).toContainEqual(streaming);
  });
});
