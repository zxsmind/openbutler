/**
 * `ranite usage`: what the machine spent, read from the recorded rows.
 *
 * The rows are the record; this command is one view of them. It reads the same
 * SQLite file the host writes, read-only, so asking costs nothing and changes
 * nothing.
 */
import { ActivityLedger } from '../activity-ledger.js';
import { bucketUsage, renderUsageReport, summarizeUsage } from '../usage/report.js';
import type { Parsed } from './args.js';
import * as ui from './ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runUsage(parsed: Parsed): Promise<void> {
  const rawDays = parsed.flags.get('days');
  const days = rawDays === undefined ? 30 : Number(rawDays);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('--days must be between 1 and 3650.');
  const sessionId = parsed.flags.get('session');
  const model = parsed.flags.get('model');
  const [providerId, modelId] = model ? model.split('/', 2) : [];

  const ledger = new ActivityLedger(undefined, { readOnly: true });
  try {
    const rows = ledger.usageRows({
      sinceMs: Date.now() - days * DAY_MS,
      ...(sessionId ? { sessionId } : {}),
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
    });
    const buckets = bucketUsage(rows);
    const summary = summarizeUsage(buckets, rows);
    const scope = [sessionId ? `session ${sessionId.slice(0, 8)}` : '', model ? `model ${model}` : ''].filter(Boolean).join(', ');
    const label = `last ${days} days${scope ? ` (${scope})` : ''}`;
    if (parsed.booleans.has('json')) {
      ui.line(JSON.stringify({ label, summary, days: buckets }, null, 2));
      return;
    }
    ui.line(renderUsageReport(buckets, summary, label));
  } finally {
    ledger.close();
  }
}
