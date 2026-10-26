import type { AgentSessionClient } from '../agent-session.js';
import { connectDaemonSession } from '../daemon-client.js';
import type { SessionSummary } from '../session-store.js';

type Connection = { client: AgentSessionClient; unsubscribe: () => void; views: number; touched: number; signature: string };

export class SessionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Web views select connections; they never replace a running controller's chat. */
export class WebSessions {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Promise<AgentSessionClient>>();
  private readonly listeners = new Set<(id: string, client: AgentSessionClient, catalogChanged: boolean) => void>();
  private closed = false;
  private opening = 0;

  constructor(
    readonly defaultClient: AgentSessionClient,
    private readonly workspaceRoot: string,
  ) {
    this.remember(defaultClient);
  }

  subscribe(listener: (id: string, client: AgentSessionClient, catalogChanged: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private remember(client: AgentSessionClient): AgentSessionClient {
    if (this.closed) {
      void client.close();
      throw new Error('The web server is shutting down.');
    }
    const id = client.getSnapshot().session.id;
    const signature = () => {
      const snapshot = client.getSnapshot();
      return JSON.stringify([snapshot.session.id, snapshot.session.title, snapshot.busy, snapshot.queuedMessageCount]);
    };
    const connection: Connection = { client, views: 0, touched: Date.now(), signature: signature(), unsubscribe: () => {} };
    connection.unsubscribe = client.subscribe(() => {
      const next = signature();
      const catalogChanged = next !== connection.signature;
      connection.signature = next;
      for (const listener of this.listeners) listener(id, client, catalogChanged);
    });
    this.connections.set(id, connection);
    for (const listener of this.listeners) listener(id, client, true);
    return client;
  }

  private makeRoom(): void {
    if (this.connections.size + this.opening < 32) return;
    const candidate = [...this.connections]
      .filter(([, value]) => value.client !== this.defaultClient && !value.views && !value.client.isBusy)
      .sort((a, b) => a[1].touched - b[1].touched)[0];
    if (!candidate) throw new Error('Too many chats are open. Close an idle chat window before opening another.');
    this.connections.delete(candidate[0]);
    candidate[1].unsubscribe();
    void candidate[1].client.close();
  }

  async get(id = this.defaultClient.getSnapshot().session.id): Promise<AgentSessionClient> {
    if (this.closed) throw new SessionRequestError(503, 'The web server is shutting down.');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new SessionRequestError(400, 'Invalid chat ID.');
    const existing = this.connections.get(id);
    if (existing && existing.client.getSnapshot().session.id === id) {
      existing.touched = Date.now();
      return existing.client;
    }
    if (existing) {
      existing.unsubscribe();
      this.connections.delete(id);
      if (existing.client !== this.defaultClient) void existing.client.close();
    }
    if (id === this.defaultClient.getSnapshot().session.id) return this.remember(this.defaultClient);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const opening = (async () => {
      if (!(await this.defaultClient.listSessions()).some((session) => session.id === id))
        throw new SessionRequestError(404, 'Chat not found.');
      this.makeRoom();
      this.opening++;
      try {
        return this.remember(await connectDaemonSession(this.workspaceRoot, { clientKind: 'web', chatSessionId: id }));
      } finally {
        this.opening--;
      }
    })();
    this.pending.set(id, opening);
    try {
      return await opening;
    } finally {
      if (this.pending.get(id) === opening) this.pending.delete(id);
    }
  }

  async create(projectId: string | null): Promise<AgentSessionClient> {
    this.makeRoom();
    this.opening++;
    try {
      const client = await connectDaemonSession(this.workspaceRoot, { clientKind: 'web', newChatSession: true, projectId });
      if (client.getSnapshot().session.id === this.defaultClient.getSnapshot().session.id) {
        void client.close();
        throw new Error('The host did not open a new chat.');
      }
      return this.remember(client);
    } finally {
      this.opening--;
    }
  }

  retain(id: string): () => void {
    const connection = this.connections.get(id);
    if (connection) connection.views++;
    return () => {
      if (connection) {
        connection.views--;
        connection.touched = Date.now();
      }
    };
  }

  async list(): Promise<Array<SessionSummary & { running: boolean }>> {
    const saved = new Map(
      (await this.defaultClient.listSessions()).map((session) => [
        session.id,
        { ...session, updatedAt: session.updatedAt ?? '', running: session.running ?? false },
      ]),
    );
    for (const [id, connection] of this.connections) {
      const snapshot = connection.client.getSnapshot();
      if (snapshot.session.id !== id) continue;
      const previous = saved.get(id);
      saved.set(id, {
        ...(previous ?? {
          id,
          preview: '',
          updatedAt: new Date(connection.touched).toISOString(),
          providerId: connection.client.runtime.providerId,
          modelId: connection.client.runtime.modelId,
        }),
        title: snapshot.session.title,
        running: snapshot.busy,
        ...(snapshot.session.project ? { project: snapshot.session.project } : {}),
      });
    }
    return [...saved.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
    const clients = new Set([this.defaultClient, ...[...this.connections.values()].map((value) => value.client)]);
    for (const value of this.connections.values()) value.unsubscribe();
    this.connections.clear();
    this.listeners.clear();
    await Promise.allSettled([...clients].map((client) => client.close()));
  }
}
