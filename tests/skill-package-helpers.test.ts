import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { afterEach, beforeEach, expect, it } from 'vitest';

const creator = resolve('skills/skill-creator/scripts');
const installer = resolve('skills/skill-installer/scripts/install-local.mjs');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-skill-package-'));
});
afterEach(() => {
  if (resolve(dirname(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-skill-package-'))
    throw new Error('Unsafe fixture cleanup.');
  rmSync(root, { recursive: true, force: true });
});
function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout.trim(), error: result.stderr.trim() };
}
function packageFixture() {
  const directory = join(root, 'staging', 'example-skill');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: example-skill\ndescription: "Create the requested example artifact."\n---\n# Example\n\nUse the provided fixture to produce a separate result.\n',
  );
  return directory;
}

it('quotes YAML descriptions, refuses overwrite and requires completion of a scaffold', () => {
  const directory = join(root, 'new-skill');
  const description = 'Create an artifact: preserve "quoted" labels.';
  expect(run(join(creator, 'init-skill.mjs'), [directory, '--description', description]).code).toBe(0);
  const before = readFileSync(join(directory, 'SKILL.md'), 'utf8');
  const metadata = load(/^---\n([\s\S]*?)\n---/.exec(before)![1]!) as { description: string };
  expect(metadata.description).toBe(description);
  expect(run(join(creator, 'init-skill.mjs'), [directory, '--description', 'Other']).code).toBe(1);
  expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe(before);
  expect(JSON.parse(run(join(creator, 'validate-skill.mjs'), [directory]).out).errors).toContain('Unfinished scaffold marker remains.');
  writeFileSync(join(directory, 'SKILL.md'), before.replace(/<!-- skill-scaffold:.*-->/, 'The actual workflow uses the supplied inputs.'));
  expect(run(join(creator, 'validate-skill.mjs'), [directory]).code).toBe(0);
});

it('validates actual package references without interpreting example links as dependencies', () => {
  const directory = packageFixture();
  mkdirSync(join(directory, 'references'));
  writeFileSync(join(directory, 'references', 'workflow.md'), '# Workflow\n\nRead the fixture.\n');
  const fence = String.fromCharCode(96).repeat(3);
  writeFileSync(
    join(directory, 'SKILL.md'),
    readFileSync(join(directory, 'SKILL.md'), 'utf8') +
      `\n[Workflow](references/workflow.md)\n\n${fence}markdown\n[Example](not-a-real-resource.md)\n${fence}\n`,
  );
  expect(run(join(creator, 'validate-skill.mjs'), [directory]).code).toBe(0);
  writeFileSync(join(root, 'staging', 'outside.txt'), 'Outside the package.');
  writeFileSync(join(directory, 'SKILL.md'), readFileSync(join(directory, 'SKILL.md'), 'utf8') + '\n[Escaping](../outside.txt)\n');
  expect(run(join(creator, 'validate-skill.mjs'), [directory]).code).toBe(1);
});

it('reports invalid YAML and missing resources instead of passing a plausible-looking body', () => {
  const directory = packageFixture();
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: example-skill\ndescription: This: is invalid YAML\n---\n# Body\n');
  expect(run(join(creator, 'validate-skill.mjs'), [directory]).code).toBe(1);
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: example-skill\ndescription: "A valid description"\n---\n# Body\n[Missing](missing.md)\n',
  );
  expect(run(join(creator, 'validate-skill.mjs'), [directory]).code).toBe(1);
});

it('previews without writes, verifies copied resources and never executes source scripts', () => {
  const source = packageFixture();
  writeFileSync(
    join(source, 'must-not-run.mjs'),
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(root, 'executed'))},'bad');`,
  );
  const target = join(root, 'new-scope', 'example-skill');
  const args = ['--source', source, '--dest', target];
  const preview = run(installer, args);
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.out).status).toBe('preview');
  expect(existsSync(dirname(target))).toBe(false);
  const copied = run(installer, [...args, '--apply']);
  expect(copied.code).toBe(0);
  expect(JSON.parse(copied.out)).toMatchObject({ status: 'copied', discovery: 'unverified', behavior: 'unverified' });
  expect(readFileSync(join(target, 'must-not-run.mjs'), 'utf8')).toBe(readFileSync(join(source, 'must-not-run.mjs'), 'utf8'));
  expect(existsSync(join(root, 'executed'))).toBe(false);
  writeFileSync(join(target, 'owner-file.txt'), 'Preserve me.');
  expect(run(installer, [...args, '--apply']).code).toBe(1);
  expect(readFileSync(join(target, 'owner-file.txt'), 'utf8')).toBe('Preserve me.');
});

it('rejects overlapping or renamed destinations before creating anything', () => {
  const source = packageFixture();
  expect(run(installer, ['--source', source, '--dest', join(source, 'example-skill'), '--apply']).code).toBe(1);
  const mismatch = join(root, 'wrong-name');
  expect(run(installer, ['--source', source, '--dest', mismatch, '--apply']).code).toBe(1);
  expect(existsSync(mismatch)).toBe(false);
});

it('keeps blocked checks and unknown metrics honest and escapes untrusted report text', () => {
  const input = join(root, 'results.json');
  const runs = [
    {
      eval_id: 'case',
      variant: 'new',
      repeat: 1,
      status: 'completed',
      prompt: '<script>alert(1)</script>',
      summary: 'Observed output.',
      artifacts: ['javascript:alert(1)'],
      checks: [{ text: 'Correct values', status: 'passed', evidence: 'Values inspected.' }],
      metrics: { duration_ms: 100, total_tokens: null },
    },
    {
      eval_id: 'case',
      variant: 'new',
      repeat: 2,
      status: 'completed',
      checks: [{ text: 'Correct values', status: 'failed', evidence: 'Wrong values observed.' }],
      metrics: { duration_ms: 300, total_tokens: 20 },
    },
    {
      eval_id: 'case',
      variant: 'new',
      repeat: 3,
      status: 'blocked',
      summary: 'Required viewer unavailable.',
      checks: [{ text: 'Visual output', status: 'blocked', evidence: 'Viewer unavailable.' }],
    },
  ];
  writeFileSync(input, JSON.stringify({ skill_name: 'example-skill', runs }));
  const output = join(root, 'report');
  expect(run(join(creator, 'summarize-evals.mjs'), [input, output]).code).toBe(0);
  const report = JSON.parse(readFileSync(join(output, 'benchmark.json'), 'utf8'));
  expect(report.variants.new).toMatchObject({
    runs: { completed: 2, failed: 0, blocked: 1 },
    checks: { passed: 1, failed: 1, blocked: 1 },
    observed_check_pass_rate: 0.5,
    total_tokens: { count: 1, mean: 20, stddev: null },
  });
  expect(report.variants.new.duration_ms.mean).toBe(200);
  expect(report.variants.new.duration_ms.stddev).toBeCloseTo(Math.sqrt(20_000));
  const html = readFileSync(join(output, 'review.html'), 'utf8');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href=');
});

it('rejects duplicate runs and unknown statuses instead of publishing misleading reports', () => {
  const input = join(root, 'invalid.json');
  const record = { eval_id: 'case', variant: 'new', repeat: 1, status: 'completed', checks: [] };
  writeFileSync(input, JSON.stringify({ skill_name: 'example-skill', runs: [record, record] }));
  const output = join(root, 'bad-report');
  expect(run(join(creator, 'summarize-evals.mjs'), [input, output]).code).toBe(1);
  expect(existsSync(output)).toBe(false);
  writeFileSync(input, JSON.stringify({ skill_name: 'example-skill', runs: [{ ...record, status: 'pretend-success' }] }));
  expect(run(join(creator, 'summarize-evals.mjs'), [input, output]).code).toBe(1);
});

it('validates the shipped creator and installer with their real resources', () => {
  for (const name of ['skill-creator', 'skill-installer']) {
    const result = execFileSync(process.execPath, [join(creator, 'validate-skill.mjs'), resolve('skills', name)], { encoding: 'utf8' });
    expect(JSON.parse(result).status).toBe('passed');
  }
});
