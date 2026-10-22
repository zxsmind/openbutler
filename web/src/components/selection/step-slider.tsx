import { useRef, useState, type CSSProperties } from 'react';
import './step-slider.css';

interface StepSliderProps {
  label: string;
  unselectedLabel?: string;
  options: ReadonlyArray<{ value: string | null; label: string }>;
  value: string | null;
  disabled?: boolean;
  busy?: boolean;
  onChange: (value: string | null) => void | Promise<void>;
  onPreviewChange?: (label: string | null) => void;
}

/** Native keyboard/pointer interaction over an ordered, supplied option list. */
export function StepSlider({
  label,
  unselectedLabel = label,
  options,
  value,
  disabled = false,
  busy = false,
  onChange,
  onPreviewChange,
}: StepSliderProps) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const pointerActive = useRef(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const displayedIndex = previewIndex ?? selectedIndex;
  const unselected = value === null && selectedIndex < 0;
  const unavailable = disabled || options.length === 0 || (!unselected && (selectedIndex < 0 || options.length < 2));
  const progress = displayedIndex < 0 || options.length < 2 ? 0 : displayedIndex / (options.length - 1);
  async function commit(index: number) {
    const option = options[index];
    if (!option) return;
    setPreviewIndex(index);
    onPreviewChange?.(option.label);
    try {
      if (option.value !== value) await onChange(option.value);
    } finally {
      setPreviewIndex(null);
      onPreviewChange?.(null);
    }
  }
  return (
    <div
      className="step-slider"
      data-disabled={unavailable || undefined}
      data-unselected={displayedIndex < 0 || undefined}
      style={{ '--step-slider-progress': String(progress) } as CSSProperties}
    >
      <div className="step-slider__ticks" aria-hidden="true">
        {options.map((option, index) => (
          <span key={option.value ?? 'unselected'} data-filled={index <= displayedIndex || undefined} />
        ))}
      </div>
      <div className="step-slider__thumb" aria-hidden="true" />
      <input
        className="step-slider__input"
        type="range"
        min={0}
        max={Math.max(0, options.length - 1)}
        step={1}
        value={Math.max(0, displayedIndex)}
        disabled={unavailable}
        aria-label={label}
        aria-disabled={unavailable || busy}
        aria-busy={busy}
        aria-valuetext={options[displayedIndex]?.label ?? unselectedLabel}
        onKeyDown={(event) => {
          if (busy && event.key !== 'Tab' && event.key !== 'Escape') {
            event.preventDefault();
            return;
          }
          if (unselected && ['Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            void commit(event.key === 'End' ? options.length - 1 : 0);
          }
        }}
        onPointerDown={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          pointerActive.current = true;
        }}
        onPointerUp={(event) => {
          if (!pointerActive.current) return;
          pointerActive.current = false;
          void commit(Number(event.currentTarget.value));
        }}
        onPointerCancel={() => {
          if (!pointerActive.current) return;
          pointerActive.current = false;
          setPreviewIndex(null);
          onPreviewChange?.(null);
        }}
        onChange={(event) => {
          if (busy) return;
          const index = Number(event.target.value);
          setPreviewIndex(index);
          onPreviewChange?.(options[index]?.label ?? null);
          if (!pointerActive.current) void commit(index);
        }}
      />
    </div>
  );
}
