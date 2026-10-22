import { useState } from 'react';
import type { Project, SessionInfo } from '../types.js';
import { Button, Icon, IconButton } from './ui.js';
interface SidebarProps {
  inert?: boolean;
  sessions: SessionInfo[];
  current?: { id: string; title: string };
  projects: Project[];
  selectedProjectId: string | null;
  projectSelectionDisabled?: boolean;
  projectsLoading: boolean;
  projectsError: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onRetryProjects: () => void;
  loading: boolean;
  error: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSearch: () => void;
  onRetry: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onSettings: () => void;
}
export function Sidebar(props: SidebarProps) {
  const [showAll, setShowAll] = useState(false);
  const list: SessionInfo[] =
    props.current && !props.sessions.some((session) => session.id === props.current?.id)
      ? [{ ...props.current }, ...props.sessions]
      : props.sessions;
  const chat = (session: SessionInfo) => (
    <button
      type="button"
      className={`session-item${session.id === props.current?.id ? ' current' : ''}`}
      key={session.id}
      aria-current={session.id === props.current?.id ? 'page' : undefined}
      disabled={props.disabled}
      title={props.disabled ? props.disabledReason : session.preview || session.title}
      onClick={() => props.onSelect(session.id)}
    >
      <span className="session-name">{session.title || 'New chat'}</span>
    </button>
  );
  return (
    <aside className="sidebar" aria-label="Conversations" inert={props.inert}>
      <div className="sidebar-heading">
        <span className="sidebar-brand">Ranite</span>
        <span className="spacer" />
        <IconButton icon="search" label="Search chats" onClick={props.onSearch} />
        <IconButton icon="x" label="Close sidebar" className="mobile-only" onClick={props.onClose} />
      </div>
      <Button className="new-chat" icon="square-pen" onClick={props.onNew} disabled={props.disabled} title={props.disabledReason}>
        New chat
      </Button>
      <div className="sidebar-scroll">
        <div className="sidebar-projects-heading">
          <h2 className="section-label">Projects</h2>
          <IconButton icon="plus" label="New project" onClick={props.onCreateProject} />
        </div>
        <div className="project-list">
          {props.projects.slice(0, showAll ? undefined : 5).map((project) => (
            <button
              key={project.id}
              type="button"
              className={`project-row${project.id === props.selectedProjectId ? ' is-selected' : ''}`}
              title={project.available ? project.folders.join('\n') : 'Source folder is unreachable'}
              aria-pressed={project.id === props.selectedProjectId}
              disabled={!project.available || props.projectSelectionDisabled}
              onClick={() => props.onSelectProject(project.id)}
            >
              <Icon name="folder" />
              <span>{project.name}</span>
            </button>
          ))}
          {props.projects.length > 5 && !showAll ? (
            <Button className="show-more" onClick={() => setShowAll(true)}>
              Show more
            </Button>
          ) : null}
          {props.projectsLoading && !props.projects.length ? (
            <p className="sidebar-message" role="status">
              Loading projects…
            </p>
          ) : null}
          {props.projectsError ? (
            <p className="sidebar-message" role="alert">
              Projects could not be loaded.<Button onClick={props.onRetryProjects}>Try again</Button>
            </p>
          ) : null}
          {!props.projectsLoading && !props.projectsError && !props.projects.length ? (
            <p className="sidebar-message">No projects yet.</p>
          ) : null}
        </div>
        <h2 className="section-label recent-label">Recent</h2>
        <nav className="session-list" aria-label="Recent chats">
          {props.loading && !list.length ? (
            <p className="sidebar-message" role="status">
              Loading chats…
            </p>
          ) : null}
          {props.error ? (
            <div className="sidebar-message">
              Chats could not be loaded.<Button onClick={props.onRetry}>Try again</Button>
            </div>
          ) : null}
          {!props.loading && !props.error && !list.length ? <p className="sidebar-message">No chats yet</p> : null}
          {list.map((session) => chat(session))}
        </nav>
      </div>
      <div className="sidebar-footer">
        {/* Settings stays reachable while a run is going; the page is read-only then. */}
        <Button className="sidebar-settings" icon="settings" onClick={props.onSettings}>
          Settings
        </Button>
      </div>
    </aside>
  );
}
