import { Marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown } from '../src/cli/terminal-session.js';

/**
 * The terminal renders the same citation contract as the web: a file link keeps
 * its label and shows the path beside it (dimmed in the real terminal), while
 * an external link keeps its label. Losing either would make the CLI unreadable
 * for the same reason the web once showed empty anchors.
 *
 * The renderer returns React elements, which are plain objects: walking their
 * children gives the terminal text without pulling a renderer dependency in.
 */

const text = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'object' && 'props' in node) return text((node as { props: { children?: unknown } }).props.children);
  return '';
};

const render = (value: string) => text(renderInlineMarkdown(new Marked().lexer(value), false, 't'));

describe('terminal inline rendering of links', () => {
  it('keeps a file citation label and prints its path with the line', () => {
    const out = render('See [files.ts](C:/Users/dev/repo/src/files.ts#L79) for the policy.');
    expect(out).toContain('files.ts');
    expect(out).toContain('for the policy.');
    expect(out).toContain('C:/Users/dev/repo/src/files.ts:79');
  });

  it('keeps a workspace citation label with its path', () => {
    const out = render('[link-demo.md](link-demo.md#L50)');
    expect(out).toContain('link-demo.md');
    expect(out).toContain('link-demo.md:50');
  });

  it('keeps an external link label', () => {
    const out = render('Source: [the docs](https://example.com/x).');
    expect(out).toContain('the docs');
    expect(out).toContain('Source:');
  });
});
