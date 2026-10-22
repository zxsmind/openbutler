import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import './context-meter.css';

export function ContextMeter({ tokens, limit }: { tokens?: number | null; limit?: number | null }) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const used = tokens != null && Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : null;
  const capacity = limit != null && Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null;
  const ratio = used !== null && capacity !== null ? Math.min(1, used / capacity) : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);
  const usage = percent === null ? 'Waiting for usage data' : `${percent}% used (${100 - percent}% left)`;
  return (
    <span
      ref={root}
      className="context-meter"
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') setOpen(false);
      }}
    >
      <button
        type="button"
        className="context-meter__trigger"
        aria-label={`Context window: ${usage}`}
        aria-describedby={open ? id : undefined}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onPointerDown={(event) => {
          // A touch must toggle once, without focus opening it before the click.
          if (event.pointerType === 'touch') event.preventDefault();
        }}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <span
          className="context-meter__ring"
          aria-hidden="true"
          style={{ '--context-progress': `${(ratio ?? 0) * 100}%` } as CSSProperties}
        />
      </button>
      <span id={id} role="tooltip" className="context-meter__tooltip" data-open={open || undefined}>
        <span className="context-meter__heading">Context window:</span>
        <span>{usage}</span>
        <span>
          {used ?? '—'} / {capacity ?? '—'} token
          <br />
          used
        </span>
      </span>
    </span>
  );
}
