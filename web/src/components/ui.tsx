import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './icon.js';
export { Icon, type IconName, type IconProps } from './icon.js';

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
  return <span role="img" aria-label="OpenButler" className={large ? 'brand-symbol large' : 'brand-symbol'} />;
}
