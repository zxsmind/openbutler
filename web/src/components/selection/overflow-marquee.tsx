import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from './cn.js';
import './overflow-marquee.css';

interface OverflowMarqueeProps {
  active?: boolean;
  children: ReactNode;
  className?: string;
  animateOnInteraction?: boolean;
}

export function OverflowMarquee({ active = false, animateOnInteraction = true, children, className }: OverflowMarqueeProps) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      return undefined;
    }

    let active = true;
    const measure = () => {
      if (!active) {
        return;
      }

      const distance = Math.max(0, content.scrollWidth - viewport.clientWidth);
      setOverflowDistance((current) => (Math.abs(current - distance) < 1 ? current : distance));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        active = false;
        window.removeEventListener('resize', measure);
      };
    }

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    void document.fonts?.ready.then(() => {
      if (active) {
        measure();
      }
    });

    return () => {
      active = false;
      observer.disconnect();
    };
  }, [children]);

  const isOverflowing = overflowDistance > 1;
  const style = isOverflowing ? ({ '--overflow-marquee-offset': `${-overflowDistance}px` } as CSSProperties) : undefined;

  return (
    <span
      ref={viewportRef}
      className={cn('overflow-marquee', className)}
      data-overflowing={isOverflowing ? 'true' : undefined}
      data-animate-on-interaction={animateOnInteraction ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
      style={style}
    >
      <span ref={contentRef} className="overflow-marquee__track">
        {children}
      </span>
    </span>
  );
}
