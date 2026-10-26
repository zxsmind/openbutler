/**
 * The settings surface: one page, a section list on the left, one section open on
 * the right.
 *
 * The sections are a plain array supplied by the caller, so both the navigation
 * and the routing come from the same list. A new section is one entry and one
 * file; this shell never learns about it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icon.js';
import { Feedback } from '../feedback.js';
import './settings-page.css';

export interface SettingsSectionDef {
  id: string;
  label: string;
  icon: IconName;
  /** Rendered only while its section is open. */
  render: () => ReactNode;
}

export function SettingsView({
  sections,
  active,
  onSelect,
  onClose,
}: {
  sections: SettingsSectionDef[];
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const open = sections.find((section) => section.id === active) ?? sections[0];
  const matches = sections.filter((section) => section.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    if (content.current) {
      content.current.scrollTop = 0;
      content.current.focus({ preventScroll: true });
    }
  }, [open?.id]);
  useEffect(() => {
    const previous = previousFocus.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="settings-surface" role="region" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav__head">
          <h2 className="settings-nav__title">Settings</h2>
        </div>
        <label className="settings-search">
          <Icon name="search" size={15} />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="settings-nav__body">
          <p className="settings-nav__caption">Workspace</p>
          <ul className="settings-nav__list">
            {matches.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className={`settings-nav__item${section.id === open?.id ? ' is-active' : ''}`}
                  aria-current={section.id === open?.id ? 'page' : undefined}
                  onClick={() => onSelect(section.id)}
                >
                  <Icon name={section.icon} size={16} />
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 ? <Feedback layout="compact">No settings found.</Feedback> : null}
        </div>
        <button type="button" className="settings-nav__back" onClick={onClose}>
          <Icon name="arrow-left" size={16} /> Back to chat
        </button>
      </nav>
      <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
        <Icon name="x" size={18} />
      </button>
      <div className="settings-content" ref={content} key={open?.id} tabIndex={-1} aria-label={open?.label}>
        {open ? open.render() : null}
      </div>
    </div>
  );
}
