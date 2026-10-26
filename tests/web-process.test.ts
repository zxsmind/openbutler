import { describe, expect, it } from 'vitest';
import { webSpawnArgs } from '../src/daemon.js';

describe('web process spawn args', () => {
  it('runs a built bundle from its own entry', () => {
    expect(webSpawnArgs('C:\\app\\dist\\cli.js', 46000)).toEqual(['C:\\app\\dist\\cli.js', 'web', '--port', '46000']);
    expect(webSpawnArgs('/opt/ranite/dist/cli.js', 46000)).toEqual(['/opt/ranite/dist/cli.js', 'web', '--port', '46000']);
  });

  it('runs a source entry through tsx so the child matches this CLI vintage', () => {
    const args = webSpawnArgs('/repo/src/cli.ts', 46001);
    expect(args.slice(0, 2)).toEqual(['--import', expect.any(String)]);
    expect(args[1]).toContain('tsx');
    expect(args.slice(2)).toEqual(['/repo/src/cli.ts', 'web', '--port', '46001']);
  });
});
