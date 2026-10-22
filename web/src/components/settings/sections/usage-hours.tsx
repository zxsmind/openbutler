/**
 * The last two days, one bar per hour: when the machine was actually working.
 *
 * Every number comes from the server: the day totals, the busiest hour and the
 * peak that scales the bars. Pointing at a bar shows that hour in a tooltip.
 */
import { useState } from 'react';
import { ChartTip, type ChartTipState } from '../chart-tip.js';
import type { UsageHoursReport } from '../../../types.js';
import './usage-hours.css';

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function money(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
}

export function UsageHours({ report }: { report: UsageHoursReport }) {
  const [tip, setTip] = useState<ChartTipState | null>(null);
  const peak = Math.max(1, report.peak);

  const show = (
    point: { clientX: number; clientY: number },
    day: string,
    label: string,
    hour: { requests: number; tokens: number; costUsd: number } | undefined,
  ) => {
    setTip({
      x: point.clientX,
      y: point.clientY,
      title: `${day} ${label}`,
      detail: hour ? `${hour.requests} requests · ${tokens(hour.tokens)} tokens · ${money(hour.costUsd)}` : 'No requests',
    });
  };

  return (
    <div className="settings-hours">
      {report.days.map((day) => {
        const byLabel = new Map(day.hours.map((hour) => [hour.label, hour]));
        return (
          <div key={day.day} className="settings-hours__day">
            <div className="settings-hours__head">
              <span className="settings-hours__day-label">{day.day}</span>
              <span className="settings-hours__totals">
                {day.requests} requests · {tokens(day.tokens)} tokens · {money(day.costUsd)}
                {day.busiestHour ? ` · busiest ${day.busiestHour}` : ''}
              </span>
            </div>
            <div className="settings-hours__bars" role="img" aria-label={`Token activity for ${day.day}`}>
              {Array.from({ length: 24 }, (_, index) => {
                const label = `${String(index).padStart(2, '0')}:00`;
                const hour = byLabel.get(label);
                const height = hour ? Math.max(6, Math.round((hour.tokens / peak) * 100)) : 0;
                return (
                  <span
                    key={label}
                    className={`settings-hours__bar${hour ? '' : ' is-empty'}`}
                    style={{ height: hour ? `${height}%` : undefined }}
                    tabIndex={0}
                    onMouseMove={(event) => show(event, day.day, label, hour)}
                    onMouseLeave={() => setTip(null)}
                    onFocus={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      show({ clientX: rect.x + rect.width / 2, clientY: rect.y }, day.day, label, hour);
                    }}
                    onBlur={() => setTip(null)}
                    aria-label={
                      hour
                        ? `${day.day} ${label}: ${hour.requests} requests, ${tokens(hour.tokens)} tokens, ${money(hour.costUsd)}`
                        : `${day.day} ${label}: no requests`
                    }
                  />
                );
              })}
            </div>
            <div className="settings-hours__ticks" aria-hidden="true">
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
            </div>
          </div>
        );
      })}

      <ChartTip tip={tip} />
    </div>
  );
}
