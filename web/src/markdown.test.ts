import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeLatexMath } from './latex-math.js';
import { Markdown } from './markdown.js';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('shared Markdown renderer', () => {
  it('renders the heading hierarchy, nested emphasis, escapes and HTML entities', () => {
    const html = render(
      '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n**bold** *italic* ***both*** ~~removed~~ &copy; \\*literal\\*',
    );
    for (let depth = 1; depth <= 6; depth++) expect(html).toContain(`<h${depth}>`);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<em><strong>both</strong></em>');
    expect(html).toContain('<del>removed</del>');
    expect(html).toContain('\u00a9 *literal*');
  });

  it('preserves GFM alignment, nested lists, ordered starts and task state', () => {
    const html = render(
      '| Left | Center | Right |\n| :--- | :---: | ---: |\n| **A** | B | `3` |\n\n3. Third\n4. Fourth\n   - Nested\n\n- [x] Done\n- [ ] Pending',
    );
    expect(html).toContain('text-align:left');
    expect(html).toContain('text-align:center');
    expect(html).toContain('text-align:right');
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('contains-task-list');
    expect(html).toContain('checked=""');
    expect(html).toContain('Nested');
  });

  it('renders math as KaTeX while keeping code and escaped currency literal', () => {
    const html = render(
      'Inline $E = mc^2$ and $a^2+b^2=c^2$.\n\n$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$\n\n`$literal$` costs \\$5 and \\$10.',
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).toContain('<math');
    expect(html).toContain('<code>$literal$</code>');
    expect(html).toContain('costs $5 and $10');
  });

  it('highlights fenced code, names its language and keeps source characters escaped', () => {
    const html = render('```typescript\nconst answer: number = 42;\nconsole.log("<script>");\n```');
    expect(html).toContain('TypeScript');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-number');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('aria-label="Expand code"');
  });

  it('leaves unsupported languages readable and incomplete Mermaid fences in source mode', () => {
    expect(render('```unlisted-language\nhello <world>\n```')).toContain('hello &lt;world&gt;');
    const partial = render('```mermaid\nflowchart TD\n A -->');
    expect(partial).toContain('flowchart TD');
    expect(partial).not.toContain('Rendering diagram');
  });

  it('supports safe inline HTML and images without allowing active HTML or unsafe links', () => {
    const html = render(
      '<u>underline</u> <sub>2</sub> <sup>3</sup> <mark>marked</mark>\n\n<script>alert(1)</script>\n\n<img src="https://example.com/image.png" onerror="alert(2)">\n\n[bad](javascript:alert(3))',
    );
    expect(html).toContain('<u>underline</u>');
    expect(html).toContain('<sub>2</sub>');
    expect(html).toContain('<sup>3</sup>');
    expect(html).toContain('<mark>marked</mark>');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
  });

  it('keeps footnote references and backlinks connected to their targets', () => {
    const html = render('A note[^one].\n\n[^one]: The explanation.');
    expect(html).toContain('footnotes');
    const references = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(1);
    for (const id of references) expect(html).toContain(`id="${id}"`);
  });

  it('keeps matching footnote names in separate messages independent', () => {
    const text = 'A note[^one].\n\n[^one]: The explanation.';
    const html = renderToStaticMarkup(createElement(Fragment, null, createElement(Markdown, { text }), createElement(Markdown, { text })));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders the LaTeX delimiters models emit once state normalized them', () => {
    const html = render(normalizeLatexMath('Çözüm: \\(x^2 - 4 = 0\\) ve \\(y = mx + c\\).\n\n\\[E = mc^2\\]'));
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('\\(x^2');
    expect(html).not.toContain('\\[E =');
  });

  it('keeps LaTeX delimiters literal inside code through normalization', () => {
    const html = render(normalizeLatexMath('Inline `\\(x\\)` stays code.\n\n```tex\n\\[x\\]\n```'));
    expect(html).toContain('<code>\\(x\\)</code>');
    expect(html).toContain('\\[x\\]');
    expect(html).not.toContain('class="katex"');
  });
});
