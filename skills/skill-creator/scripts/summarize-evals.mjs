// OpenButler helper; see LICENSE.txt and NOTICE.txt in this package.
import process from 'node:process';
import console from 'node:console';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const validStatuses = ['completed', 'failed', 'blocked'];
const checkStatuses = ['passed', 'failed', 'blocked'];
const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function stats(values) {
  const count = values.length;
  if (!count) return { count: 0, mean: null, stddev: null };
  const mean = values.reduce((a, b) => a + b, 0) / count;
  return { count, mean, stddev: count > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)) : null };
}
function summarize(input) {
  if (!input || !nonempty(input.skill_name) || !Array.isArray(input.runs) || !input.runs.length)
    throw new Error('Expected skill_name and a nonempty runs array.');
  if (input.iteration !== undefined && typeof input.iteration !== 'string') throw new Error('Iteration must be a string.');
  const keys = new Set();
  const variants = new Map();
  for (const run of input.runs) {
    if (
      !run ||
      !nonempty(run.eval_id) ||
      !nonempty(run.variant) ||
      !Number.isInteger(run.repeat) ||
      run.repeat < 1 ||
      !validStatuses.includes(run.status) ||
      !Array.isArray(run.checks)
    )
      throw new Error('Invalid run identity, status or checks.');
    const key = JSON.stringify([run.eval_id, run.variant, run.repeat]);
    if (keys.has(key)) throw new Error('Duplicate eval/variant/repeat.');
    keys.add(key);
    for (const field of ['prompt', 'summary'])
      if (run[field] !== undefined && typeof run[field] !== 'string') throw new Error(`Invalid ${field}.`);
    if (run.status === 'blocked' && !nonempty(run.summary)) throw new Error('Blocked run requires a summary reason.');
    if (run.artifacts !== undefined && (!Array.isArray(run.artifacts) || !run.artifacts.every((value) => typeof value === 'string')))
      throw new Error('Artifacts must be strings.');
    if (run.metrics !== undefined && (!run.metrics || typeof run.metrics !== 'object' || Array.isArray(run.metrics)))
      throw new Error('Invalid metrics object.');
    for (const metric of ['duration_ms', 'total_tokens']) {
      const value = run.metrics?.[metric];
      if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
        throw new Error(`Invalid ${metric}.`);
    }
    if (!variants.has(run.variant))
      variants.set(run.variant, {
        runs: { completed: 0, failed: 0, blocked: 0 },
        checks: { passed: 0, failed: 0, blocked: 0 },
        durations: [],
        tokens: [],
      });
    const variant = variants.get(run.variant);
    variant.runs[run.status]++;
    for (const check of run.checks) {
      if (!check || !nonempty(check.text) || !nonempty(check.evidence) || !checkStatuses.includes(check.status))
        throw new Error('Check needs text, evidence and passed/failed/blocked status.');
      variant.checks[check.status]++;
    }
    if (run.metrics?.duration_ms != null) variant.durations.push(run.metrics.duration_ms);
    if (run.metrics?.total_tokens != null) variant.tokens.push(run.metrics.total_tokens);
  }
  return {
    skill_name: input.skill_name,
    iteration: input.iteration ?? null,
    variants: Object.fromEntries(
      [...variants].map(([name, value]) => [
        name,
        {
          runs: value.runs,
          checks: value.checks,
          observed_check_pass_rate:
            value.checks.passed + value.checks.failed ? value.checks.passed / (value.checks.passed + value.checks.failed) : null,
          duration_ms: stats(value.durations),
          total_tokens: stats(value.tokens),
        },
      ]),
    ),
    recorded_runs: input.runs,
  };
}
function html(report) {
  const rows = Object.entries(report.variants)
    .map(
      ([name, value]) =>
        `<tr><td>${escape(name)}</td><td>${escape(JSON.stringify(value.runs))}</td><td>${escape(JSON.stringify(value.checks))}</td><td>${value.observed_check_pass_rate === null ? 'Unmeasured' : escape((value.observed_check_pass_rate * 100).toFixed(1) + '%')}</td><td>${escape(JSON.stringify(value.duration_ms))}</td><td>${escape(JSON.stringify(value.total_tokens))}</td></tr>`,
    )
    .join('');
  const runs = report.recorded_runs
    .map(
      (run) =>
        `<article><h2>${escape(run.eval_id)} · ${escape(run.variant)} · ${run.repeat}</h2><p>Status: ${escape(run.status)}</p><h3>Prompt</h3><pre>${escape(run.prompt)}</pre><h3>Observed output</h3><pre>${escape(run.summary)}</pre><h3>Checks</h3><ul>${run.checks.map((check) => `<li><strong>${escape(check.status)}</strong>: ${escape(check.text)}<pre>${escape(check.evidence)}</pre></li>`).join('')}</ul><h3>Artifact paths</h3><pre>${escape((run.artifacts ?? []).join('\n'))}</pre></article>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(report.skill_name)} review</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#252830}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}article{margin-top:36px;border-top:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f8;padding:12px}h3{font-size:15px}</style><h1>${escape(report.skill_name)} review</h1><p>Recorded evidence only. Blocked checks and unknown metrics are separate from passes. Artifact paths are not executed or fetched.</p><table><thead><tr><th>Variant</th><th>Runs</th><th>Checks</th><th>Observed pass rate</th><th>Duration ms</th><th>Tokens</th></tr></thead><tbody>${rows}</tbody></table>${runs}</html>`;
}

if (process.argv.length !== 4) {
  console.error('Usage: node summarize-evals.mjs <results.json> <new-report-directory>');
  process.exitCode = 2;
} else {
  let output;
  let created = false;
  try {
    const report = summarize(JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8')));
    output = resolve(process.argv[3]);
    mkdirSync(output);
    created = true;
    writeFileSync(join(output, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(join(output, 'review.html'), html(report), { flag: 'wx' });
    console.log(JSON.stringify({ status: 'written', directory: output, runs: report.recorded_runs.length }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error.message, ...(created ? { partialDirectory: output } : {}) }));
    process.exitCode = 1;
  }
}
