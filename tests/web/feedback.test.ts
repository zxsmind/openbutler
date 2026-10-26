import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Feedback, type FeedbackTone } from '../../web/src/components/feedback.js';

const web = createRequire(new URL('../../web/package.json', import.meta.url));
const { createElement } = web('react') as typeof import('react');
const { renderToStaticMarkup } = web('react-dom/server') as { renderToStaticMarkup(element: unknown): string };

function surfaces(css: string): string[] {
  const violations: string[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.(?:feedback(?:[\s.:#[>+~]|__|--|$)|panel-feedback\b|files-tree-empty\b)/.test(rule[1]!)) continue;
    for (const declaration of rule[2]!.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = declaration
        .slice(colon + 1)
        .trim()
        .replace(/\s*!important$/, '');
      if (
        /^(?:border(?:-[a-z-]+)?|box-shadow|background(?:-color|-image)?|filter)$/.test(property) &&
        !['0', 'none', 'transparent'].includes(value)
      )
        violations.push(`${rule[1]!.trim()}: ${property}: ${value}`);
    }
  }
  return violations;
}

it('keeps every feedback tone and layout text-only, with no decorative status icons or button boxes', () => {
  const tones: FeedbackTone[] = ['neutral', 'info', 'success', 'warning', 'error', 'loading'];
  for (const tone of tones)
    for (const layout of ['inline', 'compact', 'state'] as const) {
      const html = renderToStaticMarkup(
        createElement(Feedback, { tone, layout, children: 'Plain message', action: { label: 'Try again', onClick() {} }, onDismiss() {} }),
      );
      expect(html).toContain('Plain message');
      expect(html).toContain('Try again');
      expect(html).toContain(`role="${tone === 'error' ? 'alert' : 'status'}"`);
      expect(html).not.toMatch(/feedback__symbol|<svg|<img|<canvas|class="[^"]*\bbutton\b|style="[^"]*(?:border|background|box-shadow)/);
    }
});

it('forbids card surfaces in feedback and empty search messages across all web stylesheets', () => {
  const root = fileURLToPath(new URL('../../web/src/', import.meta.url));
  const errors = readdirSync(root, { recursive: true })
    .filter((file): file is string => typeof file === 'string' && file.endsWith('.css'))
    .flatMap((file) => surfaces(readFileSync(join(root, file), 'utf8')).map((error) => `${file}: ${error}`));
  expect(errors).toEqual([]);
  // The guard must reject a future reintroduction of the old boxed design.
  expect(
    surfaces('.feedback { background: #fff; border: 1px solid #ddd; border-radius: 12px; box-shadow: 0 2px 8px #0002; }'),
  ).toHaveLength(4);
});
