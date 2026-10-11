import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Credential fixtures must stay split.
 *
 * The secret engine is tested against values shaped exactly like real provider keys. Those are
 * synthetic, but GitHub push protection cannot tell them apart and rejects the push, and a public
 * repository full of `AKIA…` strings reads as a leak even when it is not. So each fixture is
 * written as literals joined at runtime, which keeps the detected value byte-exact while leaving
 * no contiguous credential pattern in the source. Collapsing one back into a single literal would
 * break the next push, so this file pins the invariant instead of trusting a comment.
 *
 * Only prefix-anchored shapes are scanned. An unanchored "looks high entropy" rule would flag the
 * negative fixtures, which exist precisely to prove the engine leaves ordinary text alone.
 */

const PATTERNS: Array<[string, RegExp]> = [
  ['AWS access key id', /AKIA[0-9A-Z]{16}/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /sk-[A-Za-z0-9]{20,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['GitLab token', /glpat-[A-Za-z0-9_-]{16,}/],
  ['npm token', /npm_[A-Za-z0-9]{20,}/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
];

/** Private infrastructure that must not reach a public repository. The fingerprints are
 * assembled at runtime for the same reason the credential fixtures are split: a guard that
 * spells out what it forbids would carry the leak itself. */
const INFRA: Array<[string, RegExp]> = [
  ['private provider name', new RegExp('\\b' + 'sov' + 'infra' + '\\b')],
  ['private modal account', new RegExp('zxs' + '45016')],
  ['tunnel endpoint', new RegExp('ngrok' + '-free' + '\\.dev')],
  ['modal endpoint', /modal\.run/],
  ['tailscale address', new RegExp('100' + '\\.' + '83' + '\\.' + '36' + '\\.' + '115')],
];

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sources(full));
    else if (/\.(ts|tsx|mjs|js|json)$/.test(entry)) found.push(full);
  }
  return found;
}

const repository = join(import.meta.dirname, '..');
const tracked = [
  ...sources(join(repository, 'src')),
  ...sources(join(repository, 'tests')),
  ...sources(join(repository, 'scripts')),
  join(repository, 'README.md'),
  join(repository, 'package.json'),
];

function scan(patterns: Array<[string, RegExp]>): string[] {
  const offenders: string[] = [];
  for (const file of tracked) {
    const text = readFileSync(file, 'utf8');
    for (const [name, pattern] of patterns) {
      const match = text.match(pattern);
      if (match) offenders.push(`${relative(repository, file)} -> ${name}: ${match[0].slice(0, 10)}…`);
    }
  }
  return offenders;
}

describe('fixture hygiene', () => {
  it('ships no contiguous credential pattern in any tracked file', () => {
    expect(scan(PATTERNS)).toEqual([]);
  });

  it('names no private provider or endpoint', () => {
    expect(scan(INFRA)).toEqual([]);
  });

  it('reads enough files that passing cannot mean scanning nothing', () => {
    expect(tracked.length).toBeGreaterThan(100);
  });
});
