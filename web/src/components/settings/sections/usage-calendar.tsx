import { useState, type CSSProperties } from 'react';
import { ChartTip, type ChartTipState } from '../chart-tip.js';
import { buildUsageCalendar } from '../../../usage-calendar.js';
import type { UsageDay } from '../../../types.js';

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Match the ledger's local calendar dates, including around midnight and DST. */
export { buildUsageCalendar };

export function UsageCalendar({ days, count }: { days: UsageDay[]; count: number }) {
  const [tip, setTip] = useState<ChartTipState | null>(null);
  const cells = buildUsageCalendar(days, count);
  // The day's token total comes from the server, already summed.
  const total = (day: UsageDay | undefined) => day?.tokens ?? 0;
  const peak = Math.max(1, ...cells.map((cell) => total(cell?.usage)));
  const months = cells
    .flatMap((cell, index) =>
      cell && (!cells[index - 1] || cell.date.getDate() === 1)
        ? [{ label: cell.date.toLocaleDateString('en', { month: 'short' }), column: Math.floor(index / 7) + 1 }]
        : [],
    )
    .filter((month, index, all) => index !== 0 || all.length === 1 || all[1].column - month.column >= 3);

  return (
    <div className="settings-calendar-scroll" tabIndex={0} role="region" aria-label="Token activity calendar">
      <div className="settings-calendar" style={{ '--weeks': cells.length / 7 } as CSSProperties}>
        <div
          className="settings-heatmap"
          role="img"
          aria-label={`Daily token use over the last ${count} days. Darker squares indicate more tokens.`}
        >
          {cells.map((cell, index) => (
            <span
              key={cell?.key ?? `padding-${index}`}
              className={`settings-heatmap__cell${cell ? ` level-${total(cell.usage) > 0 ? Math.max(1, Math.ceil((total(cell.usage) / peak) * 4)) : 0}` : ' is-outside'}`}
              onMouseMove={
                cell
                  ? (event) =>
                      setTip({
                        x: event.clientX,
                        y: event.clientY,
                        title: cell.key,
                        detail: `${tokens(total(cell.usage))} tokens`,
                      })
                  : undefined
              }
              onMouseLeave={cell ? () => setTip(null) : undefined}
              aria-label={cell ? `${cell.key}: ${tokens(total(cell.usage))} tokens` : undefined}
            />
          ))}
        </div>
        <div className="settings-calendar__months" aria-hidden="true">
          {months.map((month) => (
            <span key={`${month.label}-${month.column}`} style={{ gridColumn: month.column }}>
              {month.label}
            </span>
          ))}
        </div>
      </div>
      <ChartTip tip={tip} />
    </div>
  );
}
