import { useState } from 'react';
import type { SessionInfo } from '../types.js';
import { Button, Icon, IconButton } from './ui.js';
interface SidebarProps {
  sessions: SessionInfo[];
  current?: { id: string; title: string };
  workspace: string;
  workspacePath?: string;
  loading: boolean;
  error: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSearch: () => void;
  onRetry: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onDetails: () => void;
}
export function Sidebar(props: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const list: SessionInfo[] =
    props.current && !props.sessions.some((session) => session.id === props.current?.id)
      ? [{ ...props.current }, ...props.sessions]
      : props.sessions;
  const projects = [
    ...new Set([
      props.workspacePath || props.workspace,
      ...props.sessions.map((session) => session.workspaceRoot).filter((root): root is string => !!root),
    ]),
  ];
  const chat = (session: SessionInfo, nested = false) => (
    <button
      type="button"
      className={`session-item${nested ? ' nested' : ''}${session.id === props.current?.id ? ' current' : ''}`}
      key={session.id}
      aria-current={session.id === props.current?.id ? 'page' : undefined}
      disabled={props.disabled}
      title={props.disabled ? props.disabledReason : session.preview || session.title}
      onClick={() => props.onSelect(session.id)}
    >
      <span className="session-name">{session.title || 'Yeni sohbet'}</span>
    </button>
  );
  return (
    <aside className="sidebar" aria-label="Conversations">
      <div className="sidebar-heading">
        <Button className="brand-button" onClick={props.onDetails}>
          Ranite
          <Icon name="chevron" />
        </Button>
        <span className="spacer" />
        <IconButton icon="search" label="Sohbetlerde ara" onClick={props.onSearch} />
        <IconButton icon="close" label="Close sidebar" className="mobile-only" onClick={props.onClose} />
      </div>
      <Button className="new-chat" icon="compose" onClick={props.onNew} disabled={props.disabled} title={props.disabledReason}>
        Yeni sohbet
      </Button>
      <div className="sidebar-scroll">
        <h2 className="section-label">Projeler</h2>
        <div className="project-list">
          {projects.map((root) => {
            const name = root.split(/[\\/]/).pop() || root;
            const children = list.filter((session) => session.workspaceRoot === root || (!session.workspaceRoot && root === projects[0]));
            return (
              <div className="project" key={root}>
                <button
                  className="project-row"
                  title={root}
                  aria-expanded={!!expanded[root]}
                  onClick={() => setExpanded((previous) => ({ ...previous, [root]: !previous[root] }))}
                >
                  <Icon name="folder" />
                  <span>{name}</span>
                </button>
                {expanded[root] ? (
                  <div className="project-children">
                    {children.slice(0, showAll ? undefined : 4).map((session) => chat(session, true))}
                    {children.length > 4 && !showAll ? (
                      <Button className="show-more" onClick={() => setShowAll(true)}>
                        Daha fazla göster
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <h2 className="section-label recent-label">Yakın zamanlılar</h2>
        <nav className="session-list" aria-label="Recent chats">
          {props.loading && !list.length ? (
            <p className="sidebar-message" role="status">
              Sohbetler yükleniyor…
            </p>
          ) : null}
          {props.error ? (
            <div className="sidebar-message">
              Sohbetler yüklenemedi.<Button onClick={props.onRetry}>Tekrar dene</Button>
            </div>
          ) : null}
          {!props.loading && !props.error && !list.length ? <p className="sidebar-message">Henüz sohbet yok</p> : null}
          {list.map((session) => chat(session))}
        </nav>
      </div>
    </aside>
  );
}
