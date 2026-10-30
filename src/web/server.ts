import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase64Image, MAX_IMAGE_BYTES } from '../image-data.js';
import { getBrandAsset } from '../branding.js';
import { getDataPath } from '../paths.js';
import {
  clearModalCredentials,
  getConfigPath,
  getSettingsPath,
  loadModalCredentials,
  loadSettings,
  saveModalCredentials,
  saveSettings,
} from '../settings.js';
import { verifyModalCredentials } from '../modal.js';
import { CATALOG_FILENAMES, getProvider, listProviderSummaries } from '../provider/catalog.js';
import { modelPresentation, resolveModelName, resolveProviderName, type ModelCatalogRow } from '../provider/model-presentation.js';
import { watchSettingsFiles } from '../settings-watch.js';
import { addProviderKeys } from '../provider/keys.js';
import { verifyAttachmentPath } from '../attachments.js';
import { connectDaemonSession } from '../daemon-client.js';
import { getDaemonStatus, hostVintage, hostVintageMismatchWarning } from '../daemon.js';
import type { AgentSessionClient, AgentSessionSnapshot } from '../agent-session.js';
import { ActivityLedger } from '../activity-ledger.js';
import { createLogger, fileSink } from '../logging.js';
import { getOpenButlerVersion } from '../version.js';
import { forgetRememberedPermission, listRememberedPermissions } from '../tool-permissions.js';
import { bucketUsage, bucketUsageByHour, groupHoursByDay, summarizeUsage } from '../usage/report.js';
import { readMemorySnapshot } from '../memory-view.js';
import { readLogRecords } from '../cli/logs.js';
import { createProject, listProjects, projectFolder, ProjectInputError, resolveProjectSelection } from '../projects/store.js';
import { pickProjectFolder } from './folder-picker.js';
import { attachTerminalServer } from './terminal-server.js';
import { readWorkspaceFiles, readWorkspaceFileTree, WorkspaceFilesError } from './files.js';
import { WebSessions, SessionRequestError } from './sessions.js';
import { BoundedSseWriter } from './sse-output.js';

/** Outside the Windows ephemeral range so the port stays free between runs. */
export function modelCatalogRows(): ModelCatalogRow[] {
  const settings = loadSettings();
  return Object.entries(settings.providers)
    .filter(([, provider]) => provider.enabled)
    .map(([providerId, provider]) => {
      const active = new Set(provider.models ?? []);
      const known = Object.keys(getProvider(providerId)?.models ?? {});
      const ids = [...new Set([...known, ...active])].sort();
      return {
        providerId,
        providerName: resolveProviderName(providerId),
        models: ids.map((modelId) => ({
          modelId,
          name: resolveModelName(providerId, modelId, settings),
          active: active.has(modelId),
        })),
      };
    })
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

export const DEFAULT_WEB_PORT = 45278;

export const DEFAULT_WEB_HOST = '127.0.0.1';

/** Address to open in a browser; wildcard addresses are only for listening. */
export function browserWebAddress(host: string, port: number): string {
  const name = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const hostname = name.includes(':') && !name.startsWith('[') ? `[${name}]` : name;
  return `http://${hostname}:${port}`;
}

const PAIR_TTL_MS = 5 * 60 * 1000;
const SESSION_COOKIE = 'openbutler_web';
/**
 * The pairing cookie's pre-rename name. The token value did not change, so
 * accepting the old name keeps browsers paired across the ranite -> openbutler
 * rename; new pairings still receive the current name.
 */
const LEGACY_SESSION_COOKIE = 'ranite_web';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 15_000;
/**
 * The transcript can hold thousands of entries, so the initial paint carries a
 * window instead of the whole history. Older entries are fetched on demand;
 * sending everything would cost megabytes per page load.
 */
const WINDOW_ENTRIES = 100;

/**
 * A reader window opens at the next message boundary. A blind tail slice can
 * start inside a work-heavy turn whose ask lives before the window — the turn
 * then has no owner line and, with no answer in the tail, renders as an empty
 * section whose only affordance is the collapsed work toggle.
 */
export function tailWindowStart(entries: readonly { kind: string }[], window: number = WINDOW_ENTRIES): number {
  const blind = Math.max(0, entries.length - window);
  for (let from = blind; from < entries.length; from += 1) {
    if (entries[from]!.kind === 'user') return from;
  }
  return blind;
}
const MAX_PAGE_ENTRIES = 200;

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
  writer: BoundedSseWriter;
  lastEntries: Entry[] | null;
  sessionId: string;
  /** When this stream last carried a byte, so a close can say how silent it was. */
  lastWriteAt: number;
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

/**
 * Identifies the bundle being served. Asset names are content-hashed, so the
 * index file's own digest changes exactly when a rebuild does. Read on demand
 * and memoized on the file itself: this server outlives rebuilds, so a digest
 * captured once at startup would leave every open tab unaware of the new bundle.
 */
let buildIdCache: { mtimeMs: number; size: number; id: string } | null = null;
function readBuildId(assetsDir: string | undefined): string | null {
  if (!assetsDir) return null;
  try {
    const file = join(assetsDir, 'index.html');
    const { mtimeMs, size } = statSync(file);
    if (buildIdCache && buildIdCache.mtimeMs === mtimeMs && buildIdCache.size === size) return buildIdCache.id;
    const id = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
    buildIdCache = { mtimeMs, size, id };
    return id;
  } catch {
    return null;
  }
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

/**
 * The cookie that marks a browser as paired with this machine. Kept on disk so
 * the owner's devices survive a restart of the host or of this server; a token
 * minted per run would silently unpair them every time.
 */
function persistentSessionToken(): string {
  const file = getDataPath('web-session-token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Missing or unreadable: mint one below.
  }
  const token = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, token, { mode: 0o600 });
  } catch {
    // A read-only data directory still works, it just forgets pairings.
  }
  return token;
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const host = options.host ?? DEFAULT_WEB_HOST;
  let port = options.port ?? DEFAULT_WEB_PORT;
  const assetsDir = options.assetsDir ?? defaultAssetsDir() ?? undefined;
  // An open tab keeps the bundle it loaded, so a rebuild would only reach the
  // reader after a manual reload. The build id lets the client notice and reload
  // itself once it is idle; it is asked for per answer because this server keeps
  // running across rebuilds.
  const currentBuildId = () => readBuildId(assetsDir);
  const startedAt = Date.now();
  const client: AgentSessionClient = await connectDaemonSession(options.workspaceRoot, { clientKind: 'web' });
  const sessions = new WebSessions(client, options.workspaceRoot);

  // A paired browser must stay paired across restarts: the owner's phone and
  // desktop should not have to re-pair every time the host or this server comes
  // back. The token lives in the data directory, readable only by this user.
  const sessionToken = persistentSessionToken();
  let pairToken = randomBytes(32).toString('base64url');
  let pairExpiresAt = Date.now() + PAIR_TTL_MS;
  let pairUsed = false;

  const logger = createLogger({ sink: fileSink(join(getDataPath('logs'), 'web.log')), context: { process: 'web' } });
  const vintageWarning = hostVintageMismatchWarning(process.argv[1], client.hostEntry);
  if (vintageWarning) logger.warn('web.host.vintage-mismatch', { host: client.hostEntry, client: process.argv[1] ?? null });
  const clients = new Set<SseClient>();

  const issuePairToken = (): string => {
    pairToken = randomBytes(32).toString('base64url');
    pairExpiresAt = Date.now() + PAIR_TTL_MS;
    pairUsed = false;
    return `${browserWebAddress(host, port)}/auth/pair?t=${encodeURIComponent(pairToken)}`;
  };

  const snapshotPayload = (entries: Entry[], reset: boolean, from: number, source: AgentSessionClient) => {
    const snapshot = source.getSnapshot();
    return {
      reset,
      entries,
      updated: [] as { index: number; entry: Entry }[],
      from,
      totalEntries: source.getServerEntries().length,
      busy: snapshot.busy,
      runningTurnId: snapshot.runningTurnId,
      queuedMessageCount: snapshot.queuedMessageCount,
      queuedMessages: snapshot.queuedMessages,
      pendingApproval: snapshot.pendingApproval ?? null,
      pendingQuestion: snapshot.pendingQuestion ?? null,
      contextTokens: (snapshot.session as { contextTokens?: number }).contextTokens ?? null,
      runtime: {
        supportsSessionAttachments: source.runtime.supportsSessionAttachments === true,
        modelName: source.runtime.modelName,
        providerName: source.runtime.providerName,
        providerId: source.runtime.providerId,
        modelId: source.runtime.modelId,
        contextWindowTokens: source.runtime.contextWindowTokens,
        approvalMode: source.runtime.approvalMode ?? null,
        showReasoningDefault: source.runtime.showReasoningDefault,
        reasoningTitles: source.runtime.reasoningTitles === true,
        reasoningVariants: source.runtime.reasoningVariants.map(({ id, label }) => ({ id, label })),
        reasoningDefault: source.runtime.reasoningDefault,
        workspaceRoot: source.runtime.workspaceRoot,
      },
      session: {
        id: snapshot.session.id,
        title: snapshot.session.title,
        hasUserMessage: snapshot.session.hasUserMessage ?? source.getServerEntries().some((entry) => entry.kind === 'user'),
        ...(snapshot.session.project ? { project: snapshot.session.project } : {}),
        projectLocked: snapshot.session.project?.locked === true || snapshot.session.hasUserMessage === true,
      },
      buildId: currentBuildId(),
    };
  };

  const writeEvent = (client_: SseClient, event: string, data: unknown) => {
    // One dead socket must never break the broadcast for the other clients, so a
    // failed write drops that stream instead of throwing through the loop.
    if (client_.res.writableEnded || client_.res.destroyed) {
      clients.delete(client_);
      return;
    }
    try {
      if (!client_.writer.send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
        clients.delete(client_);
        return;
      }
      client_.lastWriteAt = Date.now();
    } catch (problem) {
      clients.delete(client_);
      logger.warn('web.stream.write-failed', {
        event,
        error: problem instanceof Error ? problem.message : String(problem),
      });
    }
  };

  const broadcast = (boundId: string, client: AgentSessionClient, catalogChanged: boolean) => {
    if (catalogChanged) for (const target of clients) writeEvent(target, 'sessions-changed', {});
    if (clients.size === 0) return;
    const entries = client.getServerEntries() as Entry[];
    for (const target of clients) {
      if (target.sessionId !== boundId) continue;
      if (client.getSnapshot().session.id !== boundId) {
        target.res.end();
        continue;
      }
      const previous = target.lastEntries;
      const sessionChanged = target.sessionId !== client.getSnapshot().session.id;
      let payload: ReturnType<typeof snapshotPayload>;
      let resetReason: string | null = null;
      if (!previous || sessionChanged || entries.length < previous.length) {
        resetReason = !previous ? 'first' : sessionChanged ? 'session' : 'shrunk';
        const from = tailWindowStart(entries);
        payload = snapshotPayload(entries.slice(from), true, from, client);
      } else {
        const updated: { index: number; entry: Entry }[] = [];
        for (let index = 0; index < previous.length; index += 1) {
          if (entries[index] !== previous[index]) updated.push({ index, entry: entries[index] });
        }
        // A reset is not a cheaper patch: it replaces the reader's list with the
        // newest window, so every group is rebuilt and the reader loses the place
        // they were reading. A tool batch stamps several entries at once, which
        // used to trip a size threshold and reset a busy run every few seconds.
        // It stays only for the case a patch cannot express — a rewrite so broad
        // that the list the reader holds is no longer this conversation — and only
        // when the list is longer than the window, because otherwise the reset
        // sends back what the reader already has.
        if (updated.length * 2 > entries.length && entries.length > WINDOW_ENTRIES) {
          resetReason = 'rewritten';
          const from = tailWindowStart(entries);
          payload = snapshotPayload(entries.slice(from), true, from, client);
        } else {
          payload = {
            ...snapshotPayload(entries.slice(previous.length), false, previous.length, client),
            updated,
          };
        }
      }
      // A reset is the only event that can move the reader's list under them, so
      // the reason is recorded; a stream that resets often is a real defect.
      if (resetReason)
        logger.info('web.stream.reset', {
          reason: resetReason,
          from: payload.from,
          total: entries.length,
          previous: previous?.length ?? null,
        });
      target.lastEntries = entries;
      target.sessionId = client.getSnapshot().session.id;
      writeEvent(target, payload.reset ? 'snapshot' : 'patch', payload);
    }
  };

  const unsubscribe = sessions.subscribe(broadcast);

  const isAuthorized = (req: IncomingMessage): boolean => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get(SESSION_COOKIE) ?? cookies.get(LEGACY_SESSION_COOKIE);
    return Boolean(token && constantTimeEquals(token, sessionToken));
  };

  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    // The request is same-origin when its Origin names the host it was sent to.
    // Comparing against the request's own Host covers every way in — localhost,
    // a LAN address, a tailnet name behind an HTTPS proxy — without listing them,
    // and still refuses a page served from somewhere else.
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    // A refused request is the one a reader asks about later, so failures carry
    // their reason into the log; successful responses would only be noise.
    if (status >= 400) {
      const error = (body as { error?: unknown } | null)?.error;
      logger.warn('web.request.refused', {
        method: res.req?.method ?? null,
        path: res.req?.url ?? null,
        status,
        ...(typeof error === 'string' ? { error } : {}),
      });
    }
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

    const brandAsset = getBrandAsset(url.pathname);
    if (brandAsset && (req.method === 'GET' || req.method === 'HEAD')) {
      const data = await brandAsset.data;
      const etag = `"${createHash('sha256').update(data).digest('hex').slice(0, 16)}"`;
      const headers = {
        'content-type': brandAsset.contentType,
        'cache-control': 'public, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
        etag,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
      } else {
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : data);
      }
      return;
    }

    if (url.pathname === '/auth/pair' && req.method === 'GET') {
      const supplied = url.searchParams.get('t') ?? '';
      const valid = !pairUsed && Date.now() < pairExpiresAt && constantTimeEquals(supplied, pairToken);
      if (!valid) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('This pairing link is invalid or has expired. Run `openbutler web` again for a fresh link.');
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
      if (!isAuthorized(req)) {
        // Whether the browser sent a cookie at all is the difference between a
        // stale pairing and a proxy that dropped the header.
        logger.warn('web.auth.refused', {
          path: url.pathname,
          cookieLength: req.headers.cookie?.length ?? 0,
          host: req.headers.host ?? null,
        });
        return sendJson(res, 401, { error: 'Pair this browser first: run `openbutler web --pair`.' });
      }
    }

    const headerSessionId = req.headers['x-openbutler-session'];
    if (headerSessionId !== undefined && typeof headerSessionId !== 'string') return sendJson(res, 400, { error: 'Invalid chat ID.' });
    const querySessionId = url.searchParams.get('sessionId');
    if (querySessionId && headerSessionId && querySessionId !== headerSessionId)
      return sendJson(res, 400, { error: 'Conflicting chat IDs.' });
    const requestedSessionId = querySessionId ?? headerSessionId;
    const client = protectedPath && requestedSessionId ? await sessions.get(requestedSessionId) : sessions.defaultClient;

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, clients: clients.size, uptimeMs: Date.now() - startedAt });
    }

    if ((url.pathname === '/api/files' || url.pathname === '/api/files/tree') && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId !== client.getSnapshot().session.id)
        return sendJson(res, 409, { error: 'The active chat changed. Reopen Files in the current chat.' });
      try {
        // The scope belongs to the chat the request names — the same rule the
        // terminal server applies below — not to whichever chat the shared
        // client happens to track this second: two open chats can hold
        // different roots, and the panel must answer against its own.
        const scope = sessionId ? await sessions.get(sessionId) : client;
        const root = scope.runtime.workspaceRoot;
        const result =
          url.pathname === '/api/files/tree'
            ? await readWorkspaceFileTree(root)
            : await readWorkspaceFiles(root, url.searchParams.get('path') ?? '');
        if (sessionId !== client.getSnapshot().session.id)
          return sendJson(res, 409, { error: 'The active chat changed. Reopen Files in the current chat.' });
        return sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof WorkspaceFilesError) return sendJson(res, error.status, { error: error.message });
        throw error;
      }
    }

    if (url.pathname === '/api/projects' && req.method === 'GET') {
      return sendJson(res, 200, { projects: listProjects(), supportsSelection: client.runtime.supportsProjects === true });
    }
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      return sendJson(res, 201, createProject(JSON.parse(await readBody(req, 65536))));
    }
    if (url.pathname === '/api/project-folders' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 65536)) as { path?: unknown };
      return sendJson(res, 200, { path: projectFolder(body.path) });
    }
    if (url.pathname === '/api/project-folder-picker' && req.method === 'POST') {
      return sendJson(res, 200, { path: await pickProjectFolder() });
    }
    if (url.pathname === '/api/session-project' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 4096)) as { sessionId?: unknown; projectId?: unknown };
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'Invalid project selection.' });
      if (body.sessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The active chat changed. Try again.' });
      const current = client.getSnapshot();
      if (current.session.project?.locked || current.session.hasUserMessage)
        return sendJson(res, 409, { error: "This chat's project is fixed. Start a new chat." });
      if (current.busy || current.queuedMessageCount > 0) return sendJson(res, 409, { error: 'Wait for the running task to finish.' });
      if (!client.runtime.supportsProjects || !client.selectProject)
        return sendJson(res, 409, { error: 'Restart the OpenButler server to apply the project scope.' });
      resolveProjectSelection(body.projectId, options.workspaceRoot);
      await client.selectProject(body.projectId as string | null, body.sessionId as string);
      const entries = client.getServerEntries() as Entry[];
      const from = tailWindowStart(entries);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from, client));
    }

    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      const entries = client.getServerEntries() as Entry[];
      const from = tailWindowStart(entries);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from, client));
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const catalog = await sessions.list();
      return sendJson(
        res,
        200,
        catalog.map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          preview: session.preview ?? null,
          running: session.running,
          workspaceRoot: session.workspaceRoot,
          ...(session.project ? { project: session.project } : {}),
        })),
      );
    }

    if (url.pathname === '/api/approvals' && req.method === 'GET') {
      let remembered: Array<{ id: string; label: string; at: number }> = [];
      try {
        remembered = listRememberedPermissions().map((entry) => ({ id: entry.hash, label: entry.label, at: entry.at }));
      } catch {
        remembered = [];
      }
      const settings = loadSettings();
      return sendJson(res, 200, {
        mode: client.runtime.approvalMode ?? 'workspace',
        remembered: remembered.length,
        permissions: remembered,
        supported: ['workspace', 'auto-review', 'full-access'],
        // A reviewer that is not named falls back to the conversation's own model.
        autoReview: {
          providerId: settings.autoReviewProvider ?? null,
          modelId: settings.autoReviewModel ?? null,
          timeoutSeconds: settings.autoReviewTimeoutSeconds ?? null,
        },
        models: Object.entries(settings.providers)
          .filter(([, provider]) => provider.enabled)
          .flatMap(([providerId, provider]) =>
            (provider.models ?? []).map((modelId) => ({
              providerId,
              modelId,
              name: resolveModelName(providerId, modelId, settings),
            })),
          ),
      });
    }

    if (url.pathname === '/api/approvals/auto-review' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        providerId?: unknown;
        modelId?: unknown;
        timeoutSeconds?: unknown;
      };
      const settings = loadSettings();
      if (body.providerId === null || body.modelId === null) {
        delete settings.autoReviewProvider;
        delete settings.autoReviewModel;
      } else {
        if (typeof body.providerId !== 'string' || typeof body.modelId !== 'string')
          return sendJson(res, 400, { error: 'Choose a reviewer model, or clear it to use the conversation model.' });
        const provider = settings.providers[body.providerId];
        if (!provider?.enabled || !provider.models?.includes(body.modelId))
          return sendJson(res, 400, { error: 'Choose an active model for the reviewer.' });
        settings.autoReviewProvider = body.providerId;
        settings.autoReviewModel = body.modelId;
      }
      if (body.timeoutSeconds === null) delete settings.autoReviewTimeoutSeconds;
      else if (body.timeoutSeconds !== undefined) {
        if (
          typeof body.timeoutSeconds !== 'number' ||
          !Number.isFinite(body.timeoutSeconds) ||
          body.timeoutSeconds < 5 ||
          body.timeoutSeconds > 600
        )
          return sendJson(res, 400, { error: 'The review timeout must be between 5 and 600 seconds.' });
        settings.autoReviewTimeoutSeconds = Math.round(body.timeoutSeconds);
      }
      saveSettings(settings);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/approvals/forget' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { id?: unknown };
      if (typeof body.id !== 'string') return sendJson(res, 400, { error: 'Choose a remembered permission.' });
      const removed = forgetRememberedPermission(body.id);
      return sendJson(res, removed ? 200 : 404, { removed });
    }

    if (url.pathname === '/api/telegram' && req.method === 'GET') {
      const status = await getDaemonStatus().catch(() => null);
      const telegram = status?.telegram ?? null;
      return sendJson(res, 200, {
        enabled: loadSettings().telegram?.enabled === true,
        state: telegram?.state ?? 'disabled',
        paired: telegram?.paired ?? false,
        username: telegram?.username ?? null,
        error: telegram?.error ?? null,
      });
    }

    if (url.pathname === '/api/about' && req.method === 'GET') {
      return sendJson(res, 200, {
        version: getOpenButlerVersion(),
        workspace: options.workspaceRoot,
        dataDir: getDataPath(),
        logPath: getDataPath(join('logs', 'openbutler.log')),
        uptimeMs: Date.now() - startedAt,
        buildId: currentBuildId(),
        providerId: client.runtime.providerId,
        modelId: client.runtime.modelId,
        contextWindowTokens: client.runtime.contextWindowTokens ?? null,
        hostEntry: client.hostEntry ? `${hostVintage(client.hostEntry)} · ${client.hostEntry}` : null,
      });
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
      const lines = Number(url.searchParams.get('lines') ?? 200);
      const level = (url.searchParams.get('level') ?? 'info') as 'error' | 'warn' | 'info' | 'debug';
      const event = url.searchParams.get('event');
      const order = { error: 0, warn: 1, info: 2, debug: 3 } as const;
      if (!(level in order)) return sendJson(res, 400, { error: 'level must be error, warn, info, or debug.' });
      const records = readLogRecords(getDataPath(join('logs', 'openbutler.log')))
        .filter((record) => order[record.level] <= order[level])
        .filter((record) => !event || record.event.includes(event));
      return sendJson(res, 200, { records: records.slice(-Math.min(5000, Math.max(1, Math.floor(lines)))) });
    }

    if (url.pathname === '/api/usage' && req.method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? 30);
      const window = Number.isFinite(days) ? Math.min(3650, Math.max(1, Math.floor(days))) : 30;
      const sessionId = url.searchParams.get('session');
      const ledger = new ActivityLedger(undefined, { readOnly: true });
      try {
        const rows = ledger.usageRows({
          sinceMs: Date.now() - window * 24 * 60 * 60 * 1000,
          ...(sessionId ? { sessionId } : {}),
        });
        const buckets = bucketUsage(rows);
        return sendJson(res, 200, {
          label: `last ${window} days`,
          summary: summarizeUsage(buckets, rows),
          days: buckets,
        });
      } finally {
        ledger.close();
      }
    }

    if (url.pathname === '/api/usage/hours' && req.method === 'GET') {
      const hours = Number(url.searchParams.get('hours') ?? 48);
      const window = Number.isFinite(hours) ? Math.min(24 * 31, Math.max(1, Math.floor(hours))) : 48;
      const ledger = new ActivityLedger(undefined, { readOnly: true });
      try {
        const rows = ledger.usageRows({ sinceMs: Date.now() - window * 60 * 60 * 1000 });
        const { peak, days } = groupHoursByDay(bucketUsageByHour(rows));
        return sendJson(res, 200, { label: `last ${window} hours`, peak, days });
      } finally {
        ledger.close();
      }
    }

    if (url.pathname === '/api/memory' && req.method === 'GET') {
      return sendJson(res, 200, readMemorySnapshot(options.workspaceRoot));
    }

    if (url.pathname === '/api/models' && req.method === 'GET') {
      const settings = loadSettings();
      const configured = Object.entries(settings.providers).flatMap(([providerId, provider]) =>
        provider.enabled ? (provider.models ?? []).map((modelId) => modelPresentation(providerId, modelId, settings)) : [],
      );
      // Ids drive selection; the presentation resolver decides every displayed name.
      const current = modelPresentation(client.runtime.providerId, client.runtime.modelId, settings);
      return sendJson(res, 200, [
        current,
        ...configured.filter((model) => model.providerId !== current.providerId || model.modelId !== current.modelId),
      ]);
    }

    if (url.pathname === '/api/models/catalog' && req.method === 'GET') {
      return sendJson(res, 200, modelCatalogRows());
    }

    if (url.pathname === '/api/models/active' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        providerId?: unknown;
        modelId?: unknown;
        active?: unknown;
        all?: unknown;
      };
      if (typeof body.providerId !== 'string' || typeof body.active !== 'boolean')
        return sendJson(res, 400, { error: 'Choose a provider and whether its models are active.' });
      const settings = loadSettings();
      const provider = settings.providers[body.providerId];
      if (!provider?.enabled) return sendJson(res, 400, { error: 'That provider is not configured.' });
      const known = provider.models ?? [];
      const catalog = Object.keys(getProvider(body.providerId)?.models ?? {});
      let models: string[];
      if (body.all === true) {
        // One request for a provider, not one per model: the page has no reason to
        // write the settings file forty times to switch a list on.
        models = body.active ? catalog : [];
      } else {
        if (typeof body.modelId !== 'string') return sendJson(res, 400, { error: 'Choose a model.' });
        // A custom provider declares its own models: the catalog cannot be the
        // authority for an endpoint it has never seen.
        const custom = Boolean(provider.npm);
        if (body.active && !custom && !catalog.includes(body.modelId) && !known.includes(body.modelId))
          return sendJson(res, 400, { error: 'That model is not in the catalog.' });
        models = body.active ? [...new Set([...known, body.modelId])] : known.filter((modelId) => modelId !== body.modelId);
      }
      settings.providers[body.providerId] = { ...provider, models };
      saveSettings(settings);
      return sendJson(res, 200, modelCatalogRows());
    }

    if (url.pathname === '/api/providers' && req.method === 'GET') {
      const settings = loadSettings();
      // The catalog is the list, but a provider configured by hand (a custom
      // endpoint the catalog has never heard of) still belongs in it.
      const rows = new Map(
        listProviderSummaries().map((entry) => [
          entry.id,
          {
            providerId: entry.id,
            modelCount: entry.modelCount,
            configured: entry.id in settings.providers,
            activeModels: settings.providers[entry.id]?.models?.length ?? 0,
            custom: false,
          },
        ]),
      );
      for (const [providerId, provider] of Object.entries(settings.providers)) {
        rows.set(providerId, {
          providerId,
          modelCount: rows.get(providerId)?.modelCount ?? provider.models?.length ?? 0,
          configured: true,
          activeModels: provider.models?.length ?? 0,
          custom: Boolean(provider.npm),
        });
      }
      return sendJson(
        res,
        200,
        [...rows.values()].sort((left, right) => left.providerId.localeCompare(right.providerId)),
      );
    }

    if (url.pathname === '/api/providers' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        providerId?: unknown;
        apiKey?: unknown;
        npm?: unknown;
        url?: unknown;
        model?: unknown;
      };
      if (typeof body.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(body.providerId))
        return sendJson(res, 400, { error: 'Choose a provider id using letters, digits, dots, dashes or underscores.' });
      const settings = loadSettings();
      const catalogued = listProviderSummaries().some((entry) => entry.id === body.providerId);
      const npm = typeof body.npm === 'string' && body.npm.trim() ? body.npm.trim() : undefined;
      const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!catalogued && !(body.providerId in settings.providers) && !npm)
        return sendJson(res, 400, {
          error: 'The catalog does not know this provider: name the AI SDK package (npm) that speaks it.',
        });
      if (!catalogued && !(body.providerId in settings.providers) && !url)
        return sendJson(res, 400, { error: 'A custom provider needs the base URL of its API.' });
      if (apiKey) addProviderKeys(settings, body.providerId, [apiKey]);
      const entry = settings.providers[body.providerId] ?? { enabled: true, keys: [] };
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
      const models = model === undefined ? entry.models : [...new Set([...(entry.models ?? []), model])];
      settings.providers[body.providerId] = {
        ...entry,
        // Adding a provider is a statement that it should be usable: an entry saved
        // as disabled would look configured in settings and fail at run time.
        enabled: true,
        ...(models === undefined ? {} : { models }),
        ...(npm === undefined ? {} : { npm }),
        ...(url === undefined ? {} : { url }),
      };
      if (!settings.providerOrder.includes(body.providerId)) settings.providerOrder.push(body.providerId);
      saveSettings(settings);
      // The key never travels back: the response carries ids and counts only.
      return sendJson(res, 200, modelCatalogRows());
    }

    if (url.pathname === '/api/providers/remove' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { providerId?: unknown };
      if (typeof body.providerId !== 'string') return sendJson(res, 400, { error: 'Choose a provider.' });
      const settings = loadSettings();
      if (!(body.providerId in settings.providers)) return sendJson(res, 404, { error: 'That provider is not configured.' });
      if (settings.defaultProvider === body.providerId)
        return sendJson(res, 409, {
          error: 'This provider answers the conversation. Choose another model in the composer before removing it.',
        });
      delete settings.providers[body.providerId];
      settings.providerOrder = settings.providerOrder.filter((id) => id !== body.providerId);
      saveSettings(settings);
      return sendJson(res, 200, modelCatalogRows());
    }

    if (url.pathname === '/api/modal' && req.method === 'GET') {
      const credentials = loadModalCredentials();
      if (!credentials) return sendJson(res, 200, { configured: false, verified: false, apps: null, error: null, tokenId: null });
      // The id is not a secret and is safe to show; the secret never leaves the machine.
      const check = await verifyModalCredentials(credentials);
      return sendJson(res, 200, {
        configured: true,
        verified: check.ok,
        apps: check.apps,
        error: check.error,
        tokenId: credentials.tokenId,
      });
    }

    if (url.pathname === '/api/modal' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { tokenId?: unknown; tokenSecret?: unknown };
      if (typeof body.tokenId !== 'string' || typeof body.tokenSecret !== 'string' || !body.tokenId.trim() || !body.tokenSecret.trim())
        return sendJson(res, 400, { error: 'Enter both the token id and the token secret.' });
      const credentials = { tokenId: body.tokenId.trim(), tokenSecret: body.tokenSecret.trim() };
      const check = await verifyModalCredentials(credentials);
      if (!check.ok) return sendJson(res, 400, { error: check.error ?? 'Modal rejected these credentials.' });
      saveModalCredentials(credentials);
      return sendJson(res, 200, {
        configured: true,
        verified: true,
        apps: check.apps,
        error: null,
        tokenId: credentials.tokenId,
      });
    }

    if (url.pathname === '/api/modal/clear' && req.method === 'POST') {
      clearModalCredentials();
      return sendJson(res, 200, { configured: false, verified: false, apps: null, error: null, tokenId: null });
    }

    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body: unknown = JSON.parse((await readBody(req)) || '{}');
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'Invalid session action.' });
      const { action, sessionId, currentSessionId, projectId } = body as {
        action?: unknown;
        sessionId?: unknown;
        currentSessionId?: unknown;
        projectId?: unknown;
      };
      if (currentSessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The active chat changed. Try again.' });
      let next: AgentSessionClient;
      if (action === 'new') {
        if (projectId !== undefined && projectId !== null && typeof projectId !== 'string')
          return sendJson(res, 400, { error: 'Invalid project.' });
        next = await sessions.create(projectId === undefined ? null : (projectId as string | null));
      } else if (action === 'load' && typeof sessionId === 'string' && sessionId.length <= 64) {
        next = await sessions.get(sessionId);
      } else return sendJson(res, 400, { error: 'Invalid session action.' });
      const entries = next.getServerEntries();
      const from = tailWindowStart(entries);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from, next));
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
      const entries = client.getServerEntries();
      const from = tailWindowStart(entries);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from, client));
    }

    // Unlike the model, the effort is a preference: it may change while a run
    // is going, and the next model request picks it up from the runtime.
    if (url.pathname === '/api/reasoning' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { reasoningVariantId?: unknown; sessionId?: unknown };
      if (body.sessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The active chat changed. Try again.' });
      if (
        typeof body.reasoningVariantId !== 'string' ||
        body.reasoningVariantId.length > 256 ||
        !client.runtime.reasoningVariants.some((variant) => variant.id === body.reasoningVariantId)
      )
        return sendJson(res, 400, { error: 'Choose a supported effort level.' });
      client.runtime.saveReasoningPreference(body.reasoningVariantId);
      const entries = client.getServerEntries();
      const from = tailWindowStart(entries);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from, client));
    }

    if (url.pathname === '/api/approval-mode' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { mode?: unknown; sessionId?: unknown };
      if (body.sessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The active chat changed. Try again.' });
      if (body.mode !== 'workspace' && body.mode !== 'auto-review' && body.mode !== 'full-access')
        return sendJson(res, 400, { error: 'Choose a supported approval mode.' });
      await client.setApprovalMode(body.mode);
      const entries = client.getServerEntries();
      const from = tailWindowStart(entries);
      return sendJson(res, 200, snapshotPayload(entries.slice(from), true, from, client));
    }

    if (url.pathname === '/api/attachment' && req.method === 'GET') {
      const snapshot = client.getSnapshot();
      if (url.searchParams.get('sessionId') !== snapshot.session.id) return sendJson(res, 404, { error: 'Image unavailable.' });
      const id = url.searchParams.get('id');
      const attachment = snapshot.session.entries
        .flatMap((entry) => (entry.kind === 'user' ? (entry.attachments ?? []) : []))
        .find((file) => file.id === id && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mediaType));
      if (!attachment) return sendJson(res, 404, { error: 'Image unavailable.' });
      try {
        verifyAttachmentPath(attachment.path);
        const bytes = await readFile(attachment.path);
        res.writeHead(200, {
          'content-type': attachment.mediaType,
          'content-length': bytes.length,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
        });
        res.end(bytes);
      } catch {
        sendJson(res, 404, { error: 'Image unavailable.' });
      }
      return;
    }

    if (url.pathname === '/api/entries' && req.method === 'GET') {
      const snapshot = client.getSnapshot();
      if (url.searchParams.get('sessionId') !== snapshot.session.id) return sendJson(res, 409, { error: 'The active chat changed.' });
      const entries = client.getServerEntries() as Entry[];
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

      let socketError: string | null = null;
      // A socket error is the one signal that separates "the browser went away"
      // from "this machine could not write any more".
      res.on('error', (problem: Error) => {
        socketError = problem.name;
      });
      req.socket.on('error', (problem: Error) => {
        socketError = problem.name;
      });
      const target: SseClient = {
        res,
        writer: new BoundedSseWriter(res),
        lastEntries: null,
        sessionId: client.getSnapshot().session.id,
        lastWriteAt: Date.now(),
      };
      target.writer.send(': connected\n\n');
      const release = sessions.retain(target.sessionId);
      clients.add(target);
      const entries = client.getServerEntries() as Entry[];
      target.lastEntries = entries;
      const from = tailWindowStart(entries);
      writeEvent(target, 'snapshot', snapshotPayload(entries.slice(from), true, from, client));
      const heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        try {
          // A named event, not a comment: the browser must be able to see that
          // the stream is alive, or it cannot tell a healthy stream from a dead one.
          writeEvent(target, 'ping', {});
        } catch {
          /* The close handler removes the stream. */
        }
      }, HEARTBEAT_MS);
      const openedAt = Date.now();
      const agent = req.headers['user-agent'] ?? 'unknown';
      const device = /iphone|ipad|android/i.test(agent) ? 'mobile' : 'desktop';
      logger.info('web.stream.open', { device, port: req.socket.remotePort ?? null, agent: agent.slice(0, 80), clients: clients.size });
      req.on('close', () => {
        release();
        clearInterval(heartbeat);
        clients.delete(target);
        // Who ended the stream is the question a "keeps dropping" report asks:
        // a socket error, a server that could no longer write, and a browser that
        // simply went away look identical from the outside.
        logger.info('web.stream.close', {
          device,
          port: req.socket.remotePort ?? null,
          seconds: Math.round((Date.now() - openedAt) / 1000),
          silentMs: Date.now() - target.lastWriteAt,
          socketError: socketError ?? null,
          writableEnded: res.writableEnded,
          destroyed: res.destroyed,
          clients: clients.size,
        });
      });
      return;
    }

    if (url.pathname === '/api/message' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 30 * 1024 * 1024)) || '{}') as {
        projectId?: unknown;
        text?: unknown;
        sessionId?: unknown;
        images?: unknown;
        reasoningVariantId?: unknown;
      };
      if (body.sessionId !== client.getSnapshot().session.id)
        return sendJson(res, 409, { error: 'The active chat changed. Your message has not been sent.' });
      if ('projectId' in body) return sendJson(res, 400, { error: 'The project cannot be changed from the message body.' });
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
      const currentSession = client.getSnapshot().session;
      if (!currentSession.project && !currentSession.hasUserMessage && client.selectProject && client.runtime.supportsProjects)
        await client.selectProject(null, currentSession.id);
      const reasoningVariantId =
        typeof body.reasoningVariantId === 'string' ? body.reasoningVariantId : (client.runtime.reasoningDefault ?? 'default');
      if (body.reasoningVariantId !== undefined && !client.runtime.reasoningVariants.some((variant) => variant.id === reasoningVariantId))
        return sendJson(res, 400, { error: 'Choose a supported reasoning level.' });
      // The run outlives this request. Waiting for it here made a phone browser
      // abandon the request with a network error on any long turn, so the message
      // is handed over and the answer returns at once; progress arrives over SSE.
      void client
        .sendMessage({ text, images }, { reasoningVariantId, showReasoning: client.runtime.showReasoningDefault })
        .catch((problem: unknown) => {
          logger.warn('web.message.failed', { error: problem instanceof Error ? problem.message : String(problem) });
        });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/queue' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { sessionId?: unknown; messageId?: unknown; action?: unknown };
      if (typeof body.sessionId !== 'string' || typeof body.messageId !== 'string' || (body.action !== 'steer' && body.action !== 'remove'))
        return sendJson(res, 400, { error: 'Invalid queue action.' });
      const snapshot = client.getSnapshot();
      if (
        snapshot.session.id !== body.sessionId ||
        !snapshot.queuedMessages.some((message) => message.id === body.messageId && message.editable)
      )
        return sendJson(res, 409, { error: 'This message is no longer queued in the active session.' });
      if (!client.manageQueuedMessage) return sendJson(res, 409, { error: 'Queue actions require an updated host.' });
      await client.manageQueuedMessage(body.messageId, body.action, body.sessionId);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/client-report' && req.method === 'POST') {
      // The browser cannot write the machine log, so it reports what only it can
      // see: a patch that arrived with a hole, and a stream it had to rebuild.
      const body = JSON.parse((await readBody(req, 8 * 1024)) || '{}') as { event?: unknown; [field: string]: unknown };
      const name = typeof body.event === 'string' ? body.event.slice(0, 64) : 'unknown';
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        // `event` names the record's own kind, so the reported name travels as
        // `client`; a field called `event` would overwrite the record's event.
        if (key === 'event') continue;
        if (typeof value === 'string') fields[key] = value.slice(0, 200);
        else if (typeof value === 'number' || typeof value === 'boolean') fields[key] = value;
      }
      logger.warn('web.client.report', { client: name, ...fields });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { holdQueue?: boolean; sessionId?: unknown };
      if (body.sessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'Choose the chat to stop.' });
      client.stop(body.holdQueue === false ? { keepQueue: true } : { keepQueue: true, holdQueue: true });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        decision?: 'allow' | 'deny' | 'always';
        requestId?: string;
        sessionId?: unknown;
      };
      if (body.sessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The approval belongs to another chat.' });
      if (!body.decision) return sendJson(res, 400, { error: 'Missing decision.' });
      client.approveToolCall(body.decision, body.requestId);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/answer' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { answer?: string | null; questionId?: string; sessionId?: unknown };
      if (body.sessionId !== client.getSnapshot().session.id) return sendJson(res, 409, { error: 'The question belongs to another chat.' });
      client.answerQuestion(body.answer ?? null, body.questionId);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      if (await serveStatic(res, url.pathname)) return;
      // A missing hashed asset is how a stale tab shows itself: the bundle still
      // running in that browser asks for a file a rebuild has already removed.
      if (assetsDir !== undefined) logger.warn('web.static.missing', { path: url.pathname });
      // No client bundle and no static file to serve: say so. The server does not
      // carry a page of its own, so what a browser shows is the real client or a
      // 404 that names the command that builds it.
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        assetsDir === undefined
          ? 'The browser client bundle is missing. Build it with `npm run build:web`, then restart `openbutler web`.'
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
      res.writeHead(
        error instanceof SessionRequestError
          ? error.status
          : error instanceof ProjectInputError || error instanceof SyntaxError
            ? 400
            : 500,
        {
          'content-type': 'application/json; charset=utf-8',
        },
      );
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  const closeTerminals = attachTerminalServer(server, {
    authorize: (request) => originAllowed(request) && isAuthorized(request),
    workspace: async (sessionId) => (await sessions.get(sessionId)).runtime.workspaceRoot,
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

  const settingsWatcher = watchSettingsFiles(
    getDataPath(),
    [getSettingsPath(), getConfigPath(), ...CATALOG_FILENAMES],
    () => {
      for (const target of clients) writeEvent(target, 'models-changed', {});
    },
    (message) => logger.warn('web.settings.watch', { message }),
  );

  return {
    url: browserWebAddress(host, port),
    pairUrl,
    newPairUrl: issuePairToken,
    async close() {
      settingsWatcher.stop();
      closeTerminals();
      unsubscribe();
      for (const target of clients) target.res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sessions.close();
    },
    stats() {
      return { clients: clients.size, rssBytes: process.memoryUsage().rss, uptimeMs: Date.now() - startedAt };
    },
  };
}
