import { type ButtonHTMLAttributes, type ReactNode } from 'react';

const paths = {
  sidebar: 'M4 4h16v16H4z M9 4v16',
  info: 'M12 11v6 M12 7v.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  folder: 'M3 7V5h6l2 2h10v12H3z',
  search: 'm16 16 4 4 M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M9 12l2 2 4-4',
  close: 'm6 6 12 12 M18 6 6 18',
  home: 'm3 10 9-7 9 7 M5 9v12h5v-7h4v7h5V9',
  chat: 'M4 4h16v12H9l-5 4z',
  compose: 'M13 5H4v15h15v-9 M16 3l5 5-9 9-5 2 2-5z',
  arrow: 'M12 19V5 m-6 6 6-6 6 6',
  stop: 'M6 6h12v12H6z',
  chevron: 'm8 10 4 4 4-4',
  computer: 'M5 4h14v12H5z M2 20h20 M9 16v4 M15 16v4',
  check: 'm5 12 4 4 10-10',
  plus: 'M12 5v14 M5 12h14',
  terminal: 'M3 5h18v14H3z m4 4 3 3-3 3 M13 15h4',
  browser: 'M9 18H3V4h18v7 M3 8h18 M7 6h.01 M10 6h.01 M11 11l3 10 2-4 4-1z',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 M12 3c5 5 5 13 0 18',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M6 10v2a6 6 0 0 0 12 0v-2 M12 18v4 M9 22h6',
  image: 'M3 4h18v16H3z m0 12 6-6 5 5 3-3 4 4 M17 8h.01',
  spark: 'm13 2-9 12h7l-1 8 10-13h-7z',
  reset: 'M3 10V4 M3 4h6 M3 4l4 4 M4 13a8 8 0 1 0 3-7',
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'primary' | 'danger';
  icon?: IconName;
  children?: ReactNode;
};
export function Button({ variant = 'ghost', icon, className = '', children, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={`button button-${variant} ${className}`} {...props}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
export function IconButton({ icon, label, className = '', ...props }: Omit<ButtonProps, 'children'> & { icon: IconName; label: string }) {
  return <Button {...props} icon={icon} className={`icon-button ${className}`} aria-label={label} title={label} />;
}
export function Brand({ large = false }: { large?: boolean }) {
  return (
    <svg
      className={large ? 'brand-symbol large' : 'brand-symbol'}
      width="28"
      height="28"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path d="M12 4h8l8 12-8 12h-8L4 16z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m12 11 4 5-4 5 M18 21h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
