import { describe, expect, it } from 'vitest';
import { fileIconKey } from './file-icon.js';

describe('the shared file icon resolves the way the theme does', () => {
  it('prefers an exact file-name association', () => {
    expect(fileIconKey('justfile')).toBe('just');
    expect(fileIconKey('.gitignore')).toBe('git');
  });

  it('falls back to the extension', () => {
    expect(fileIconKey('link-demo.md')).toBe('markdown');
    expect(fileIconKey('a.ts')).toBe('typescript');
    expect(fileIconKey('data.json')).toBe('json');
    expect(fileIconKey('img.png')).toBe('image');
  });

  it('uses the generic glyph for anything the theme does not know', () => {
    expect(fileIconKey('weird.zzz')).toBe('file');
    expect(fileIconKey('Makefile')).toBe('file');
  });

  it('reads the name after whatever path the caller passes', () => {
    expect(fileIconKey('src/deep/link-demo.md')).toBe('markdown');
    expect(fileIconKey('C:/Users/dev/notes.txt')).toBe('document');
  });
});
