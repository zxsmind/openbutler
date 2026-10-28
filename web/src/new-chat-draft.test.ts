import { describe, expect, it, vi } from 'vitest';
import { materializeNewChat, newChatDraft, newChatPayload } from './new-chat-draft.js';
import type { SessionPayload } from './types.js';

function snapshot(id: string): SessionPayload {
  return {
    reset: true,
    entries: [],
    updated: [],
    from: 0,
    totalEntries: 0,
    busy: false,
    runningTurnId: null,
    queuedMessageCount: 0,
    pendingApproval: null,
    pendingQuestion: null,
    runtime: { providerId: 'vercel', modelId: 'default', workspaceRoot: 'C:/project' },
    session: { id, title: 'Chat', hasUserMessage: false },
  };
}

describe('new chat draft lifecycle', () => {
  it('clicking New Chat repeatedly never invokes a daemon session creation', () => {
    const create = vi.fn(async () => snapshot('created'));
    let draft = newChatDraft('real-session', null);
    let view = newChatPayload(snapshot('real-session'), null);
    for (let i = 0; i < 7; i++) {
      draft = newChatDraft(draft.sourceSessionId, null);
      view = newChatPayload(view, null);
      expect(view.session.id).toBe('new-chat');
      expect(view.entries).toEqual([]);
      expect(draft.sourceSessionId).toBe('real-session');
      expect(draft.creation).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('materializes only on first send, preserving the draft project', async () => {
    const draft = newChatDraft('source', 'project-1');
    const create = vi.fn(async (source: string, project: string | null) => snapshot(source + '/' + project));
    const view = newChatPayload(snapshot('source'), 'project-1');
    expect(view.session.project?.id).toBe('project-1');
    expect(create).not.toHaveBeenCalled();
    const first = materializeNewChat(draft, create);
    const second = materializeNewChat(draft, create);
    expect(first).toBe(second);
    expect((await first).session.id).toBe('source/project-1');
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith('source', 'project-1');
  });

  it('retries a failed materialization instead of permanently locking the draft', async () => {
    const draft = newChatDraft('source', null);
    const create = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce(snapshot('created'));
    await expect(materializeNewChat(draft, create)).rejects.toThrow('disconnected');
    expect(draft.creation).toBeNull();
    expect((await materializeNewChat(draft, create)).session.id).toBe('created');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('keeps choosing project or model entirely local until the draft is sent', () => {
    const draft = newChatDraft('source', null);
    draft.projectId = 'updated-project';
    draft.model = { providerId: 'provider', providerName: 'provider', modelId: 'model', name: 'Model' };
    draft.approvalMode = 'auto-review';
    expect(draft.creation).toBeNull();
    expect(newChatPayload(snapshot('source'), draft.projectId).session.project?.id).toBe('updated-project');
  });
});
