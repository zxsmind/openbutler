import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DraftImage } from './types.js';
import { useSession } from './use-session.js';
import { useProjects } from './projects/use-projects.js';
import { ProjectContextBar } from './projects/project-selector.js';
import { CreateProjectDialog } from './projects/create-project-dialog.js';
import { awaitingFirstChunk, buildTurns, formatDuration } from './turns.js';
import { TurnView } from './turn.js';
import { TypingIndicator } from './components/typing-indicator.js';
import { VirtualList } from './virtual.js';
import { SearchDialog } from './components/search-dialog.js';
import { Sidebar } from './components/sidebar.js';
import { SettingsView } from './components/settings/settings-page.js';
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS } from './components/settings/sections/index.js';
import { SettingsSessionProvider } from './components/settings/settings-session.js';
import { Composer } from './components/composer.js';
import { PendingActions } from './components/pending-actions.js';
import { SessionDetails } from './components/session-details.js';
import { Button, IconButton } from './components/ui.js';

export function App() {
  const session = useSession();
  const projects = useProjects(
    session.payload?.session,
    async (projectId) => {
      if (session.payload?.session.projectLocked) {
        if (!(await session.switchSession(undefined, projectId))) throw new Error('A new chat could not be opened in this project.');
      } else await session.selectProject(projectId);
    },
    !session.payload?.busy && (session.payload?.queuedMessageCount ?? 0) === 0,
  );
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const closeCreateProject = useCallback(() => setCreateProjectOpen(false), []);
  const [sidebarVisible, setSidebarVisible] = useState(() => window.matchMedia('(min-width: 761px)').matches);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Settings are a page addressed by the hash (#/settings/usage): no router, and
  // the chat stays mounted underneath so coming back is instant.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const settingsSection = hash.startsWith('#/settings') ? hash.split('/')[2] || DEFAULT_SETTINGS_SECTION : null;
  const openSettings = (section: string) => {
    window.location.hash = `#/settings/${section}`;
  };
  const [draftImages, setDraftImages] = useState<Record<string, DraftImage[]>>({});
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [elapsed, setElapsed] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const payload = session.payload;
  const id = payload?.session.id ?? '';
  const busy = payload?.busy ?? false;
  const queued = payload?.queuedMessageCount ?? 0;
  const connected = session.status === 'open' && !!payload;
  const turns = useMemo(() => buildTurns(session.entries, session.base), [session.entries, session.base]);
  const liveTurn = busy ? turns[turns.length - 1]?.id : undefined;
  // The dot is a "your message was taken, nothing has come back yet" signal, not a
  // running indicator: it appears after a send and leaves on the first chunk, so
  // it never sits under the transcript while the agent works.
  const showTyping = awaitingFirstChunk(turns, liveTurn);
  const typingIndicator = useMemo(() => (showTyping ? <TypingIndicator /> : null), [showTyping]);
  const navigationDisabled = !connected || busy || queued > 0 || session.changing;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => {
      setNarrow(media.matches);
      setSidebarVisible(!media.matches);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    setElapsed(0);
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      if (settingsSection) {
        if (event.key === 'Escape') window.location.hash = '';
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key === 'Escape') {
        if (detailsOpen) {
          setDetailsOpen(false);
          return;
        }
        if (narrow && sidebarVisible) {
          setSidebarVisible(false);
          return;
        }
        if (busy) void session.stop();
      }
      const target = event.target as HTMLElement;
      if (
        !payload?.pendingApproval ||
        /INPUT|TEXTAREA|SELECT/.test(target?.tagName) ||
        target?.isContentEditable ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      if (event.key === 'y') void session.approve('allow');
      if (event.key === 'a') void session.approve('always');
      if (event.key === 'n') void session.approve('deny');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsSection, detailsOpen, narrow, sidebarVisible, busy, payload?.pendingApproval, session.stop, session.approve]);

  const navigate = async (target?: string) => {
    if (await session.switchSession(target)) {
      setSearchOpen(false);
      setDetailsOpen(false);
      if (narrow) setSidebarVisible(false);
      requestAnimationFrame(() => composer.current?.focus());
    }
  };
  return (
    <div className={`app${sidebarVisible ? ' sidebar-visible' : ''}${narrow ? ' narrow' : ''}`}>
      {narrow && sidebarVisible ? (
        <button className="sidebar-backdrop" aria-label="Close conversations" onClick={() => setSidebarVisible(false)} />
      ) : null}
      <Sidebar
        inert={!!settingsSection}
        sessions={session.sessions}
        current={payload?.session}
        projects={projects.projects}
        selectedProjectId={projects.selectedId}
        projectSelectionDisabled={projects.selecting || (projects.locked && navigationDisabled)}
        projectsLoading={projects.loading}
        projectsError={projects.error}
        onSelectProject={(id) => {
          void projects.select(id);
        }}
        onCreateProject={() => setCreateProjectOpen(true)}
        onRetryProjects={projects.refresh}
        loading={session.sessionsLoading}
        error={session.sessionsError}
        disabled={navigationDisabled}
        disabledReason={busy || queued ? 'Finish or stop the current run before switching chats.' : undefined}
        onSearch={() => setSearchOpen(true)}
        onRetry={session.retrySessions}
        onNew={() => void navigate()}
        onSelect={(target) => void navigate(target)}
        onClose={() => setSidebarVisible(false)}
        onSettings={() => openSettings(DEFAULT_SETTINGS_SECTION)}
      />
      <div className="workspace-surface" inert={!!settingsSection}>
        <header className="topbar">
          <IconButton
            icon="panel-left"
            label="Toggle sidebar"
            aria-expanded={sidebarVisible}
            onClick={() => setSidebarVisible(!sidebarVisible)}
          />
          <span className="session-title">{session.changing ? 'Opening chat…' : payload?.session.title || 'Ranite'}</span>
          <span className="spacer" />
          <span className={`run-status${connected && !busy ? ' sr-only' : ''}`} role="status">
            {busy ? (
              <>
                <span className="pulse" />
                Working {formatDuration(elapsed)}
              </>
            ) : (
              <>
                <span className={`connection-dot ${connected ? 'online' : ''}`} />
                {connected ? 'Connected' : session.status === 'error' ? 'Reconnecting' : 'Connecting'}
              </>
            )}
          </span>
          {queued > 0 ? <span className="queued-count">{queued} queued</span> : null}
          <IconButton icon="info" label="Session details" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)} />
        </header>
        <main className={`conversation${turns.length === 0 ? ' conversation-empty' : ''}`} aria-busy={session.changing}>
          {turns.length ? (
            <VirtualList
              key={id}
              followRequest={session.followRequest}
              items={turns}
              getKey={(turn) => turn.id}
              estimate={180}
              hasOlder={session.base > 0}
              loadingOlder={session.loadingOlder}
              onLoadOlder={() => void session.loadOlder()}
              header={
                <div className="transcript-head">
                  {session.base > 0 ? (
                    <Button disabled={session.loadingOlder} onClick={() => void session.loadOlder()}>
                      {session.loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
                    </Button>
                  ) : null}
                </div>
              }
              render={(turn) => <TurnView turn={turn} live={turn.id === liveTurn} sessionId={id} />}
              footer={typingIndicator}
            />
          ) : null}
          <div className="action-dock">
            {session.notice ? (
              <div className="notice error" role="alert">
                <span>{session.notice}</span>
                <IconButton icon="x" label="Dismiss error" onClick={session.clearNotice} />
              </div>
            ) : null}
            {!connected ? (
              <div className="connection-notice" role="status">
                {session.status === 'error' ? 'Connection lost. Reconnecting to your workspace…' : 'Connecting to your workspace…'}
              </div>
            ) : null}
            <PendingActions
              key={payload?.pendingApproval?.id || payload?.pendingQuestion?.id || id}
              approval={payload?.pendingApproval}
              question={payload?.pendingQuestion}
              onApprove={session.approve}
              onAnswer={session.answer}
            />
            <Composer
              key={id}
              ref={composer}
              projectName={projects.selected?.name ?? undefined}
              context={
                !projects.locked && payload ? (
                  <ProjectContextBar
                    controller={projects}
                    onCreate={() => setCreateProjectOpen(true)}
                    onSettings={() => openSettings(DEFAULT_SETTINGS_SECTION)}
                  />
                ) : null
              }
              runtime={payload?.runtime}
              contextTokens={payload?.contextTokens}
              queuedMessages={payload?.queuedMessages}
              onQueueAction={session.manageQueue}
              models={session.models}
              pendingModel={session.pendingModel}
              draft={drafts[id] || ''}
              images={draftImages[id] || []}
              onImages={(images) => setDraftImages((previous) => ({ ...previous, [id]: images }))}
              busy={busy}
              disabled={!connected || session.changing || projects.selecting}
              changing={session.changing || queued > 0}
              empty={turns.length === 0 && connected}
              onDraft={(value) => setDrafts((previous) => ({ ...previous, [id]: value }))}
              onSend={async (text, images, reasoning) => {
                if (projects.loading || projects.error)
                  throw new Error('Project information is not ready yet. Try again from the project menu.');
                if (!projects.supportsSelection) throw new Error('Restart the Ranite server to enable the project scope.');
                await session.send(text, images, reasoning);
              }}
              onStop={() => void session.stop()}
              onModel={session.selectModel}
              onApprovalMode={session.selectApprovalMode}
              onDetails={() => setDetailsOpen(!detailsOpen)}
            />
          </div>
        </main>
      </div>
      {createProjectOpen ? <CreateProjectDialog controller={projects} onClose={closeCreateProject} /> : null}
      {settingsSection ? (
        <SettingsSessionProvider
          value={{
            models: session.models,
            runtime: payload?.runtime,
            busy,
            selectModel: (model) => void session.selectModel(model),
            selectApprovalMode: (mode) => session.selectApprovalMode(mode),
          }}
        >
          <SettingsView
            sections={SETTINGS_SECTIONS}
            active={settingsSection}
            onSelect={openSettings}
            onClose={() => {
              window.location.hash = '';
            }}
          />
        </SettingsSessionProvider>
      ) : null}
      {searchOpen ? (
        <SearchDialog
          sessions={session.sessions}
          disabled={navigationDisabled}
          onSelect={(target) => void navigate(target)}
          onClose={closeSearch}
        />
      ) : null}
      {detailsOpen ? <SessionDetails payload={payload} onClose={() => setDetailsOpen(false)} /> : null}
    </div>
  );
}
