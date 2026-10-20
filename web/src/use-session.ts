import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { sessionReducer } from './session-state.js';
import * as api from './api.js';
import type { DraftImage, ModelChoice, SessionInfo, SessionPayload } from './types.js';

export function useSession() {
  const [state, dispatch] = useReducer(sessionReducer, { payload: null, entries: [], base: 0 });
  const [status, setStatus] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(false);
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const operation = useRef(false);
  const olderRequest = useRef(false);
  const sessionId = state.payload?.session.id;
  const busy = state.payload?.busy ?? false;
  const apply = useCallback((payload: SessionPayload) => dispatch({ type: 'payload', payload }), []);
  useEffect(() => api.subscribe(apply, setStatus), [apply]);

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
  const switchSession = async (id?: string) => {
    if (operation.current || !sessionId || status !== 'open' || busy || (state.payload?.queuedMessageCount ?? 0) > 0) return false;
    if (id === sessionId) return true;
    operation.current = true;
    setChanging(true);
    setNotice(null);
    try {
      apply(await api.changeSession(sessionId, id));
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
    if (operation.current || !sessionId || busy) return;
    operation.current = true;
    setChanging(true);
    setNotice(null);
    try {
      apply(await api.changeModel(model, sessionId));
    } catch (error) {
      report(error);
    } finally {
      operation.current = false;
      setChanging(false);
    }
  };
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
  const send = async (text: string, images: DraftImage[] = [], reasoningVariantId?: string) => {
    if (!sessionId || status !== 'open' || operation.current) throw new Error('Wait until the chat is connected.');
    await api.sendMessage(text, sessionId, images, reasoningVariantId);
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
    notice,
    clearNotice: () => setNotice(null),
    changing,
    loadingOlder,
    switchSession,
    selectModel,
    loadOlder,
    send,
    stop,
    approve,
    answer,
  };
}
export type SessionController = ReturnType<typeof useSession>;
