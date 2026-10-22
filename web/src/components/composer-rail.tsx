import type { HTMLAttributes } from 'react';
import './composer-rail.css';

/** Shared surface tucked behind the composer; feature components provide its contents. */
export function ComposerRail({ tone = 'default', className = '', ...props }: HTMLAttributes<HTMLElement> & { tone?: 'default' | 'muted' }) {
  return <section {...props} className={`composer-rail composer-rail--${tone} ${className}`} />;
}
