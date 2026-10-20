import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DraftImage } from './types.js';
import { useSession } from './use-session.js';
import { buildTurns, formatDuration } from './turns.js';
import { TurnView } from './turn.js';
import { VirtualList } from './virtual.js';
import { SearchDialog } from './components/search-dialog.js';
import { Sidebar } from './components/sidebar.js';
import { Composer } from './components/composer.js';
import { PendingActions } from './components/pending-actions.js';
import { SessionDetails } from './components/session-details.js';
import { Button, IconButton } from './components/ui.js';

export function App() {
  const session = useSession();
  const [sidebarVisible, setSidebarVisible] = useState(() => window.matchMedia('(min-width: 761px)').matches);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
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
  const workspace = payload?.runtime?.workspaceRoot?.split(/[\\/]/).pop() || 'your workspace';
  const turns = useMemo(() => buildTurns(session.entries, session.base), [session.entries, session.base]);
  const liveTurn = busy ? turns[turns.length - 1]?.id : undefined;
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
  }, [detailsOpen, narrow, sidebarVisible, busy, payload?.pendingApproval, session.stop, session.approve]);

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
      <nav className="nav-strip" aria-label="Workspace navigation">
        <IconButton
          icon="home"
          label="New chat"
          className={turns.length === 0 ? 'active' : ''}
          disabled={navigationDisabled}
          onClick={() => void navigate()}
        />
        <IconButton
          icon="chat"
          label="Toggle conversations"
          aria-expanded={sidebarVisible}
          onClick={() => setSidebarVisible(!sidebarVisible)}
        />
        <IconButton
          icon="search"
          label="Search conversations"
          onClick={() => {
            setSearchOpen(true);
          }}
        />
        <span className="nav-divider" />
        <IconButton icon="info" label="Session information" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)} />
        <span className="spacer" />
        <span className={`connection-dot ${connected ? 'online' : ''}`} title={connected ? 'Connected' : 'Disconnected'} />
      </nav>
      {narrow && sidebarVisible ? (
        <button className="sidebar-backdrop" aria-label="Close conversations" onClick={() => setSidebarVisible(false)} />
      ) : null}
      <Sidebar
        sessions={session.sessions}
        current={payload?.session}
        workspace={workspace}
        loading={session.sessionsLoading}
        error={session.sessionsError}
        disabled={navigationDisabled}
        disabledReason={busy || queued ? 'Finish or stop the current run before switching chats.' : undefined}
        onSearch={() => setSearchOpen(true)}
        workspacePath={payload?.runtime?.workspaceRoot}
        onRetry={session.retrySessions}
        onNew={() => void navigate()}
        onSelect={(target) => void navigate(target)}
        onClose={() => setSidebarVisible(false)}
        onDetails={() => setDetailsOpen(!detailsOpen)}
      />
      <div className="workspace-surface">
        <header className="topbar">
          <IconButton
            icon={narrow ? 'sidebar' : 'folder'}
            label={narrow ? 'Toggle sidebar' : 'Workspace information'}
            aria-expanded={narrow ? sidebarVisible : detailsOpen}
            onClick={() => (narrow ? setSidebarVisible(!sidebarVisible) : setDetailsOpen(!detailsOpen))}
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
              render={(turn) => <TurnView turn={turn} live={turn.id === liveTurn} />}
            />
          ) : null}
          <div className="action-dock">
            {session.notice ? (
              <div className="notice error" role="alert">
                <span>{session.notice}</span>
                <IconButton icon="close" label="Dismiss error" onClick={session.clearNotice} />
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
              workspace={workspace}
              runtime={payload?.runtime}
              models={session.models}
              draft={drafts[id] || ''}
              images={draftImages[id] || []}
              onImages={(images) => setDraftImages((previous) => ({ ...previous, [id]: images }))}
              busy={busy}
              disabled={!connected || session.changing}
              changing={session.changing || queued > 0}
              empty={turns.length === 0 && connected}
              onDraft={(value) => setDrafts((previous) => ({ ...previous, [id]: value }))}
              onSend={session.send}
              onStop={() => void session.stop()}
              onModel={(model) => void session.selectModel(model)}
              onDetails={() => setDetailsOpen(!detailsOpen)}
            />
          </div>
        </main>
      </div>
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
