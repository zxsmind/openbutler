import { useState } from 'react';
import type { Project, SessionInfo } from '../types.js';
import { Button, Icon, IconButton } from './ui.js';
import { Feedback } from './feedback.js';
import { SidebarHeader, SidebarFooter } from './sidebar-chrome.js';
interface SidebarProps {
  inert?: boolean;
  sessions: SessionInfo[];
  current?: { id: string; title: string; hasUserMessage?: boolean };
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
  // The store is the catalog: a chat without a message is not a row yet, so
  // the placeholder only appears once its first message has landed.
  const list: SessionInfo[] =
    props.current && props.current.hasUserMessage && !props.sessions.some((session) => session.id === props.current?.id)
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
      {session.running ? <span className="session-running" role="img" aria-label="Agent running" title="Agent running" /> : null}
    </button>
  );
  return (
    <aside id="sidebar-nav" className="sidebar sidebar-shell" aria-label="Conversations" inert={props.inert}>
      <SidebarHeader onSearch={props.onSearch} searchLabel="Search chats" onClose={props.onClose} />
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
            <Feedback tone="loading" layout="compact">
              Loading projects…
            </Feedback>
          ) : null}
          {props.projectsError ? (
            <Feedback tone="error" layout="compact" action={{ label: 'Try again', onClick: props.onRetryProjects }}>
              Projects could not be loaded.
            </Feedback>
          ) : null}
          {!props.projectsLoading && !props.projectsError && !props.projects.length ? (
            <Feedback layout="compact">No projects yet.</Feedback>
          ) : null}
        </div>
        <h2 className="section-label recent-label">Recent</h2>
        <nav className="session-list" aria-label="Recent chats">
          {props.loading && !list.length ? (
            <Feedback tone="loading" layout="compact">
              Loading chats…
            </Feedback>
          ) : null}
          {props.error ? (
            <Feedback tone="error" layout="compact" action={{ label: 'Try again', onClick: props.onRetry }}>
              Chats could not be loaded.
            </Feedback>
          ) : null}
          {!props.loading && !props.error && !list.length ? <Feedback layout="compact">No chats yet.</Feedback> : null}
          {list.map((session) => chat(session))}
        </nav>
      </div>
      {/* Settings stays reachable while a run is going; the page is read-only then. */}
      <SidebarFooter icon="settings" label="Settings" onClick={props.onSettings} />
    </aside>
  );
}
