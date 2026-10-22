import { describe, expect, it } from 'vitest';
import { isShellTool } from '../../web/src/turns.js';

describe('tool output identity', () => {
  it('recognizes the provider:name identity sent by the host', () => {
    expect(isShellTool({ kind: 'tool', tool: 'builtin:execute_command', command: 'cd C:/workspace; node check.js' })).toBe(true);
    expect(isShellTool({ kind: 'tool', tool: 'builtin:file_read', command: 'Read C:/workspace/source.ts' })).toBe(false);
  });
  it('recognizes shell commands in older entries without an identity', () => {
    expect(isShellTool({ kind: 'tool', command: 'cd C:/workspace; git status' })).toBe(true);
  });
});
