// Ranite helper; see LICENSE.txt and NOTICE.txt in this package.
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

let load;
try {
  ({ load } = await import('js-yaml'));
} catch {
  console.error(
    JSON.stringify({
      status: 'blocked',
      error: 'js-yaml is unavailable; use the bundled Ranite helper or the documented inspected file-copy workflow.',
    }),
  );
  process.exit(2);
}
const args = process.argv.slice(2);
const values = {};
let apply = false;
let created = false;
let target;
const inside = (parent, child) => {
  const part = relative(parent, child);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function inspectParents(path) {
  let current = path;
  for (;;) {
    if (exists(current) && lstatSync(current).isSymbolicLink())
      throw new Error('Path has a symlink/junction ancestor; choose its explicit canonical path.');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function manifest(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Source/destination must be a real package directory.');
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      const details = lstatSync(file);
      if (details.isSymbolicLink()) throw new Error('Package contains a symlink/junction.');
      if (entry.name === '.git' || entry.name === 'node_modules')
        throw new Error('Stage the skill package without repository/dependency caches.');
      if (details.isDirectory()) walk(file);
      else if (details.isFile())
        files.push({
          path: relative(root, file).split(sep).join('/'),
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        });
      else throw new Error('Package contains an unsupported special file.');
    }
  }
  walk(root);
  return files;
}
try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply' && !apply) apply = true;
    else if (['--source', '--dest'].includes(arg) && !values[arg] && args[index + 1] && !args[index + 1].startsWith('--'))
      values[arg] = args[++index];
    else throw new Error('Usage: node install-local.mjs --source <reviewed-package> --dest <new-directory> [--apply]');
  }
  if (!values['--source'] || !values['--dest']) throw new Error('Explicit --source and --dest are required.');
  const source = resolve(values['--source']);
  target = resolve(values['--dest']);
  if (inside(source, target) || inside(target, source)) throw new Error('Source and destination must not overlap.');
  inspectParents(source);
  inspectParents(dirname(target));
  if (exists(target)) throw new Error('Destination already exists; no files were overwritten.');
  const files = manifest(source);
  const raw = readFileSync(join(source, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!frontmatter || Buffer.byteLength(frontmatter[0]) > 8192) throw new Error('Invalid or oversized discovery frontmatter.');
  let metadata;
  try {
    metadata = load(frontmatter[1]);
  } catch {
    throw new Error('Invalid YAML frontmatter.');
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    typeof metadata.name !== 'string' ||
    metadata.name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) ||
    metadata.name !== basename(source) ||
    metadata.name !== basename(target)
  )
    throw new Error('Valid matching source, destination and YAML skill names are required.');
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.trim().length > 1024)
    throw new Error('Description must contain 1-1024 characters.');
  const receipt = {
    status: 'preview',
    name: metadata.name,
    source: realpathSync(source),
    destination: target,
    files,
    discovery: 'unverified',
    behavior: 'unverified',
  };
  if (apply) {
    mkdirSync(dirname(target), { recursive: true });
    inspectParents(dirname(target));
    mkdirSync(target);
    created = true;
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true, dereference: false });
    if (JSON.stringify(manifest(target)) !== JSON.stringify(files) || JSON.stringify(manifest(source)) !== JSON.stringify(files))
      throw new Error('Source/copy changed or hashes differ; inspect the new partial destination.');
    receipt.status = 'copied';
  }
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(
    JSON.stringify({
      status: created ? 'failed_partial' : 'failed',
      error: error.message,
      ...(created ? { partialDirectory: target } : {}),
    }),
  );
  process.exitCode = 1;
}
