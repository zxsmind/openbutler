// Ranite helper; see LICENSE.txt and NOTICE.txt in this package.
import process from 'node:process';
import console from 'node:console';
import { basename, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const [destination, flag, description, ...extra] = process.argv.slice(2);
if (!destination || flag !== '--description' || !description?.trim() || extra.length) {
  console.error('Usage: node init-skill.mjs <new-directory> --description "Capability and contexts"');
  process.exit(2);
}
const target = resolve(destination);
const name = basename(target);
if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || description.trim().length > 1024) {
  console.error('Invalid skill name or description length.');
  process.exit(1);
}
try {
  // Nonrecursive creation is exclusive: a preexisting directory is never rewritten.
  mkdirSync(target);
  writeFileSync(
    resolve(target, 'SKILL.md'),
    [
      '---',
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description.trim())}`,
      '---',
      '',
      `# ${name
        .split('-')
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(' ')}`,
      '',
      '<!-- skill-scaffold: replace this marker and draft with the actual workflow -->',
      '',
      'Describe the capability, required inputs, available interfaces, meaningful result checks and failure handling.',
      '',
    ].join('\n'),
    { encoding: 'utf8', flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      status: 'created_draft',
      name,
      directory: target,
      next: 'Complete the draft, validate it and inspect Ranite discovery.',
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', directory: target, error: error.message }));
  process.exitCode = 1;
}
