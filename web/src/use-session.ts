import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialSessionState, sessionReducer } from './session-state.js';
import * as api from './api.js';
import type { ApprovalMode, DraftImage, ModelChoice, SessionInfo, SessionPayload } from './types.js';
import { materializeNewChat, newChatDraft, newChatPayload, type NewChatDraft } from './new-chat-draft.js';

/** The client-side id of a chat that exists only as a placeholder while the host creates it. */
export const PENDING_CHAT_ID = 'new-chat';

export function useSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    try {
      const id = sessionStorage.getItem('ranite:web-session');
      return id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  });
  const selected = useRef(selectedId);
  const streamEpoch = useRef(0);
  const hasSnapshot = useRef(false);
  const [status, setStatus] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(false);
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelsRevision, setModelsRevision] = useState(0);
  const [deferredModel, setDeferredModel] = useState<{ sessionId: string; model: ModelChoice } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  // A blank new chat exists only in the browser. Creating the daemon session
  // is deferred until the first actual message is sent.
  const draftChat = useRef<NewChatDraft | null>(null);
  const [pendingNewChatId, setPendingNewChatId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [followRequest, setFollowRequest] = useState(0);
  const operation = useRef(false);
  const olderRequest = useRef(false);
  const sessionId = state.payload?.session.id;
  const busy = state.payload?.busy ?? false;
  const applyNow = useCallback((payload: SessionPayload) => {
    if (selected.current && payload.session.id !== selected.current) return;
    hasSnapshot.current = true;
    dispatch({ type: 'payload', payload, receivedAt: performance.now() });
  }, []);
  // Stream patches arrive per token. Collecting them for one animation frame
  // keeps a phone from rendering dozens of times a second and falling behind.
  const queued = useRef<{ payload: SessionPayload; receivedAt: number }[]>([]);
  const frame = useRef<number | null>(null);
  const bind = useCallback((id: string) => {
    if (selected.current === id) return;
    streamEpoch.current++;
    queued.current.length = 0;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    selected.current = id;
    olderRequest.current = false;
    setLoadingOlder(false);
    setSelectedId(id);
    try {
      sessionStorage.setItem('ranite:web-session', id);
    } catch {
      /* Storage may be disabled. */
    }
  }, []);
  const apply = useCallback((payload: SessionPayload) => {
    if (selected.current && payload.session.id !== selected.current) return;
    hasSnapshot.current = true;
    queued.current.push({ payload, receivedAt: performance.now() });
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const batch = queued.current.splice(0);
      if (batch.length) dispatch({ type: 'payloads', payloads: batch });
    });
  }, []);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );
  // An open tab keeps the bundle it loaded, so a rebuild would reach the reader
  // only after a manual reload. Once the server reports a different build and
  // nothing is running, the page reloads itself.
  const loadedBuild = useRef<string | null>(null);
  useEffect(() => {
    const build = state.payload?.buildId ?? null;
    if (!build) return;
    if (loadedBuild.current === null) {
      loadedBuild.current = build;
      return;
    }
    if (loadedBuild.current !== build && !state.payload?.busy) window.location.reload();
  }, [state.payload?.buildId, state.payload?.busy]);

  useEffect(() => {
    const epoch = streamEpoch.current;
    let closed = false;
    setStatus('connecting');
    const stop = api.subscribe(
      (payload) => {
        if (closed || epoch !== streamEpoch.current) return;
        if (!selected.current || (!payload.runtime?.supportsSessionAttachments && payload.session.id !== selected.current))
          bind(payload.session.id);
        apply(payload);
      },
      (next) => {
        if (closed || epoch !== streamEpoch.current) return;
        setStatus(next);
        // Reconnects must also recover changes missed while the stream was offline.
        if (next === 'open') setModelsRevision((value) => value + 1);
        // A rebuilt stream is invisible to the server: it only sees a new
        // connection. Counting them here is how a "keeps dropping" report
        // becomes a number.
        if (next === 'error') api.reportClientEvent('stream-error');
      },
      selectedId,
      () => {
        if (!closed && epoch === streamEpoch.current) setReload((value) => value + 1);
      },
      () => {
        if (!closed && epoch === streamEpoch.current) setModelsRevision((value) => value + 1);
      },
    );
    return () => {
      closed = true;
      stop();
    };
  }, [apply, bind, selectedId]);

  // A patch that arrives after a lost one cannot be applied: the list would gain
  // a hole and every later update would land on the wrong entry. One snapshot
  // restores the tail, and queued patches from before it are dropped with it.
  // The gap is reported, because only the browser can see it happen.
  useEffect(() => {
    if (!state.behind || !state.gap) return;
    const gap = state.gap;
    api.reportClientEvent('stream-gap', gap);
    let cancelled = false;
    void api
      .fetchSnapshot(selectedId)
      .then((snapshot) => {
        if (cancelled) return;
        queued.current.length = 0;
        applyNow(snapshot);
        api.reportClientEvent('stream-resync', gap);
      })
      .catch(() => {
        /* The stream keeps trying; the next patch retries the resync. */
      });
    return () => {
      cancelled = true;
    };
  }, [state.behind, state.gap, applyNow, selectedId]);

  useEffect(() => {
    let cancelled = false;
    setSessionsLoading(true);
    setSessionsError(false);
    void api
      .fetchSessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        const id = selected.current;
        if (!hasSnapshot.current && id && !list.some((session) => session.id === id)) {
          void api
            .fetchSnapshot()
            .then((snapshot) => {
              if (!cancelled && !hasSnapshot.current && selected.current === id) {
                bind(snapshot.session.id);
                applyNow(snapshot);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) setSessionsError(true);
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, status, busy, reload, bind, applyNow]);

  useEffect(() => {
    if (status !== 'open') return;
    let cancelled = false;
    void api
      .fetchModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => {
        /* The current model remains visible if the catalog fails. */
      });
    return () => {
      cancelled = true;
    };
  }, [status, modelsRevision, state.payload?.runtime?.providerId, state.payload?.runtime?.modelId]);

  const report = useCallback((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)), []);
  const switchSession = async (id?: string, projectId?: string | null) => {
    if (operation.current || !sessionId || status !== 'open') return false;
    if (id === sessionId) return true;
    // Repeated New Chat clicks replace a transient blank draft, not create
    // additional sessions on the host.
    if (id === undefined) {
      const origin = draftChat.current?.sourceSessionId ?? sessionId;
      draftChat.current = newChatDraft(origin, projectId ?? null);
      selected.current = PENDING_CHAT_ID;
      setPendingNewChatId(PENDING_CHAT_ID);
      setNotice(null);
      dispatch({ type: 'payload', payload: newChatPayload(state.payload!, projectId ?? null), receivedAt: performance.now() });
      return true;
    }
    operation.current = true;
    setChanging(true);
    setNotice(null);
    if (id !== undefined) {
      try {
        const snapshot = draftChat.current ? await api.fetchSnapshot(id) : await api.changeSession(sessionId, id, projectId);
        bind(snapshot.session.id);
        draftChat.current = null;
        setPendingNewChatId(null);
        applyNow(snapshot);
        return true;
      } catch (error) {
        report(error);
        return false;
      } finally {
        operation.current = false;
        setChanging(false);
      }
    }
  };
  const selectModel = async (model: ModelChoice) => {
    if (operation.current || !sessionId || status !== 'open') return false;
    if (draftChat.current && sessionId === PENDING_CHAT_ID && state.payload) {
      draftChat.current.model = model;
      dispatch({
        type: 'payload',
        payload: {
          ...state.payload,
          runtime: { ...state.payload.runtime, providerId: model.providerId, modelId: model.modelId, modelName: model.name },
        },
        receivedAt: performance.now(),
      });
      return true;
    }
    if (model.providerId === state.payload?.runtime?.providerId && model.modelId === state.payload?.runtime?.modelId) {
      setDeferredModel(null);
      return true;
    }
    if (busy || (state.payload?.queuedMessageCount ?? 0) > 0) {
      setDeferredModel({ sessionId, model });
      return true;
    }
    setDeferredModel(null);
    operation.current = true;
    setChanging(true);
    setNotice(null);
    try {
      applyNow(await api.changeModel(model, sessionId));
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      operation.current = false;
      setChanging(false);
    }
  };
  useEffect(() => {
    if (!deferredModel) return;
    if (deferredModel.sessionId !== sessionId) {
      setDeferredModel(null);
      return;
    }
    if (!busy && (state.payload?.queuedMessageCount ?? 0) === 0 && !changing && status === 'open' && !operation.current)
      void selectModel(deferredModel.model);
  }, [deferredModel, sessionId, busy, state.payload?.queuedMessageCount, changing, status]);
  const loadOlder = async () => {
    if (!sessionId || olderRequest.current || state.base <= 0) return;
    const epoch = streamEpoch.current;
    olderRequest.current = true;
    setLoadingOlder(true);
    try {
      const page = await api.fetchOlder(state.base, sessionId);
      dispatch({ type: 'older', sessionId: page.sessionId, before: state.base, from: page.from, entries: page.entries });
    } catch (error) {
      if (epoch === streamEpoch.current) report(error);
    } finally {
      if (epoch === streamEpoch.current) {
        olderRequest.current = false;
        setLoadingOlder(false);
      }
    }
  };
  const selectApprovalMode = async (mode: ApprovalMode) => {
    if (!sessionId || status !== 'open') throw new Error('Wait for the connection.');
    if (draftChat.current && sessionId === PENDING_CHAT_ID && state.payload) {
      draftChat.current.approvalMode = mode;
      dispatch({
        type: 'payload',
        payload: {
          ...state.payload,
          runtime: { ...state.payload.runtime, approvalMode: mode },
        },
        receivedAt: performance.now(),
      });
      return;
    }
    applyNow(await api.changeApprovalMode(mode, sessionId));
  };
  const selectProject = async (projectId: string | null) => {
    if (!sessionId || status !== 'open' || operation.current) throw new Error('The chat is not ready yet.');
    if (draftChat.current && sessionId === PENDING_CHAT_ID && state.payload) {
      draftChat.current.projectId = projectId;
      dispatch({
        type: 'payload',
        payload: {
          ...state.payload,
          session: newChatPayload(state.payload, projectId).session,
        },
        receivedAt: performance.now(),
      });
      return;
    }
    operation.current = true;
    try {
      applyNow(await api.changeSessionProject(sessionId, projectId));
    } catch (error) {
      report(error);
      throw error;
    } finally {
      operation.current = false;
    }
  };
  const send = async (text: string, images: DraftImage[] = [], reasoningVariantId?: string) => {
    const draft = draftChat.current;
    if (!sessionId || status !== 'open' || (operation.current && !draft?.creation)) throw new Error('Wait until the chat is connected.');
    let target = sessionId;
    if (draft && sessionId === PENDING_CHAT_ID) {
      operation.current = true;
      setChanging(true);
      try {
        let snapshot = await materializeNewChat(draft, (origin, project) => api.changeSession(origin, undefined, project));
        target = snapshot.session.id;
        if (draft.model && (draft.model.providerId !== snapshot.runtime?.providerId || draft.model.modelId !== snapshot.runtime?.modelId))
          snapshot = await api.changeModel(draft.model, target);
        if (draft.approvalMode && draft.approvalMode !== snapshot.runtime?.approvalMode)
          snapshot = await api.changeApprovalMode(draft.approvalMode, target);
        bind(target);
        applyNow(snapshot);
        draftChat.current = null;
        setPendingNewChatId(null);
      } finally {
        operation.current = false;
        setChanging(false);
      }
    }
    await api.sendMessage(text, target, images, reasoningVariantId);
    // Only a successful send requests the tail. Paging in an older user message
    // or reconnecting the stream must not steal the reader's position.
    setFollowRequest((value) => value + 1);
  };
  const manageQueue = async (messageId: string, action: 'steer' | 'remove') => {
    if (!sessionId || status !== 'open') throw new Error('Wait for the connection.');
    await api.manageQueuedMessage(sessionId, messageId, action);
  };
  const stop = useCallback(async () => {
    if (!sessionId) return;
    try {
      await api.stopRun(sessionId);
    } catch (error) {
      report(error);
    }
  }, [report, sessionId]);
  const approve = useCallback(
    async (decision: 'allow' | 'deny' | 'always') => {
      if (!sessionId) return;
      try {
        await api.decideApproval(decision, sessionId, state.payload?.pendingApproval?.id);
      } catch (error) {
        report(error);
      }
    },
    [state.payload?.pendingApproval?.id, report, sessionId],
  );
  const answer = async (value: string | null) => {
    if (!sessionId) return;
    try {
      await api.answerQuestion(value, sessionId, state.payload?.pendingQuestion?.id);
    } catch (error) {
      report(error);
    }
  };
  return {
    ...state,
    status,
    sessions,
    sessionsLoading,
    sessionsError,
    retrySessions: () => setReload((value) => value + 1),
    models,
    modelsRevision,
    pendingModel: deferredModel && deferredModel.sessionId === sessionId ? deferredModel.model : null,
    notice,
    clearNotice: () => setNotice(null),
    changing,
    pendingNewChatId,
    loadingOlder,
    followRequest,
    switchSession,
    selectModel,
    selectProject,
    selectApprovalMode,
    loadOlder,
    send,
    manageQueue,
    stop,
    approve,
    answer,
  };
}
export type SessionController = ReturnType<typeof useSession>;
