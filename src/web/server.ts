import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
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

type Entry = AgentSessionSnapshot['session']['entries'][number];

export interface WebServerOptions {
  /** Directory served as the static client shell. Missing files fall back to the built-in page. */
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

/**
 * The static shell is the only thing a browser needs to paint. Everything after
 * that arrives over one server-sent event stream, so the server never renders.
 */
const FALLBACK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ranite</title>
<style>
  :root { color-scheme: dark; --line:#1f1f1f; --dim:#888; }
  * { box-sizing: border-box; }
  body { margin:0; background:#000; color:#ededed; font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  header { display:flex; gap:12px; align-items:center; padding:12px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:#000; }
  #title { font-weight:600; }
  #state { color:var(--dim); font-size:12px; }
  main { padding:20px; max-width:900px; margin:0 auto; display:flex; flex-direction:column; gap:10px; }
  .entry { border-left:2px solid var(--line); padding-left:12px; white-space:pre-wrap; word-break:break-word; }
  .entry.user { border-color:#4b7bec; }
  .entry.assistant { border-color:#26de81; }
  .entry.notice { border-color:#f7b731; color:#d8c48a; }
  .entry.tool { border-color:#555; color:#bbb; font-family:ui-monospace,monospace; font-size:12.5px; }
  footer { position:sticky; bottom:0; background:#000; border-top:1px solid var(--line); padding:12px 20px; display:flex; gap:8px; }
  input { flex:1; background:#0a0a0a; border:1px solid var(--line); color:inherit; padding:10px 12px; border-radius:6px; font:inherit; }
  button { background:#ededed; color:#000; border:0; padding:10px 16px; border-radius:6px; font:inherit; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:#ededed; border:1px solid var(--line); }
</style></head>
<body>
<header><span id="title">Ranite</span><span id="state">connecting…</span>
  <span style="flex:1"></span>
  <button class="ghost" id="stop" type="button">Stop</button></header>
<main id="log"></main>
<footer><input id="text" placeholder="Message Ranite…" autocomplete="off"><button id="send" type="button">Send</button></footer>
<script>
const log = document.getElementById('log');
const state = document.getElementById('state');
const title = document.getElementById('title');
let windowStart = 0;
function entryNode(entry) {
  const div = document.createElement('div');
  div.className = 'entry ' + (entry.kind || '');
  div.textContent = entry.text || '';
  return div;
}
function clearLog() { log.textContent = ''; }
function prependOlder() {
  const button = document.getElementById('older');
  if (button) button.remove();
  if (windowStart <= 0) return;
  fetch('/api/entries?before=' + windowStart + '&limit=50')
    .then((r) => r.json())
    .then((page) => {
      const fragment = document.createDocumentFragment();
      for (const entry of page.entries) fragment.appendChild(entryNode(entry));
      log.insertBefore(fragment, log.firstChild);
      windowStart = page.from;
      addOlderButton();
    });
}
function addOlderButton() {
  if (windowStart <= 0) return;
  const button = document.createElement('button');
  button.id = 'older';
  button.className = 'ghost';
  button.textContent = 'Load older entries';
  button.onclick = prependOlder;
  log.insertBefore(button, log.firstChild);
}
function apply(payload) {
  title.textContent = payload.session.title || 'Ranite';
  state.textContent = payload.busy ? 'working…' : 'idle';
  if (payload.reset) {
    clearLog();
    const fragment = document.createDocumentFragment();
    for (const entry of payload.entries) fragment.appendChild(entryNode(entry));
    log.appendChild(fragment);
    windowStart = payload.from;
    addOlderButton();
    window.scrollTo(0, document.body.scrollHeight);
  } else {
    for (const entry of payload.entries) log.appendChild(entryNode(entry));
    window.scrollTo(0, document.body.scrollHeight);
  }
}
const source = new EventSource('/api/events');
source.addEventListener('snapshot', (e) => apply(JSON.parse(e.data)));
source.addEventListener('patch', (e) => apply(JSON.parse(e.data)));
source.onerror = () => { state.textContent = 'reconnecting…'; };
async function post(path, body) {
  await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
document.getElementById('send').onclick = async () => {
  const input = document.getElementById('text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await post('/api/message', { text });
};
document.getElementById('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('send').click(); });
document.getElementById('stop').onclick = () => post('/api/stop', { holdQueue: true });
</script>
</body></html>`;

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
  const port = options.port ?? DEFAULT_WEB_PORT;
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
      from,
      totalEntries: snapshot.session.entries.length,
      busy: snapshot.busy,
      queuedMessageCount: snapshot.queuedMessageCount,
      pendingApproval: snapshot.pendingApproval ?? null,
      pendingQuestion: snapshot.pendingQuestion ?? null,
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
      if (!previous) {
        const from = Math.max(0, entries.length - WINDOW_ENTRIES);
        payload = snapshotPayload(entries.slice(from), true, from);
      } else if (entries.length < previous.length) {
        const from = Math.max(0, entries.length - WINDOW_ENTRIES);
        payload = snapshotPayload(entries.slice(from), true, from);
      } else {
        let changed = false;
        for (let index = 0; index < previous.length; index += 1) {
          if (entries[index] !== previous[index]) {
            changed = true;
            break;
          }
        }
        const appended = entries.length - previous.length;
        if (changed || appended > WINDOW_ENTRIES) {
          const from = Math.max(0, entries.length - WINDOW_ENTRIES);
          payload = snapshotPayload(entries.slice(from), true, from);
        } else {
          payload = snapshotPayload(entries.slice(previous.length), false, previous.length);
        }
      }
      target.lastEntries = entries;
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
    if (!options.assetsDir) return false;
    const relative = normalize(urlPath === '/' ? 'index.html' : urlPath.slice(1));
    if (relative.startsWith('..') || relative.includes(`..${sep}`)) return false;
    const target = join(options.assetsDir, relative);
    if (!target.startsWith(options.assetsDir)) return false;
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

    if (url.pathname === '/api/entries' && req.method === 'GET') {
      const entries = client.getSnapshot().session.entries as Entry[];
      const beforeRaw = Number(url.searchParams.get('before') ?? entries.length);
      const limitRaw = Number(url.searchParams.get('limit') ?? 50);
      const before = Number.isFinite(beforeRaw) ? Math.max(0, Math.min(Math.floor(beforeRaw), entries.length)) : entries.length;
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), MAX_PAGE_ENTRIES)) : 50;
      const start = Math.max(0, before - limit);
      return sendJson(res, 200, { from: start, to: before, total: entries.length, entries: entries.slice(start, before) });
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      const target: SseClient = { res, lastEntries: null };
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
      const body = JSON.parse((await readBody(req)) || '{}') as { text?: string };
      const text = (body.text ?? '').trim();
      if (!text) return sendJson(res, 400, { error: 'Empty message.' });
      await client.sendMessage(
        { text, images: [] },
        { reasoningVariantId: client.runtime.reasoningDefault ?? 'default', showReasoning: client.runtime.showReasoningDefault },
      );
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
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(FALLBACK_PAGE);
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
