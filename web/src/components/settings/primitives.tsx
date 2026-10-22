/**
 * The pieces a settings section is built from.
 *
 * One page header, sections, bordered groups of rows, and the small controls the
 * sections share. Everything visual lives here so sections only describe data.
 */
import type { ReactNode } from 'react';
import './primitives.css';

export function SettingsPage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-page">
      <header className="settings-page__header">
        <h1>{title}</h1>
        {description ? <p className="settings-page__description">{description}</p> : null}
      </header>
      <div className="settings-page__body">{children}</div>
    </section>
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      {title || action ? (
        <div className="settings-section__head">
          <div className="settings-section__text">
            {title ? <h2 className="settings-section__title">{title}</h2> : null}
            {description ? <p className="settings-section__description">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {!title && !action && description ? <p className="settings-section__description">{description}</p> : null}
      {children}
    </section>
  );
}

/** A bordered block of rows; `danger` is the only tone that changes meaning. */
export function SettingsGroup({ tone = 'default', children }: { tone?: 'default' | 'danger'; children: ReactNode }) {
  return <div className={`settings-group settings-group--${tone}`}>{children}</div>;
}

/** One setting: what it is on the left, the control on the right. */
export function SettingsRow({
  label,
  description,
  children,
  align = 'center',
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  align?: 'center' | 'start';
}) {
  return (
    <div className={`settings-row settings-row--${align}`}>
      <div className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        {description ? <span className="settings-row__description">{description}</span> : null}
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}

/** Optional settings stay folded; the browser's own disclosure does the work. */
export function SettingsDisclosure({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <details className="settings-disclosure">
      <summary>
        <span className="settings-disclosure__title">{title}</span>
        {description ? <span className="settings-disclosure__description">{description}</span> : null}
      </summary>
      <div className="settings-disclosure__body">{children}</div>
    </details>
  );
}

export function SettingsStatus({ tone = 'muted', children }: { tone?: 'ok' | 'warn' | 'error' | 'muted'; children: ReactNode }) {
  return (
    <p className={`settings-status settings-status--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function SettingsFigures({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="settings-figures">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SettingsRange<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-range" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`settings-range__option${option.value === value ? ' is-active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
