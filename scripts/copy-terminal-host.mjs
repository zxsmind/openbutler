import { copyFileSync } from 'node:fs';
import { URL } from 'node:url';

// Keep the plain Node helper loader-free in both source runs and release archives.
copyFileSync(new URL('../src/web/terminal-host.mjs', import.meta.url), new URL('../dist/web/terminal-host.mjs', import.meta.url));
