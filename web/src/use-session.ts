import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialSessionState, sessionReducer } from './session-state.js';
import * as api from './api.js';
import type { ApprovalMode, DraftImage, ModelChoice, SessionInfo, SessionPayload } from './types.js';

export function useSession() {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [status, setStatus] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(false);
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [deferredModel, setDeferredModel] = useState<{ sessionId: string; model: ModelChoice } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [followRequest, setFollowRequest] = useState(0);
  const operation = useRef(false);
  const olderRequest = useRef(false);
  const sessionId = state.payload?.session.id;
  const busy = state.payload?.busy ?? false;
  const applyNow = useCallback((payload: SessionPayload) => dispatch({ type: 'payload', payload }), []);
  // Stream patches arrive per token. Collecting them for one animation frame
  // keeps a phone from rendering dozens of times a second and falling behind.
  const queued = useRef<SessionPayload[]>([]);
  const frame = useRef<number | null>(null);
  const apply = useCallback((payload: SessionPayload) => {
    queued.current.push(payload);
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

  useEffect(
    () =>
      api.subscribe(apply, (next) => {
        setStatus(next);
        // A rebuilt stream is invisible to the server: it only sees a new
        // connection. Counting them here is how a "keeps dropping" report
        // becomes a number.
        if (next === 'error') api.reportClientEvent('stream-error');
      }),
    [apply],
  );

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
      .fetchSnapshot()
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
  }, [state.behind, state.gap, applyNow]);

  useEffect(() => {
    if (status !== 'open') return;
    let cancelled = false;
    setSessionsLoading(true);
    setSessionsError(false);
    void api
      .fetchSessions()
      .then((list) => {
        if (!cancelled) setSessions(list);
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
  }, [sessionId, status, busy, reload]);

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
  }, [status]);

  const report = useCallback((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)), []);
  const switchSession = async (id?: string, projectId?: string | null) => {
    if (operation.current || !sessionId || status !== 'open' || busy || (state.payload?.queuedMessageCount ?? 0) > 0) return false;
    if (id === sessionId) return true;
    operation.current = true;
    setChanging(true);
    setNotice(null);
    try {
      applyNow(await api.changeSession(sessionId, id, projectId));
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      operation.current = false;
      setChanging(false);
    }
  };
  const selectModel = async (model: ModelChoice) => {
    if (operation.current || !sessionId || status !== 'open') return false;
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
    olderRequest.current = true;
    setLoadingOlder(true);
    try {
      const page = await api.fetchOlder(state.base, sessionId);
      dispatch({ type: 'older', sessionId: page.sessionId, before: state.base, from: page.from, entries: page.entries });
    } catch (error) {
      report(error);
    } finally {
      olderRequest.current = false;
      setLoadingOlder(false);
    }
  };
  const selectApprovalMode = async (mode: ApprovalMode) => {
    if (!sessionId || status !== 'open') throw new Error('Wait for the connection.');
    applyNow(await api.changeApprovalMode(mode, sessionId));
  };
  const selectProject = async (projectId: string | null) => {
    if (!sessionId || status !== 'open' || operation.current) throw new Error('The chat is not ready yet.');
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
    if (!sessionId || status !== 'open' || operation.current) throw new Error('Wait until the chat is connected.');
    await api.sendMessage(text, sessionId, images, reasoningVariantId);
    // Only a successful send requests the tail. Paging in an older user message
    // or reconnecting the stream must not steal the reader's position.
    setFollowRequest((value) => value + 1);
  };
  const manageQueue = async (messageId: string, action: 'steer' | 'remove') => {
    if (!sessionId || status !== 'open') throw new Error('Wait for the connection.');
    await api.manageQueuedMessage(sessionId, messageId, action);
  };
  const stop = useCallback(async () => {
    try {
      await api.stopRun();
    } catch (error) {
      report(error);
    }
  }, [report]);
  const approve = useCallback(
    async (decision: 'allow' | 'deny' | 'always') => {
      try {
        await api.decideApproval(decision, state.payload?.pendingApproval?.id);
      } catch (error) {
        report(error);
      }
    },
    [state.payload?.pendingApproval?.id, report],
  );
  const answer = async (value: string | null) => {
    try {
      await api.answerQuestion(value, state.payload?.pendingQuestion?.id);
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
    pendingModel: deferredModel && deferredModel.sessionId === sessionId ? deferredModel.model : null,
    notice,
    clearNotice: () => setNotice(null),
    changing,
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
