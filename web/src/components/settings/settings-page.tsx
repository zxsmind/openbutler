import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../ui.js';
import { SidebarHeader, SidebarFooter } from '../sidebar-chrome.js';
import { Feedback } from '../feedback.js';
import './settings-page.css';

export interface SettingsSectionDef {
  id: string;
  label: string;
  icon: IconName;
  group: 'Intelligence' | 'Workspace' | 'System';
  description: string;
  render: () => ReactNode;
}

const GROUPS = ['Intelligence', 'Workspace', 'System'] as const;

/** Settings owns its layout; conversation components and styles are not altered. */
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const content = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const previousFocus = useRef(document.activeElement);
  const open = sections.find((section) => section.id === active) ?? sections[0];
  const normalized = query.trim().toLocaleLowerCase();
  const matches = sections.filter((section) =>
    [section.label, section.description, section.group].some((value) => value.toLocaleLowerCase().includes(normalized)),
  );

  useEffect(() => {
    if (!content.current) return;
    content.current.scrollTop = 0;
    content.current.focus({ preventScroll: true });
  }, [open?.id]);

  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName));
      if (event.key === 'Escape') setSearchOpen(false);
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const previous = previousFocus.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <div className="settings-surface" role="region" aria-label="Settings">
      <nav className="settings-nav sidebar-shell" aria-label="Settings sections">
        <SidebarHeader onSearch={() => setSearchOpen(true)} searchLabel="Search settings" />
        <div className="sidebar-scroll settings-nav__scroll">
          {GROUPS.map((group, index) => {
            const grouped = sections.filter((section) => section.group === group);
            if (!grouped.length) return null;
            return (
              <div className="settings-nav__group" key={group}>
                <h3 className={`section-label${index > 0 ? ' recent-label' : ''}`}>{group}</h3>
                <ul className="session-list">
                  {grouped.map((section) => (
                    <li key={section.id}>
                      <button
                        type="button"
                        className={`session-item${section.id === open?.id ? ' current' : ''}`}
                        aria-current={section.id === open?.id ? 'page' : undefined}
                        onClick={() => onSelect(section.id)}
                      >
                        <Icon name={section.icon} size={15} />
                        <span className="session-name">{section.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <SidebarFooter icon="arrow-left" label="Back to chat" onClick={onClose} />
      </nav>

      <main className="settings-content" ref={content} tabIndex={-1} aria-label={open?.label}>
        <div className="settings-content__inner" key={open?.id}>
          {open ? open.render() : null}
        </div>
      </main>

      {searchOpen ? (
        <div className="search-overlay settings-search-overlay" role="presentation" onClick={() => setSearchOpen(false)}>
          <div
            className="search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Search settings"
            onClick={(event) => event.stopPropagation()}
          >
            <label className="search-field">
              <Icon name="search" size={18} />
              <input
                ref={search}
                aria-label="Search settings"
                type="search"
                placeholder="Search settings..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="search-results">
              {matches.map((section) => (
                <button
                  type="button"
                  className="search-result"
                  key={section.id}
                  onClick={() => {
                    onSelect(section.id);
                    setSearchOpen(false);
                    setQuery('');
                  }}
                >
                  <Icon name={section.icon} size={17} />
                  <span>
                    <strong>{section.label}</strong>
                    <small>{section.description}</small>
                  </span>
                </button>
              ))}
              {!matches.length ? <Feedback layout="compact">No matching settings.</Feedback> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
