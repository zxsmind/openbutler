import { describe, expect, it } from 'vitest';
import { inspectTextIntegrity } from '../src/text-integrity.js';

const clean = 'export function a() {\n  return 1;\n}\n';

describe('inspectTextIntegrity', () => {
  it('says nothing about a clean edit', () => {
    const report = inspectTextIntegrity({ before: clean, after: clean.replace('return 1', 'return 2'), path: 'a.ts' });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('refuses a BOM the file did not have', () => {
    const report = inspectTextIntegrity({ before: clean, after: `\uFEFF${clean}`, path: 'a.ts' });
    expect(report.errors.join(' ')).toContain('UTF-8 BOM');
  });

  it('accepts a file that already carried a BOM', () => {
    const withBom = `\uFEFF${clean}`;
    const report = inspectTextIntegrity({ before: withBom, after: `${withBom}// tail\n`, path: 'a.ts' });
    expect(report.errors).toEqual([]);
  });

  it('refuses doubled-encoded characters introduced by the write', () => {
    // The signature of a UTF-8 file rewritten by a tool that read it as ANSI.
    const report = inspectTextIntegrity({ before: clean, after: `${clean}// \u00C3\u00A2\u20AC\u0161\n`, path: 'a.ts' });
    expect(report.errors.join(' ')).toContain('doubled-encoded');
  });

  it('does not complain about pre-existing doubled encoding', () => {
    const already = `${clean}// \u00C3\u00A2\u20AC\u0161\n`;
    const report = inspectTextIntegrity({ before: already, after: `${already}// more\n`, path: 'a.ts' });
    expect(report.errors).toEqual([]);
  });

  it('refuses an edit that leaves the file unbalanced', () => {
    const report = inspectTextIntegrity({
      before: clean,
      after: 'export function a() {\n  return 1;\n',
      path: 'a.ts',
    });
    expect(report.errors.join(' ')).toContain('unclosed brace');
  });

  it('does not complain when the file was already unbalanced', () => {
    const broken = 'export function a() {\n  return 1;\n';
    const report = inspectTextIntegrity({ before: broken, after: `${broken}\n// note\n`, path: 'a.ts' });
    expect(report.errors).toEqual([]);
  });

  it('warns when a declaration disappeared while its name is still used', () => {
    const before = 'const streamedEntry: Entry | null = null;\nfunction use() {\n  return streamedEntry;\n}\n';
    const after = 'function use() {\n  return streamedEntry;\n}\n';
    const report = inspectTextIntegrity({ before, after, path: 'a.ts' });
    expect(report.warnings.join(' ')).toContain('streamedEntry');
    expect(report.errors).toEqual([]);
  });

  it('warns when an import disappeared while its name is still used', () => {
    const before = "import { classifyFilePath } from './x.js';\nconst v = classifyFilePath('a');\n";
    const after = "const v = classifyFilePath('a');\n";
    const report = inspectTextIntegrity({ before, after, path: 'a.ts' });
    expect(report.warnings.join(' ')).toContain('classifyFilePath');
  });

  it('warns about a declaration that is now duplicated', () => {
    const before = 'function pick() {\n  return 1;\n}\n';
    const after = 'function pick() {\n  return 1;\n}\nfunction pick() {\n  return 2;\n}\n';
    const report = inspectTextIntegrity({ before, after, path: 'a.ts' });
    expect(report.warnings.join(' ')).toContain('pick');
  });

  it('warns about a line that now repeats immediately', () => {
    const before = 'const a = 1;\nconst b = 2;\n';
    const after = 'const a = 1;\nconst a = 1;\nconst b = 2;\n';
    const report = inspectTextIntegrity({ before, after, path: 'a.ts' });
    expect(report.warnings.join(' ')).toContain('repeats immediately');
  });

  it('does not warn about a duplicate that was already there', () => {
    const duplicated = 'const a = 1;\nconst a = 1;\n';
    const report = inspectTextIntegrity({ before: duplicated, after: `${duplicated}const b = 2;\n`, path: 'a.ts' });
    expect(report.warnings).toEqual([]);
  });

  it('checks a brand new file against itself', () => {
    const report = inspectTextIntegrity({ before: null, after: 'function f() {\n  return 1;\n}\n', path: 'new.ts' });
    expect(report.errors).toEqual([]);
    const doubled = inspectTextIntegrity({
      before: null,
      after: 'function f() {\n  return 1;\n}\nfunction f() {\n  return 2;\n}\n',
      path: 'new.ts',
    });
    expect(doubled.warnings.join(' ')).toContain('f');
  });
});
