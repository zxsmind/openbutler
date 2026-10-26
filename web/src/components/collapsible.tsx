import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Intrinsic grid sizing follows nested panels and streaming content throughout
 * the transition, without capturing an intermediate pixel height as its target. */
export function Collapsible({ open, children, id }: { open: boolean; children: ReactNode; id?: string }) {
  const [mounted, setMounted] = useState(open);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const node = root.current;
    if (!node) return;
    let cancelled = false;
    const transitions = node.getAnimations();
    if (transitions.length === 0) setMounted(false);
    else
      void Promise.allSettled(transitions.map((animation) => animation.finished)).then(() => {
        if (!cancelled) setMounted(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return (
    <div id={id} ref={root} className="step-collapse" data-state={open ? 'open' : 'closed'} aria-hidden={!open} inert={!open}>
      <div className="step-collapse-content">{open || mounted ? children : null}</div>
    </div>
  );
}
