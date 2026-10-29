import { describe, expect, it } from 'vitest';
import { displayFilePath, formatFileLink, normalizeFilePath, parseHref } from '../src/web/link-protocol.js';

const ROOT = 'C:\\Users\\dev\\repo';

describe('the link contract classifies every href a surface can receive', () => {
  it('reads the canonical file citation with its single-line anchor', () => {
    expect(parseHref('src/agent-instructions.ts#L79')).toEqual({
      kind: 'file',
      path: 'src/agent-instructions.ts',
      line: 79,
    });
  });

  it('reads a file citation without an anchor as a plain file', () => {
    expect(parseHref('src/web/files.ts')).toEqual({ kind: 'file', path: 'src/web/files.ts' });
  });

  it('keeps external sources as urls and rejects every other scheme', () => {
    expect(parseHref('https://example.com/a?b=1')).toEqual({ kind: 'url', href: 'https://example.com/a?b=1' });
    expect(parseHref('http://example.com')).toEqual({ kind: 'url', href: 'http://example.com' });
    expect(parseHref('javascript:alert(1)')).toBeNull();
    expect(parseHref('file:///etc/passwd')).toBeNull();
    expect(parseHref('mailto:someone@example.com')).toBeNull();
  });

  it('keeps same-message anchors', () => {
    expect(parseHref('#heading')).toEqual({ kind: 'anchor', id: 'heading' });
    expect(parseHref('#')).toBeNull();
  });

  it('refuses line ranges because a citation points at one line', () => {
    expect(parseHref('src/a.ts#L10-L20')).toBeNull();
    expect(parseHref('src/a.ts#L0')).toBeNull();
    expect(parseHref('src/a.ts#L007')).toBeNull();
    expect(parseHref('src/a.ts#section')).toBeNull();
  });
});

describe('the link contract normalises paths the way the files API demands', () => {
  it('cleans relative forms', () => {
    expect(normalizeFilePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeFilePath('src//a.ts')).toBe('src/a.ts');
    expect(normalizeFilePath('src\\a.ts')).toBe('src/a.ts');
    expect(normalizeFilePath('src/a%20b.ts')).toBe('src/a b.ts');
  });

  it('refuses to escape the workspace', () => {
    expect(normalizeFilePath('../secrets.env')).toBeNull();
    expect(normalizeFilePath('src/../../secrets.env')).toBeNull();
    expect(normalizeFilePath('')).toBeNull();
    expect(normalizeFilePath('a\0b')).toBeNull();
    expect(normalizeFilePath('%E0%A4%A')).toBeNull();
  });

  it('keeps an absolute path citable when no workspace root is in play', () => {
    expect(normalizeFilePath('/etc/passwd')).toBe('/etc/passwd');
    expect(normalizeFilePath('C:/Windows/System32')).toBe('C:/Windows/System32');
    expect(normalizeFilePath('C:/a/../b')).toBeNull();
    expect(normalizeFilePath('C:/')).toBeNull();
    expect(normalizeFilePath('C:\\Users\\dev\\notes.txt')).toBe('C:/Users/dev/notes.txt');
  });

  it('turns an absolute path inside the workspace into the canonical relative form', () => {
    expect(normalizeFilePath('C:/Users/dev/repo/src/a.ts', ROOT)).toBe('src/a.ts');
    expect(normalizeFilePath('/C:/Users/dev/repo/src/a.ts', ROOT)).toBe('src/a.ts');
    expect(normalizeFilePath('c:\\users\\DEV\\repo\\src\\a.ts', ROOT)).toBe('src/a.ts');
    expect(normalizeFilePath('C:/Users/other/repo/src/a.ts', ROOT)).toBe('C:/Users/other/repo/src/a.ts');
    expect(normalizeFilePath('C:/Users/dev/repo-other/src/a.ts', ROOT)).toBe('C:/Users/dev/repo-other/src/a.ts');
    expect(normalizeFilePath('C:/Users/dev/repo', ROOT)).toBeNull();
  });
});

describe('the link contract formats what it parses', () => {
  it('round-trips a citation', () => {
    expect(formatFileLink('src/a.ts', 79)).toBe('src/a.ts#L79');
    expect(parseHref(formatFileLink('src/a.ts', 79))).toEqual({ kind: 'file', path: 'src/a.ts', line: 79 });
    expect(formatFileLink('src/a.ts')).toBe('src/a.ts');
    expect(formatFileLink('/srv/data/cited.ts', 9)).toBe('/srv/data/cited.ts#L9');
    expect(parseHref('C:/dev/a.ts#L3')).toEqual({ kind: 'file', path: 'C:/dev/a.ts', line: 3 });
  });

  it('rejects authoring outside the workspace or with a bad line', () => {
    expect(() => formatFileLink('../a.ts')).toThrow();
    expect(() => formatFileLink('src/a.ts', 0)).toThrow();
    expect(() => formatFileLink('src/a.ts', 1.5)).toThrow();
  });

  it('shows a file the way surfaces that cannot open it print it', () => {
    expect(displayFilePath({ path: 'src/a.ts', line: 79 })).toBe('src/a.ts:79');
    expect(displayFilePath({ path: 'src/a.ts' })).toBe('src/a.ts');
  });
});
