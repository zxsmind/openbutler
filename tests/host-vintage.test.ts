import { describe, expect, it } from 'vitest';
import { hostVintage, hostVintageMismatchWarning } from '../src/daemon.js';

describe('host vintage', () => {
  it('classifies a host entry as source, dist, or unknown', () => {
    expect(hostVintage('C:\\repo\\src\\cli.ts')).toBe('source');
    expect(hostVintage('/home/me/app/src/cli.tsx')).toBe('source');
    expect(hostVintage('C:\\app\\dist\\cli.js')).toBe('dist');
    expect(hostVintage('/opt/openbutler/dist/cli.js')).toBe('dist');
    expect(hostVintage(undefined)).toBe('unknown');
    expect(hostVintage('')).toBe('unknown');
  });

  it('names a vintage skew once and stays quiet when both sides match', () => {
    const warning = hostVintageMismatchWarning('/repo/src/cli.ts', '/app/dist/cli.js');
    expect(warning).toContain('Code vintage mismatch');
    expect(warning).toContain('source (tsx)');
    expect(warning).toContain('built bundle');
    expect(warning).toContain('openbutler restart');
    expect(hostVintageMismatchWarning('/app/dist/cli.js', '/app/dist/cli.js')).toBeNull();
    expect(hostVintageMismatchWarning('/repo/src/cli.ts', undefined)).toBeNull();
    expect(hostVintageMismatchWarning('/repo/src/cli.ts', null)).toBeNull();
  });
});
