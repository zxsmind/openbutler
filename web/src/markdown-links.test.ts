import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown.js';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('markdown links keep their label and their citation shape', () => {
  it('renders an external link with its label and a new tab', () => {
    const out = html('See [the docs](https://example.com/x) for details.');
    expect(out).toContain('<a');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('>the docs</a>');
    expect(out).toContain('target="_blank"');
  });

  it('renders an absolute Windows citation as a file link with its label and line', () => {
    const out = html('Target: [files.ts](C:/Users/dev/repo/src/files.ts#L79)');
    // The drive letter is rendered as a path (leading slash) so neither URL
    // layer reads it as a protocol; the contract strips that slash back.
    expect(out).toContain('href="/C:/Users/dev/repo/src/files.ts#L79"');
    expect(out).toContain('data-file-path="C:/Users/dev/repo/src/files.ts"');
    expect(out).toContain('data-file-line="79"');
    expect(out).toContain('files.ts');
    expect(out).toContain(':79');
  });

  it('renders a workspace citation with the shared file badge', () => {
    const out = html('[link-demo.md](link-demo.md#L50)');
    expect(out).toContain('href="link-demo.md#L50"');
    expect(out).toContain('data-file-path="link-demo.md"');
    // Server-side render runs before the theme SVG resolves, so the shared
    // component falls back to the generic glyph; the icon itself is asserted
    // in the browser, its shape here.
    expect(out).toMatch(/file-icon|lucide-file/);
    expect(out).toContain(':50');
  });
});
