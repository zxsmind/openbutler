import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The whole tree is English-only, the browser client included. These code
// points are unambiguous markers of the Turkish alphabet (soft g, s-cedilla,
// dotless/dotted capital I); they are built from numbers so this guard itself
// stays clean. Letters shared with other languages (French, German, Spanish)
// are allowed, which is why the word list below carries the rest.
const TURKISH_CODE_POINTS = new RegExp(
  `[${[0x11e, 0x11f, 0x15e, 0x15f, 0x130, 0x131].map((code) => String.fromCodePoint(code)).join('')}]`,
  'u',
);
// Words that only Turkish uses. Endings vary, so each is a whole word: a prefix
// match would also catch English words that merely start the same way.
const TURKISH_WORDS =
  /\b(merhaba|selam|için|değil|çok|gibi|olarak|sonra|önce|şimdi|nasıl|neden|hangi|kadar|veya|yani|eğer|çünkü|tüm|yeni|eski|kapat|ekle|kaydet|göster|gönder|gizle|ayar|ayarlar|kullanıcı|sohbet|sohbetler|dosya|klasör|proje|projeler|hata|başarılı|bekleyin|seç|seçin|görev|işlem|oturum|bağlantı|yeniden|deneyin|bulunamadı|geçersiz|zorunlu|gerekli|tamam|evet|hayır|lütfen|teşekkür)\b/i;
const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
  '.css',
  '.html',
]);
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.vite', 'build']);

function collectFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
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
    for (const directory of ['src', 'tests', 'scripts', 'skills', 'web'].map((name) => join(root, name))) {
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
