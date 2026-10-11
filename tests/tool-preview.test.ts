import { describe, expect, it } from 'vitest';
import { ToolInputPreview } from '../src/tool-preview.js';

function feed(text: string, chunkSize: number): ToolInputPreview {
  const preview = new ToolInputPreview();
  for (let index = 0; index < text.length; index += chunkSize) preview.push(text.slice(index, index + chunkSize));
  return preview;
}

describe('ToolInputPreview', () => {
  it('collects complete top-level fields regardless of chunk boundaries', () => {
    const text = '{"path":"src/runtime.ts","command":"npm test"}';
    for (const size of [1, 2, 3, 5, 7, 11, 100]) {
      const preview = feed(text, size);
      expect(preview.fields.map((field) => [field.key, field.value])).toEqual([
        ['path', 'src/runtime.ts'],
        ['command', 'npm test'],
      ]);
    }
  });

  it('does not publish a field until its value is complete', () => {
    const preview = new ToolInputPreview();
    preview.push('{"path":"src/run');
    expect(preview.fields).toEqual([]);
    preview.push('time.ts"');
    expect(preview.fields.map((field) => field.value)).toEqual(['src/runtime.ts']);
  });

  it('handles whitespace, escapes and primitives', () => {
    const preview = feed('{ "count" : 42 , "enabled" : true , "name" : "a\\"b\\\\c" }', 1);
    expect(preview.fields).toEqual([
      { key: 'count', value: '42', truncated: false },
      { key: 'enabled', value: 'true', truncated: false },
      { key: 'name', value: 'a"b\\c', truncated: false },
    ]);
  });

  it('stops at nested values instead of guessing at them', () => {
    const preview = feed('{"path":"a.ts","options":{"deep":1},"after":"x"}', 1);
    expect(preview.fields.map((field) => field.key)).toEqual(['path']);
  });

  it('truncates long values and remembers that it did', () => {
    const preview = new ToolInputPreview();
    preview.push('{"content":"' + 'x'.repeat(500) + '","path":"kept.ts"}');
    const fields = preview.fields;
    expect(fields[0]?.truncated).toBe(true);
    expect(fields[0]?.value.length).toBe(200);
    expect(fields[1]).toEqual({ key: 'path', value: 'kept.ts', truncated: false });
  });

  it('caps how many fields it collects', () => {
    const entries = Array.from({ length: 30 }, (_, index) => `"k${index}":"v${index}"`).join(',');
    const preview = feed(`{${entries}}`, 4);
    expect(preview.fields.length).toBe(12);
  });

  it('ignores input that never starts an object', () => {
    const preview = feed('not json at all', 1);
    expect(preview.fields).toEqual([]);
  });
});
