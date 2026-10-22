/**
 * One floating readout for the charts.
 *
 * Rendered into the body so a scrolling or clipping panel can never cut it off,
 * and positioned at the pointer: charts answer "what is this bar" without a
 * separate legend line taking up space.
 */
import { createPortal } from 'react-dom';

export interface ChartTipState {
  x: number;
  y: number;
  title: string;
  detail: string | null;
}

export function ChartTip({ tip }: { tip: ChartTipState | null }) {
  if (!tip) return null;
  return createPortal(
    <div className="settings-chart-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
      <strong>{tip.title}</strong>
      {tip.detail ? <span>{tip.detail}</span> : null}
    </div>,
    document.body,
  );
}
