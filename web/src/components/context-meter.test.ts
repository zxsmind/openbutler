import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { ContextMeter } from './context-meter.js';

const { renderToStaticMarkup } = await vi.importActual<{ renderToStaticMarkup(element: unknown): string }>('react-dom/server');
const render = (tokens?: number | null, limit?: number | null) =>
  renderToStaticMarkup(
    createElement(ContextMeter, {
      ...(tokens === undefined ? {} : { tokens }),
      ...(limit === undefined ? {} : { limit }),
    }),
  );

it('hides the meter when there is no usage to display', () => {
  expect(render(undefined, 1048576)).toBe('');
  expect(render(null, null)).toBe('');
  expect(render(NaN, 1048576)).toBe('');
});

it('shows only the compact token count when capacity is unknown', () => {
  for (const capacity of [undefined, null, 0, NaN]) {
    const html = render(83500, capacity);
    expect(html).toContain('83,5k');
    expect(html).not.toMatch(/%|left|context-meter__ring|Waiting|Context window|\/ —/);
  }
  expect(render(0, null)).toContain('0 tokens');
  expect(render(1500000, null)).toContain('1,5m');
});

it('retains percentage usage when the model publishes its capacity', () => {
  const html = render(6000, 100000);
  expect(html).toContain('6% used (94% left)');
  expect(html).toContain('context-meter__ring');
});
