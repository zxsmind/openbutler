// Ranite helper; see LICENSE.txt and NOTICE.txt in this package.
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';

let load;
try {
  ({ load } = await import('js-yaml'));
} catch {
  console.error(
    JSON.stringify({ status: 'blocked', error: 'js-yaml is unavailable; use the bundled Ranite helper or an available YAML parser.' }),
  );
  process.exit(2);
}

function outsideFences(text) {
  let fence = null;
  return (
    text
      .split(/\r?\n/)
      .map((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (marker) {
          if (!fence) fence = marker[1];
          else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
          return '';
        }
        return fence ? '' : line;
      })
      .join('\n') + (fence ? '\n__UNBALANCED_FENCE__' : '')
  );
}

const inside = (root, target) => {
  const part = relative(root, target);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};

function validate(directory) {
  const root = resolve(directory);
  const errors = [];
  const warnings = [];
  const files = [];
  let name = null;
  let links = 0;
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Skill root must be a real directory.');
    const canonical = realpathSync(root);
    function scan(path) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error(`Symlink/junction is not a package resource: ${relative(root, file)}`);
        if (stat.isDirectory()) scan(file);
        else if (stat.isFile()) files.push(file);
        else throw new Error(`Unsupported special file: ${relative(root, file)}`);
      }
    }
    scan(root);
    const text = readFileSync(join(root, 'SKILL.md'), 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!header) throw new Error('Missing or unterminated YAML frontmatter.');
    if (Buffer.byteLength(header[0], 'utf8') > 8192) errors.push('Frontmatter exceeds the Ranite discovery prefix.');
    let metadata;
    try {
      metadata = load(header[1]);
    } catch (error) {
      throw new Error(`Invalid YAML: ${error.reason ?? 'parse error'}`);
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Frontmatter must be a mapping.');
    name = typeof metadata.name === 'string' ? metadata.name : null;
    if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push('Invalid skill name.');
    if (name !== basename(root)) errors.push('Folder name and YAML name do not match.');
    if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.trim().length > 1024)
      errors.push('Description must contain 1-1024 characters.');
    if (!text.slice(header[0].length).trim()) errors.push('Skill body is empty.');
    if (text.includes('<!-- skill-scaffold:')) errors.push('Unfinished scaffold marker remains.');
    for (const file of files.filter((file) => file.endsWith('.md'))) {
      const visible = outsideFences(readFileSync(file, 'utf8'));
      if (visible.includes('__UNBALANCED_FENCE__')) errors.push(`Unbalanced code fence: ${relative(root, file)}`);
      for (const match of visible.matchAll(/\]\(([^)\n]+)\)/g)) {
        let target = match[1].trim();
        if (target.startsWith('<')) target = target.slice(1, target.indexOf('>'));
        else target = target.split(/\s+["']/)[0];
        if (/^(?:https?:|mailto:|data:|#)/i.test(target)) continue;
        target = decodeURIComponent(target.split('#')[0]);
        if (!target) continue;
        if (isAbsolute(target) || /^[a-zA-Z]:/.test(target) || /^file:/i.test(target))
          throw new Error('Absolute/external local resource reference.');
        const resource = resolve(dirname(file), target);
        if (!inside(root, resource) || !inside(canonical, realpathSync(resource)))
          throw new Error('Missing or escaping package reference.');
        links++;
      }
    }
    if (files.some((file) => /(?:^|[/\\])(?:node_modules|\.git)(?:[/\\]|$)/.test(relative(root, file))))
      warnings.push('Package includes a repository/cache directory; inspect whether it belongs in distribution.');
  } catch (error) {
    errors.push(error.code === 'ENOENT' ? 'Required directory, entrypoint or referenced resource is missing.' : error.message);
  }
  return { status: errors.length ? 'failed' : 'passed', name, directory: root, files: files.length, links, errors, warnings };
}

if (process.argv.length !== 3) {
  console.error('Usage: node validate-skill.mjs <skill-directory>');
  process.exitCode = 2;
} else {
  const result = validate(process.argv[2]);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
