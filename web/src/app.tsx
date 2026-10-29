import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DraftImage } from './types.js';
import { PENDING_CHAT_ID, useSession } from './use-session.js';
import { useProjects } from './projects/use-projects.js';
import { ProjectContextBar } from './projects/project-selector.js';
import { CreateProjectDialog } from './projects/create-project-dialog.js';
import { awaitingFirstChunk, buildTurns } from './turns.js';
import { TurnView } from './turn.js';
import { TypingIndicator } from './components/typing-indicator.js';
import { VirtualList } from './virtual.js';
import { SearchDialog } from './components/search-dialog.js';
import { Sidebar } from './components/sidebar.js';
import { SettingsView } from './components/settings/settings-page.js';
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS } from './components/settings/sections/index.js';
import { SettingsSessionProvider } from './components/settings/settings-session.js';
import { Composer } from './components/composer.js';
import { ConversationWelcome } from './components/conversation-welcome.js';
import { PendingActions } from './components/pending-actions.js';
import { SessionDetails } from './components/session-details.js';
import { IconButton } from './components/ui.js';
import { readDrafts, saveDraft } from './composer-state.js';
import { WorkspacePanels } from './components/workspace-panels.js';
import { Feedback } from './components/feedback.js';
import { useEdgeResize } from './edge-resize.js';
import {
  SIDEBAR_CHAT_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  resolveSidebarResize,
} from './panel-resize.js';

const sidebarStorageKey = 'ranite:sidebar-width:v1';

function readSidebarWidth(): number {
  try {
    const value = JSON.parse(localStorage.getItem(sidebarStorageKey) || '{}');
    return Number.isFinite(value.width) && value.width > 0 ? value.width : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function App() {
  const session = useSession();
  // Where the placeholder chat's text came from; set when a new chat starts
  // and consumed once the host answers it.
  const placeholderRef = useRef<{ key: string; previousId: string } | null>(null);
  const projects = useProjects(
    session.payload?.session,
    async (projectId) => {
      if (session.payload?.session.projectLocked) {
        const from = session.payload?.session.id;
        if (!(await session.switchSession(undefined, projectId))) throw new Error('A new chat could not be opened in this project.');
        if (from) placeholderRef.current = { key: PENDING_CHAT_ID, previousId: from };
      } else await session.selectProject(projectId);
    },
    !session.payload?.busy && (session.payload?.queuedMessageCount ?? 0) === 0,
  );
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const closeCreateProject = useCallback(() => setCreateProjectOpen(false), []);
  const [sidebarVisible, setSidebarVisible] = useState(() => window.matchMedia('(min-width: 761px)').matches);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
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
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      return readDrafts(window.localStorage);
    } catch {
      return {};
    }
  });
  const composer = useRef<HTMLTextAreaElement>(null);
  const payload = session.payload;
  const id = payload?.session.id ?? '';
  const busy = payload?.busy ?? false;
  const queued = payload?.queuedMessageCount ?? 0;
  const connected = session.status === 'open' && !!payload;
  const turns = useMemo(() => buildTurns(session.entries, session.base), [session.entries, session.base]);
  const messageHistory = useMemo(
    () => [
      ...session.entries.filter((entry) => entry.kind === 'user' && !entry.internal && entry.text?.trim()).map((entry) => entry.text!),
      ...(payload?.queuedMessages ?? []).filter((message) => message.text.trim()).map((message) => message.text),
    ],
    [session.entries, payload?.queuedMessages],
  );
  // The host names the turn its run is writing into; a run is marked busy
  // before its message reaches the transcript, so the previous turn must not
  // be inferred live from `busy` and list position.
  const liveTurn = payload?.runningTurnId ?? undefined;
  // The dot is a "your message was taken, nothing has come back yet" signal, not a
  // running indicator: it appears after a send and leaves on the first chunk, so
  // it never sits under the transcript while the agent works.
  const showTyping = awaitingFirstChunk(turns, liveTurn);
  const typingIndicator = useMemo(() => (showTyping ? <TypingIndicator /> : null), [showTyping]);
  const independentChats = payload?.runtime?.supportsSessionAttachments === true;
  const navigationDisabled = !connected || session.changing || (!independentChats && (busy || queued > 0));
  // Text typed into the placeholder belongs to the real chat once the host
  // answers: it is carried over in memory only, so no storage key ever exists
  // for a placeholder. A failed create keeps it under the placeholder key for
  // the retry.
  useEffect(() => {
    if (session.pendingNewChatId || !placeholderRef.current) return;
    const placeholder = placeholderRef.current;
    placeholderRef.current = null;
    if (!id || id === placeholder.previousId) return;
    const draft = drafts[placeholder.key];
    const images = draftImages[placeholder.key];
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[placeholder.key];
      return draft ? { ...next, [id]: draft } : next;
    });
    setDraftImages((previous) => {
      const next = { ...previous };
      delete next[placeholder.key];
      return images ? { ...next, [id]: images } : next;
    });
  }, [session.pendingNewChatId, id, drafts, draftImages]);

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
    const onViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onViewport);
    return () => window.removeEventListener('resize', onViewport);
  }, []);
  // The conversation keeps SIDEBAR_CHAT_MIN_WIDTH beside the sidebar, so the cap
  // follows the viewport instead of a fixed number alone.
  const sidebarMaximum = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - SIDEBAR_CHAT_MIN_WIDTH));
  const activeSidebarWidth = Math.min(sidebarMaximum, Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth));
  const sidebarEdge = useEdgeResize({
    direction: 1,
    width: activeSidebarWidth,
    getMaximum: () => sidebarMaximum,
    resolve: (initial, distance, available) => ({ size: resolveSidebarResize(initial, distance, available) }),
    onResize: (size) => setSidebarWidth(size),
  });
  // The width survives reloads; a drag only writes once the pointer lets go.
  useEffect(() => {
    if (sidebarEdge.dragging) return;
    try {
      localStorage.setItem(sidebarStorageKey, JSON.stringify({ width: sidebarWidth }));
    } catch {
      /* Private browsing can disable storage. */
    }
  }, [sidebarWidth, sidebarEdge.dragging]);
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
    const from = id;
    if (await session.switchSession(target)) {
      if (target === undefined) {
        // Each New Chat is a fresh in-browser draft, never a persisted chat.
        setDrafts((previous) => {
          const next = { ...previous };
          delete next[PENDING_CHAT_ID];
          return next;
        });
        setDraftImages((previous) => {
          const next = { ...previous };
          delete next[PENDING_CHAT_ID];
          return next;
        });
        // Repeated New Chat clicks preserve the original backing chat for handoff.
        if (from && from !== PENDING_CHAT_ID) placeholderRef.current = { key: PENDING_CHAT_ID, previousId: from };
      } else if (from === PENDING_CHAT_ID) {
        // Discard the unsent draft when returning to an existing chat.
        placeholderRef.current = null;
      }
      setSearchOpen(false);
      setDetailsOpen(false);
      if (narrow) setSidebarVisible(false);
      requestAnimationFrame(() => composer.current?.focus());
    }
  };
  return (
    <div
      className={`app${sidebarVisible ? ' sidebar-visible' : ''}${narrow ? ' narrow' : ''}${
        sidebarEdge.dragging ? ' is-resizing sidebar-resizing' : ''
      }`}
      style={{ '--ui-sidebar-width': `${activeSidebarWidth}px` } as CSSProperties}
    >
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
        disabledReason={
          session.changing ? 'Opening chat…' : !independentChats && busy ? 'Restart Ranite to enable independent chats.' : undefined
        }
        onSearch={() => setSearchOpen(true)}
        onRetry={session.retrySessions}
        onNew={() => void navigate()}
        onSelect={(target) => void navigate(target)}
        onClose={() => setSidebarVisible(false)}
        onSettings={() => openSettings(DEFAULT_SETTINGS_SECTION)}
      />
      {sidebarVisible && !narrow && !settingsSection ? (
        <div
          role="separator"
          tabIndex={0}
          className="sidebar-resizer"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-controls="sidebar-nav"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={Math.round(sidebarMaximum)}
          aria-valuenow={Math.round(activeSidebarWidth)}
          aria-valuetext={`${Math.round(activeSidebarWidth)} pixels`}
          title="Drag to resize sidebar"
          onPointerDown={sidebarEdge.start}
          onPointerMove={sidebarEdge.move}
          onPointerUp={sidebarEdge.finish}
          onPointerCancel={sidebarEdge.finish}
          onLostPointerCapture={sidebarEdge.finish}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const distance =
              event.key === 'Home'
                ? SIDEBAR_DEFAULT_WIDTH - activeSidebarWidth
                : event.key === 'End'
                  ? sidebarMaximum - activeSidebarWidth
                  : event.key === 'ArrowRight'
                    ? 32
                    : -32;
            setSidebarWidth(resolveSidebarResize(activeSidebarWidth, distance, sidebarMaximum));
          }}
        />
      ) : null}
      <div className="workspace-surface" inert={!!settingsSection}>
        <WorkspacePanels
          sessionId={session.pendingNewChatId && placeholderRef.current ? placeholderRef.current.previousId : id}
          chatTitle={payload?.session.title || 'Chat'}
        >
          {({ panelOpen, togglePanel }) => (
            <>
              <header className="topbar">
                <IconButton
                  icon="panel-left"
                  label="Toggle sidebar"
                  aria-expanded={sidebarVisible}
                  onClick={() => setSidebarVisible(!sidebarVisible)}
                />
                <span className="session-title">{payload?.session.title || 'Ranite'}</span>
                <span className="spacer" />
                <span className={`run-status${connected ? ' sr-only' : ''}`} role="status">
                  <span className={`connection-dot ${connected ? 'online' : ''}`} />
                  {connected ? 'Connected' : session.status === 'error' ? 'Reconnecting' : 'Connecting'}
                </span>
                <IconButton icon="info" label="Session details" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)} />
                <IconButton
                  icon={panelOpen ? 'panel-right-close' : 'panel-right'}
                  label={panelOpen ? 'Close right panel' : 'Open right panel'}
                  aria-expanded={panelOpen}
                  aria-controls="workspace-panel-right"
                  onClick={togglePanel}
                />
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
                    header={session.loadingOlder ? <div className="transcript-head">Loading earlier messages…</div> : null}
                    render={(turn) => <TurnView turn={turn} live={turn.id === liveTurn} sessionId={id} runtime={payload?.runtime} />}
                    footer={typingIndicator}
                  />
                ) : null}
                {turns.length === 0 && connected ? <ConversationWelcome projectName={projects.selected?.name ?? undefined} /> : null}
                <div className="action-dock">
                  {session.notice ? (
                    <Feedback tone="error" onDismiss={session.clearNotice}>
                      {session.notice}
                    </Feedback>
                  ) : null}
                  {!connected ? (
                    <Feedback tone={session.status === 'error' ? 'warning' : 'loading'}>
                      {session.status === 'error' ? 'Connection lost. Reconnecting to your workspace…' : 'Connecting to your workspace…'}
                    </Feedback>
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
                    contextTokens={
                      (payload?.session.hasUserMessage ?? turns.some((turn) => turn.user !== null)) ? payload?.contextTokens : undefined
                    }
                    queuedMessages={payload?.queuedMessages}
                    onQueueAction={session.manageQueue}
                    models={session.models}
                    pendingModel={session.pendingModel}
                    draft={drafts[id] || ''}
                    history={messageHistory}
                    images={draftImages[id] || []}
                    onImages={(images) => setDraftImages((previous) => ({ ...previous, [id]: images }))}
                    busy={busy}
                    disabled={!connected || projects.selecting}
                    modelChanging={session.changing && session.pendingNewChatId === null}
                    changing={session.changing || queued > 0}
                    onDraft={(value) => {
                      setDrafts((previous) => ({ ...previous, [id]: value }));
                      // The placeholder chat has no persisted draft: storage stays
                      // the host/client contract for real sessions only.
                      if (session.pendingNewChatId) return;
                      try {
                        saveDraft(window.localStorage, id, value);
                      } catch {
                        // Accessing localStorage itself can be blocked by the browser.
                      }
                    }}
                    onSend={async (text, images, reasoning) => {
                      if (projects.loading || projects.error)
                        throw new Error('Project information is not ready yet. Try again from the project menu.');
                      if (!projects.supportsSelection) throw new Error('Restart the Ranite server to enable the project scope.');
                      await session.send(text, images, reasoning);
                    }}
                    onStop={() => void session.stop()}
                    onModel={session.selectModel}
                    onReasoning={session.saveReasoning}
                    onApprovalMode={session.selectApprovalMode}
                    onDetails={() => setDetailsOpen(!detailsOpen)}
                  />
                </div>
              </main>
            </>
          )}
        </WorkspacePanels>
      </div>
      {createProjectOpen ? <CreateProjectDialog controller={projects} onClose={closeCreateProject} /> : null}
      {settingsSection ? (
        <SettingsSessionProvider
          value={{
            models: session.models,
            modelsRevision: session.modelsRevision,
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
