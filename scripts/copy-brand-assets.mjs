import { copyFileSync, mkdirSync } from 'node:fs';
import { URL } from 'node:url';

const source = new URL('../src/assets/branding/ranite.svg', import.meta.url);
const targetDir = new URL('../dist/assets/branding/', import.meta.url);
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, new URL('ranite.svg', targetDir));
