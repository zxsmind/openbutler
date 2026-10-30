import { describe, expect, it } from 'vitest';
import { webSpawnArgs } from '../src/daemon.js';

describe('web process spawn args', () => {
  it('runs a built bundle from its own entry with the recorded binding', () => {
    expect(webSpawnArgs('C:\\app\\dist\\cli.js', 46000, '127.0.0.1')).toEqual([
      'C:\\app\\dist\\cli.js',
      'web',
      '--serve',
      '--port',
      '46000',
      '--hostname',
      '127.0.0.1',
    ]);
    expect(webSpawnArgs('/opt/openbutler/dist/cli.js', 46000, '0.0.0.0')).toEqual([
      '/opt/openbutler/dist/cli.js',
      'web',
      '--serve',
      '--port',
      '46000',
      '--hostname',
      '0.0.0.0',
    ]);
  });

  it('runs a source entry through tsx so the child matches this CLI vintage', () => {
    const args = webSpawnArgs('/repo/src/cli.ts', 46001, '127.0.0.1');
    expect(args.slice(0, 2)).toEqual(['--import', expect.any(String)]);
    expect(args[1]).toContain('tsx');
    expect(args.slice(2)).toEqual(['/repo/src/cli.ts', 'web', '--serve', '--port', '46001', '--hostname', '127.0.0.1']);
  });
});
