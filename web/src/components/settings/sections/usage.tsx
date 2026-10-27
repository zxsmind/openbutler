/**
 * What the machine spent. The numbers come from the recorded rows; this section
 * only draws them: a summary, a heatmap of the last weeks, and the daily table.
 */
import { useEffect, useState } from 'react';
import { fetchUsage, fetchUsageActions, fetchUsageHours } from '../../../api.js';
import type { ActionsReport, UsageHoursReport, UsageReport } from '../../../types.js';
import {
  SettingsDisclosure,
  SettingsFigures,
  SettingsGroup,
  SettingsPage,
  SettingsRange,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from '../primitives.js';
import { UsageCalendar } from './usage-calendar.js';
import { UsageHours } from './usage-hours.js';
import './usage.css';

const RANGES = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: 'Year' },
] as const;

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function money(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function UsageSettings() {
  const [range, setRange] = useState<number>(365);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [hours, setHours] = useState<UsageHoursReport | null>(null);
  const [actions, setActions] = useState<ActionsReport | null>(null);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReport(null);
    fetchUsage(range)
      .then((value) => {
        if (!cancelled) setReport(value);
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
  }, [range, reload]);

  // The hourly shape is its own window: two days, independent of the chosen range.
  useEffect(() => {
    let cancelled = false;
    fetchUsageHours(48)
      .then((value) => {
        if (!cancelled) setHours(value);
      })
      .catch(() => {
        // Secondary view: a failure leaves it out instead of failing the page.
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // Tool activity follows the same window as the model report.
  useEffect(() => {
    let cancelled = false;
    setActions(null);
    setActionsError(null);
    fetchUsageActions(range)
      .then((value) => {
        if (!cancelled) setActions(value);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setActionsError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      cancelled = true;
    };
  }, [range, reload]);

  return (
    <SettingsPage title="Usage">
      <SettingsSection title="Overview" action={<SettingsRange label="Usage period" options={RANGES} value={range} onChange={setRange} />}>
        {error ? (
          <SettingsStatus tone="error" action={{ label: 'Try again', onClick: () => setReload((value) => value + 1) }}>
            {error}
          </SettingsStatus>
        ) : null}
        {loading ? <SettingsStatus>Reading recorded usage…</SettingsStatus> : null}
        {report ? (
          <SettingsFigures
            items={[
              { value: tokens(report.summary.inputTokens + report.summary.outputTokens), label: 'Total tokens' },
              { value: report.summary.requests.toLocaleString('en'), label: 'Requests' },
              { value: duration(report.summary.longestTaskMs), label: 'Longest task' },
              { value: `${report.summary.streakDays} ${report.summary.streakDays === 1 ? 'day' : 'days'}`, label: 'Latest streak' },
              { value: money(report.summary.costUsd), label: 'Recorded cost' },
            ]}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Tool activity" description="Every recorded call, per tool, per MCP server and per skill">
        {actionsError ? <SettingsStatus tone="error">{actionsError}</SettingsStatus> : null}
        {actions === null && !actionsError ? <SettingsStatus>Reading recorded tool calls…</SettingsStatus> : null}
        {actions && actions.windowCalls === 0 ? <SettingsStatus>No tool calls recorded in this period.</SettingsStatus> : null}
        {actions && actions.windowCalls > 0 ? (
          <>
            <SettingsFigures
              items={[
                { value: actions.windowCalls.toLocaleString('en'), label: 'Tool calls' },
                { value: actions.windowFailed.toLocaleString('en'), label: 'Failed' },
                { value: actions.mcp.length.toLocaleString('en'), label: 'MCP servers' },
                { value: actions.skills.length.toLocaleString('en'), label: 'Skills used' },
              ]}
            />
            <SettingsDisclosure title="Tools" description="Calls per tool, failures kept visible">
              <div className="settings-table-scroll" tabIndex={0} role="region" aria-label="Tool calls">
                <table className="settings-table">
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Calls</th>
                      <th scope="col">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actions.tools.map((tool) => (
                      <tr key={`${tool.provider}:${tool.tool}`}>
                        <td>
                          {tool.provider}:{tool.tool}
                        </td>
                        <td>{tool.calls.toLocaleString('en')}</td>
                        <td>{tool.failed ? tool.failed.toLocaleString('en') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SettingsDisclosure>
            {actions.mcp.length ? (
              <SettingsDisclosure title="MCP servers" description="Calls routed through each connected server">
                <div className="settings-table-scroll" tabIndex={0} role="region" aria-label="MCP server calls">
                  <table className="settings-table">
                    <thead>
                      <tr>
                        <th scope="col">Server</th>
                        <th scope="col">Calls</th>
                        <th scope="col">Top tools</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actions.mcp.map((server) => (
                        <tr key={server.server}>
                          <td>{server.server}</td>
                          <td>{server.calls.toLocaleString('en')}</td>
                          <td>
                            {server.tools
                              .slice(0, 3)
                              .map((tool) => tool.tool)
                              .join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SettingsDisclosure>
            ) : null}
            {actions.skills.length ? (
              <SettingsDisclosure title="Skills" description="File touches under skills directories">
                <div className="settings-table-scroll" tabIndex={0} role="region" aria-label="Skill usage">
                  <table className="settings-table">
                    <thead>
                      <tr>
                        <th scope="col">Skill</th>
                        <th scope="col">Uses</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actions.skills.map((skill) => (
                        <tr key={skill.skill}>
                          <td>{skill.skill}</td>
                          <td>{skill.uses.toLocaleString('en')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SettingsDisclosure>
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      {report ? (
        <>
          <SettingsSection title="Token activity">
            <UsageCalendar days={report.days} count={range} />
            <div className="settings-calendar__legend">
              <span>One square per day</span>
              <span>
                Less{' '}
                {[0, 1, 2, 3, 4].map((value) => (
                  <i key={value} className={`settings-heatmap__cell level-${value}`} />
                ))}{' '}
                More
              </span>
            </div>
            {report.days.length === 0 ? <SettingsStatus>No requests recorded in this period.</SettingsStatus> : null}
          </SettingsSection>

          <SettingsSection title="Hourly activity" description="The last two days, one bar per hour, scaled to the busiest hour">
            {hours === null ? null : hours.days.length === 0 ? (
              <SettingsStatus>No requests recorded in the last 48 hours.</SettingsStatus>
            ) : (
              <UsageHours report={hours} />
            )}
          </SettingsSection>

          <SettingsSection title="Details">
            <SettingsGroup>
              <SettingsRow label="Input tokens" description="New tokens read by the model">
                <span className="settings-value">{tokens(report.summary.freshInputTokens)}</span>
              </SettingsRow>
              <SettingsRow label="Cached tokens" description="Previously read tokens reused by the model">
                <span className="settings-value">{tokens(report.summary.cacheReadTokens)}</span>
              </SettingsRow>
              <SettingsRow label="Cache writes" description="Tokens stored for subsequent requests">
                <span className="settings-value">{tokens(report.summary.cacheWriteTokens)}</span>
              </SettingsRow>
              <SettingsRow label="Output tokens" description="Tokens generated by the model">
                <span className="settings-value">{tokens(report.summary.outputTokens)}</span>
              </SettingsRow>
              <SettingsRow
                label="Busiest day"
                description={report.summary.busiest ? `${report.summary.busiest.requests} requests` : 'No requests recorded'}
              >
                <span className="settings-value">{report.summary.busiest?.day ?? '-'}</span>
              </SettingsRow>
              <SettingsRow label="Cost source" description="Provider-stated is a bill; catalog is an estimate">
                <span className="settings-value">
                  {report.summary.pricedRows} stated · {report.summary.unpricedRows} estimated
                </span>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>

          <SettingsDisclosure title="Daily breakdown" description="Requests, tokens and cost for each recorded day">
            <div className="settings-table-scroll" tabIndex={0} role="region" aria-label="Daily usage">
              <table className="settings-table">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Reqs</th>
                    <th scope="col">Input</th>
                    <th scope="col">Cache</th>
                    <th scope="col">Output</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...report.days].reverse().map((day) => (
                    <tr key={day.day}>
                      <td>{day.day}</td>
                      <td>{day.requests}</td>
                      <td>{tokens(day.freshInputTokens)}</td>
                      <td>{tokens(day.cacheReadTokens)}</td>
                      <td>{tokens(day.outputTokens)}</td>
                      <td>{money(day.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SettingsDisclosure>
        </>
      ) : null}
    </SettingsPage>
  );
}
