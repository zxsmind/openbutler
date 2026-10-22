import type { ComponentProps, CSSProperties } from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';

export type { IconName } from 'lucide-react/dynamic';
export type IconProps = Omit<ComponentProps<typeof DynamicIcon>, 'fallback'>;

/** Use any Lucide name directly; no local icon registry or SVG paths. */
export function Icon({ name, size = 18, strokeWidth = 1.6, className = '', style, ...props }: IconProps) {
  const iconClass = `icon ${className}`.trim();
  const iconStyle = { '--icon-size': typeof size === 'number' ? `${size}px` : size, ...style } as CSSProperties;
  return (
    <DynamicIcon
      key={name}
      name={name}
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
      focusable={false}
      {...props}
      className={iconClass}
      style={iconStyle}
      fallback={() => <span className={iconClass} style={iconStyle} aria-hidden="true" />}
    />
  );
}
