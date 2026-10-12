import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The public tree is English-only. These code points are unambiguous markers of
// the Turkish alphabet (soft g, s-cedilla, dotless/dotted capital I). They are
// built from numbers so this guard itself stays clean. Accented Latin letters
// shared with other languages (e.g. French/German) are allowed.
const TURKISH_CODE_POINTS = new RegExp(
  `[${[0x11e, 0x11f, 0x15e, 0x15f, 0x130, 0x131].map((code) => String.fromCodePoint(code)).join('')}]`,
  'u',
);
const TURKISH_WORDS = /\b(Turkish|Merhaba|merhaba)\b/;
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.md', '.json', '.yml', '.yaml', '.sh', '.ps1']);

function collectFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      collectFiles(path, files);
    } else if ([...SCAN_EXTENSIONS].some((extension) => entry.endsWith(extension))) {
      files.push(path);
    }
  }
}

describe('public tree language guard', () => {
  it('contains no Turkish alphabet characters or language markers', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const self = fileURLToPath(import.meta.url);
    const offenders: string[] = [];
    for (const directory of ['src', 'tests', 'scripts', 'skills'].map((name) => join(root, name))) {
      const files: string[] = [];
      collectFiles(directory, files);
      for (const file of files) {
        if (file === self) continue;
        const text = readFileSync(file, 'utf8');
        if (TURKISH_CODE_POINTS.test(text) || TURKISH_WORDS.test(text)) offenders.push(file);
      }
    }
    for (const file of ['README.md', 'package.json', 'install.sh', 'install.ps1']) {
      try {
        const text = readFileSync(join(root, file), 'utf8');
        if (TURKISH_CODE_POINTS.test(text) || TURKISH_WORDS.test(text)) offenders.push(join(root, file));
      } catch {
        // Release helpers are added with the installer phase; absent files are fine.
      }
    }
    expect(offenders).toEqual([]);
  });
});
