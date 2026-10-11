import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repository, 'skills');
const distDirectory = resolve(repository, 'dist');
const destination = resolve(distDirectory, 'builtin-skills');
mkdirSync(distDirectory, { recursive: true });
cpSync(source, destination, { recursive: true, force: true });
