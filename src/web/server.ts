import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase64Image, MAX_IMAGE_BYTES } from '../image-data.js';
import { loadSettings } from '../settings.js';
import { connectDaemonSession } from '../daemon-client.js';
import type { AgentSessionClient, AgentSessionSnapshot } from '../agent-session.js';

/** Outside the Windows ephemeral range so the port stays free between runs. */
export const DEFAULT_WEB_PORT = 45278;
export const DEFAULT_WEB_HOST = '127.0.0.1';

const PAIR_TTL_MS = 5 * 60 * 1000;
const SESSION_COOKIE = 'ranite_web';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 25_000;
/**
 * The transcript can hold thousands of entries, so the initial paint carries a
 * window instead of the whole history. Older entries are fetched on demand;
 * sending everything would cost megabytes per page load.
 */
const WINDOW_ENTRIES = 100;
const MAX_PAGE_ENTRIES = 200;
/** Above this many changed entries in one publish, a full window is cheaper than a diff. */
const MAX_ENTRY_UPDATES = 12;

type Entry = AgentSessionSnapshot['session']['entries'][number];

export interface WebServerOptions {
  /** Directory served as the static client shell. When it is absent or a file is missing, the request 404s. */
  assetsDir?: string;
  port?: number;
  host?: string;
  workspaceRoot: string;
  /** Called once with the one-time pairing link. */
  onPairUrl?: (url: string) => void;
}

export interface WebServer {
  readonly url: string;
  readonly pairUrl: string;
  /** Re-issues a one-time pairing link, for a second browser or after the first expired. */
  newPairUrl(): string;
  close(): Promise<void>;
  stats(): { clients: number; rssBytes: number; uptimeMs: number };
}

interface SseClient {
  res: ServerResponse;
  lastEntries: Entry[] | null;
  sessionId: string;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out.set(name, decodeURIComponent(part.slice(index + 1).trim()));
  }
  return out;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * The browser bundle is built next to the compiled server (`dist/client`). The
 * lookup walks up from this module so a dev run from `src/` and a packaged run
 * from `dist/` both find the same folder.
 */
function defaultAssetsDir(): string | null {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'dist', 'client');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const host = options.host ?? DEFAULT_WEB_HOST;
  let port = options.port ?? DEFAULT_WEB_PORT;
  const assetsDir = options.assetsDir ?? defaultAssetsDir() ?? undefined;
  const startedAt = Date.now();
  const client: AgentSessionClient = await connectDaemonSession(options.workspaceRoot);

  const sessionToken = randomBytes(32).toString('base64url');
  let pairToken = randomBytes(32).toString('base64url');
  let pairExpiresAt = Date.now() + PAIR_TTL_MS;
  let pairUsed = false;

  const clients = new Set<SseClient>();
  const allowedOrigins = new Set<string>();
  let originChecked = false;

  const issuePairToken = (): string => {
    pairToken = randomBytes(32).toString('base64url');
    pairExpiresAt = Date.now() + PAIR_TTL_MS;
    pairUsed = false;
    return `http://${host}:${port}/auth/pair?t=${encodeURIComponent(pairToken)}`;
  };

  const snapshotPayload = (entries: Entry[], reset: boolean, from: number) => {
    const snapshot = client.getSnapshot();
    return {
      reset,
      entries,
      updated: [] as { index: number; entry: Entry }[],
      from,
      totalEntries: snapshot.session.entries.length,
      busy: snapshot.busy,
      queuedMessageCount: snapshot.queuedMessageCount,
      pendingApproval: snapshot.pendingApproval ?? null,
      pendingQuestion: snapshot.pendingQuestion ?? null,
      contextTokens: (snapshot.session as { contextTokens?: number }).contextTokens ?? null,
      runtime: {
        modelName: client.runtime.modelName,
        providerId: client.runtime.providerId,
        modelId: client.runtime.modelId,
        contextWindowTokens: client.runtime.contextWindowTokens,
        approvalMode: client.runtime.approvalMode ?? null,
        showReasoningDefault: client.runtime.showReasoningDefault,
        reasoningVariants: client.runtime.reasoningVariants.map(({ id, label }) => ({ id, label })),
        reasoningDefault: client.runtime.reasoningDefault,
        workspaceRoot: client.runtime.workspaceRoot,
      },
      session: { id: snapshot.session.id, title: snapshot.session.title },
    };
  };

  const writeEvent = (client_: SseClient, event: string, data: unknown) => {
    client_.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const broadcast = () => {
    if (clients.size === 0) return;
    const entries = client.getSnapshot().session.entries as Entry[];
    for (const target of clients) {
      const previous = target.lastEntries;
      let payload: ReturnType<typeof snapshotPayload>;
      if (!previous || target.sessionId !== client.getSnapshot().session.id || entries.length < previous.length) {
        const from = Math.max(0, entries.length - WINDOW_ENTRIES);
        payload = snapshotPayload(entries.slice(from), true, from);
      } else {
        const updated: { index: number; entry: Entry }[] = [];
        let resetNeeded = false;
        for (let index = 0; index < previous.length; index += 1) {
          if (entries[index] !== previous[index]) {
            updated.push({ index, entry: entries[index] });
            if (updated.length > MAX_ENTRY_UPDATES) {
              resetNeeded = true;
              break;
            }
          }
        }
        const appended = entries.length - previous.length;
        if (resetNeeded || appended > WINDOW_ENTRIES) {
          const from = Math.max(0, entries.length - WINDOW_ENTRIES);
          payload = snapshotPayload(entries.slice(from), true, from);
        } else {
          payload = {
            ...snapshotPayload(entries.slice(previous.length), false, previous.length),
            updated,
          };
        }
      }
      target.lastEntries = entries;
      target.sessionId = client.getSnapshot().session.id;
      writeEvent(target, payload.reset ? 'snapshot' : 'patch', payload);
    }
  };

  const unsubscribe = client.subscribe(broadcast);

  const isAuthorized = (req: IncomingMessage): boolean => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get(SESSION_COOKIE);
    return Boolean(token && constantTimeEquals(token, sessionToken));
  };

  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    return allowedOrigins.has(origin);
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(payload);
  };

  const serveStatic = async (res: ServerResponse, urlPath: string): Promise<boolean> => {
    if (!assetsDir) return false;
    const relative = normalize(urlPath === '/' ? 'index.html' : urlPath.slice(1));
    if (relative.startsWith('..') || relative.includes(`..${sep}`)) return false;
    const target = join(assetsDir, relative);
    if (!target.startsWith(assetsDir)) return false;
    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
        'cache-control': relative === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    if (!originChecked) {
      for (const candidate of [host, '127.0.0.1', 'localhost']) {
        allowedOrigins.add(`http://${candidate}:${port}`);
      }
      originChecked = true;
    }

    if (url.pathname === '/auth/pair' && req.method === 'GET') {
      const supplied = url.searchParams.get('t') ?? '';
      const valid = !pairUsed && Date.now() < pairExpiresAt && constantTimeEquals(supplied, pairToken);
      if (!valid) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('This pairing link is invalid or has expired. Run `ranite web` again for a fresh link.');
        return;
      }
      pairUsed = true;
      res.writeHead(302, {
        'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        location: '/',
      });
      res.end();
      return;
    }

    const protectedPath = url.pathname.startsWith('/api/');
    if (protectedPath) {
      if (!originAllowed(req)) return sendJson(res, 403, { error: 'Cross-origin request refused.' });
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Pair this browser first: run `ranite web`.' });
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, clients: clients.size, uptimeMs: Date.now() - startedAt });
    }

    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      const entries = client.getSnapshot().session.entries as Entry[];
      const from = Math.max(0, entries.length - WINDOW_ENTRIES);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from));
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = await client.listSessions();
      return sendJson(
        res,
        200,
        sessions.map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          preview: session.preview ?? null,
          workspaceRoot: session.workspaceRoot,
        })),
      );
    }

    if (url.pathname === '/api/models' && req.method === 'GET') {
      const configured = Object.entries(loadSettings().providers).flatMap(([providerId, provider]) =>
        provider.enabled
          ? (provider.models ?? []).map((modelId) => ({ providerId, modelId, name: modelId.split('/').pop() ?? modelId }))
          : [],
      );
      const current = { providerId: client.runtime.providerId, modelId: client.runtime.modelId, name: client.runtime.modelName };
      return sendJson(res, 200, [
        current,
        ...configured.filter((model) => model.providerId !== current.providerId || model.modelId !== current.modelId),
      ]);
    }

    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body: unknown = JSON.parse((await readBody(req)) || '{}');
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'Invalid session action.' });
      const { action, sessionId, currentSessionId } = body as { action?: unknown; sessionId?: unknown; currentSessionId?: unknown };
      if (currentSessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The active chat changed. Try again.' });
      if (client.isBusy || client.getSnapshot().queuedMessageCount > 0)
        return sendJson(res, 409, { error: 'Finish or stop the current run and clear the queue before switching chats.' });
      if (action === 'new') {
        await client.createNewSession();
        if (client.getSnapshot().session.id === currentSessionId)
          return sendJson(res, 409, { error: 'The host could not create a new chat. Try again.' });
      } else if (action === 'load' && typeof sessionId === 'string' && sessionId.length <= 64) {
        const sessions = await client.listSessions();
        if (currentSessionId !== client.getSnapshot().session.id)
          return sendJson(res, 409, { error: 'The active chat changed. Try again.' });
        if (!sessions.some((session) => session.id === sessionId))
          return sendJson(res, 404, { error: 'Session not found in this workspace.' });
        if (!(await client.loadSession(sessionId))) return sendJson(res, 404, { error: 'Session not found.' });
      } else return sendJson(res, 400, { error: 'Invalid session action.' });
      const entries = client.getSnapshot().session.entries;
      const from = Math.max(0, entries.length - WINDOW_ENTRIES);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from));
    }

    if (url.pathname === '/api/model' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { providerId?: unknown; modelId?: unknown; sessionId?: unknown };
      if (body.sessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The active chat changed. Try again.' });
      if (client.isBusy || client.getSnapshot().queuedMessageCount > 0)
        return sendJson(res, 409, { error: 'Wait for the current run before changing models.' });
      if (typeof body.providerId !== 'string' || typeof body.modelId !== 'string')
        return sendJson(res, 400, { error: 'Choose a configured model.' });
      const provider = loadSettings().providers[body.providerId];
      if (!provider?.enabled || !provider.models?.includes(body.modelId))
        return sendJson(res, 400, { error: 'Choose a configured model.' });
      await client.selectModel(body.providerId, body.modelId);
      const entries = client.getSnapshot().session.entries;
      const from = Math.max(0, entries.length - WINDOW_ENTRIES);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from));
    }

    if (url.pathname === '/api/entries' && req.method === 'GET') {
      const snapshot = client.getSnapshot();
      if (url.searchParams.get('sessionId') !== snapshot.session.id) return sendJson(res, 409, { error: 'The active chat changed.' });
      const entries = snapshot.session.entries as Entry[];
      const beforeRaw = Number(url.searchParams.get('before') ?? entries.length);
      const limitRaw = Number(url.searchParams.get('limit') ?? 50);
      const before = Number.isFinite(beforeRaw) ? Math.max(0, Math.min(Math.floor(beforeRaw), entries.length)) : entries.length;
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), MAX_PAGE_ENTRIES)) : 50;
      const start = Math.max(0, before - limit);
      return sendJson(res, 200, {
        sessionId: client.getSnapshot().session.id,
        from: start,
        to: before,
        total: entries.length,
        entries: entries.slice(start, before),
      });
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      const target: SseClient = { res, lastEntries: null, sessionId: client.getSnapshot().session.id };
      clients.add(target);
      const entries = client.getSnapshot().session.entries as Entry[];
      target.lastEntries = entries;
      const from = Math.max(0, entries.length - WINDOW_ENTRIES);
      writeEvent(target, 'snapshot', snapshotPayload(entries.slice(from), true, from));
      const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(target);
      });
      return;
    }

    if (url.pathname === '/api/message' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 30 * 1024 * 1024)) || '{}') as {
        text?: unknown;
        sessionId?: unknown;
        images?: unknown;
        reasoningVariantId?: unknown;
      };
      if (body.sessionId !== client.getSnapshot().session.id)
        return sendJson(res, 409, { error: 'The active chat changed. Your message has not been sent.' });
      if (typeof body.text !== 'string') return sendJson(res, 400, { error: 'Message must be text.' });
      const text = (body.text ?? '').trim();
      if (Buffer.byteLength(text, 'utf8') > 1_000_000) return sendJson(res, 400, { error: 'Message is too long.' });
      if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length > 4))
        return sendJson(res, 400, { error: 'Attach up to four images.' });
      let images: Array<{ base64: string; mediaType: 'image/png' }>;
      try {
        images = (body.images ?? []) as Array<{ base64: string; mediaType: 'image/png' }>;
        images = images.map((image) => {
          if (!image || image.mediaType !== 'image/png' || typeof image.base64 !== 'string') throw new Error('Invalid image.');
          const bytes = decodeBase64Image(image.base64, 'image/png', MAX_IMAGE_BYTES);
          return { base64: bytes.toString('base64'), mediaType: 'image/png' as const };
        });
      } catch {
        return sendJson(res, 400, { error: 'Attach a valid PNG image of at most 5 MB.' });
      }
      if (!text && !images.length) return sendJson(res, 400, { error: 'Empty message.' });
      const reasoningVariantId =
        typeof body.reasoningVariantId === 'string' ? body.reasoningVariantId : (client.runtime.reasoningDefault ?? 'default');
      if (body.reasoningVariantId !== undefined && !client.runtime.reasoningVariants.some((variant) => variant.id === reasoningVariantId))
        return sendJson(res, 400, { error: 'Choose a supported reasoning level.' });
      await client.sendMessage({ text, images }, { reasoningVariantId, showReasoning: client.runtime.showReasoningDefault });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { holdQueue?: boolean };
      client.stop(body.holdQueue === false ? { keepQueue: true } : { keepQueue: true, holdQueue: true });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { decision?: 'allow' | 'deny' | 'always'; requestId?: string };
      if (!body.decision) return sendJson(res, 400, { error: 'Missing decision.' });
      client.approveToolCall(body.decision, body.requestId);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/answer' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { answer?: string | null; questionId?: string };
      client.answerQuestion(body.answer ?? null, body.questionId);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      if (await serveStatic(res, url.pathname)) return;
      // No client bundle and no static file to serve: say so. The server does not
      // carry a page of its own, so what a browser shows is the real client or a
      // 404 that names the command that builds it.
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        assetsDir === undefined
          ? 'The browser client bundle is missing. Build it with `npm run build:web`, then restart `ranite web`.'
          : 'Not found.',
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address && typeof address === 'object') port = address.port;
  const pairUrl = issuePairToken();
  options.onPairUrl?.(pairUrl);

  return {
    url: `http://${host}:${port}`,
    pairUrl,
    newPairUrl: issuePairToken,
    async close() {
      unsubscribe();
      for (const target of clients) target.res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.close();
    },
    stats() {
      return { clients: clients.size, rssBytes: process.memoryUsage().rss, uptimeMs: Date.now() - startedAt };
    },
  };
}
