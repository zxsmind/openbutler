/** The machine log, readable where the machine is configured. */
import { useEffect, useMemo, useState } from 'react';
import { fetchLogs } from '../../../api.js';
import type { LogRecord } from '../../../types.js';
import { SettingsPage, SettingsSection, SettingsStatus } from '../primitives.js';
import './logs.css';

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

function line(record: LogRecord): string {
  const { ts, level, event, ...fields } = record;
  const rest = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `${ts.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${event}${rest ? ` ${rest}` : ''}`;
}

export function LogsSettings() {
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('info');
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLogs(level)
      .then((value) => {
        if (!cancelled) setRecords(value);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [level]);

  const lines = useMemo(() => records.map(line), [records]);

  return (
    <SettingsPage title="Logs" description="What this machine recorded, newest last.">
      <SettingsSection
        title="Level"
        action={
          <div className="settings-range">
            {LEVELS.map((value) => (
              <button
                key={value}
                type="button"
                className={`settings-range__option${value === level ? ' is-active' : ''}`}
                aria-pressed={value === level}
                onClick={() => setLevel(value)}
              >
                {value}
              </button>
            ))}
          </div>
        }
      >
        {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
        {loading && records.length === 0 ? <SettingsStatus>Reading the log...</SettingsStatus> : null}
        {!loading && records.length === 0 ? <SettingsStatus>Nothing recorded at this level yet.</SettingsStatus> : null}
        {lines.length > 0 ? <pre className="settings-log">{lines.join('\n')}</pre> : null}
      </SettingsSection>
    </SettingsPage>
  );
}
