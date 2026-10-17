import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { isTailnetAddress } from './tailnet.js';
import { fingerprintOf, GROUP_RECIPIENT, hashTicket, makeFileId, makeRequestId, validateMemberName } from './service.js';
import { TeamOperations, TeamError, MAX_FILE_BYTES } from './operations.js';
import { TeamStore, type JoinRequest } from './store.js';
import { TeamCoordination } from './coordination.js';
import { deleteFileBytes, ensureFilesDir, fileExists, filePath, readFileStream } from './files.js';

const MAX_BODY_BYTES = 65_536;
const MAX_GROUP_PAGE = 200;
const MAX_INBOX_PAGE = 200;
const MAX_MEMORY_PAGE = 500;
const MAX_HISTORY_PAGE = 200;
/** How long an approved ticket may be re-fetched before it is forgotten. */
const JOIN_TICKET_TTL_MS = 60 * 60_000;
const PROTOCOL_VERSION = 'ranite-team/1';
/** Brute-force brake: after this many failed joins from one address, refuse it for a while. */
const JOIN_FAILURE_LIMIT = 3;
const JOIN_BLOCK_MS = 5 * 60_000;
/** A member counts as online when it has polled within this window (poll is 1s). */
const PRESENCE_WINDOW_MS = 15_000;

export interface TeamServerOptions {
  store: TeamStore;
  /** Tailnet address to bind. Anything else is refused (loopback only with allowLoopback, for tests). */
  bindAddress: string;
  port: number;
  allowLoopback?: boolean;
  /** Fired after a join request is recorded, so the host can nudge its owner. */
  onJoinRequest?: (request: JoinRequest) => void;
  log?: (message: string) => void;
  /** Clock, injectable so the brute-force brake is testable. */
  now?: () => number;
}

export interface StartedTeamServer {
  url: string;
  close(): Promise<void>;
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.toLowerCase() === 'localhost';
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function bearerTicket(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  const ticket = match?.[1]?.trim() ?? '';
  return ticket.length > 0 && ticket.length <= 512 ? ticket : null;
}

/**
 * The hub's HTTP surface. Plain HTTP is enough: every byte already rides the
 * WireGuard-encrypted tailnet, and identity comes from bearer tickets, not TLS.
 * Binding anywhere but the tailnet is refused at startup.
 */
export function startTeamServer(options: TeamServerOptions): Promise<StartedTeamServer> {
  const { store, bindAddress, port, allowLoopback = false } = options;
  if (!isTailnetAddress(bindAddress) && !(allowLoopback && isLoopback(bindAddress))) {
    throw new Error(
      `${bindAddress} is not a tailnet address. The team hub binds the tailnet interface only; 0.0.0.0 and public addresses are refused.`,
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Team hub needs a port 1-65535.');
  // Port 0 asks the OS for a free port; only the loopback test path uses it,
  // since a real hub on port 0 would be unreachable by design.
  if (port === 0 && !allowLoopback) throw new Error('Team hub needs a port 1-65535.');

  const hubId = store.getMeta('hub_id');
  const teamName = store.getMeta('team_name') ?? 'team';
  if (!hubId) throw new Error('Team store is not initialized. Run team init first.');
  const fingerprint = fingerprintOf(hubId);
  const operations = new TeamOperations(store);
  const coordination = new TeamCoordination(store);
  const clock = options.now ?? Date.now;
  // Per-source-address join failures; cleared on a successful request.
  const joinFailures = new Map<string, { count: number; blockedUntil: number }>();
  const sourceOf = (request: IncomingMessage): string => request.socket.remoteAddress ?? 'unknown';
  const isBlocked = (source: string, now: number): boolean => {
    const entry = joinFailures.get(source);
    return !!entry && entry.blockedUntil > now;
  };
  const recordFailure = (source: string, now: number): void => {
    const entry = joinFailures.get(source);
    const count = (entry?.count ?? 0) + 1;
    joinFailures.set(source, { count, blockedUntil: count >= JOIN_FAILURE_LIMIT ? now + JOIN_BLOCK_MS : 0 });
  };

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      options.log?.(`team hub: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'Internal error.' });
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://team');
    const now = clock();
    if (request.method === 'GET' && url.pathname === '/v1/fingerprint') {
      sendJson(response, 200, { team: teamName, fingerprint, teamId: store.teamId() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/join') {
      const source = sourceOf(request);
      if (isBlocked(source, now)) {
        sendJson(response, 429, { error: 'Too many failed join attempts. Try again later.' });
        return;
      }
      const body = (await readJson(request)) as { code?: unknown; name?: unknown };
      if (typeof body?.code !== 'string' || typeof body?.name !== 'string') {
        sendJson(response, 400, { error: 'Join needs { code, name }.' });
        return;
      }
      let name: string;
      try {
        name = validateMemberName(body.name);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid name.' });
        return;
      }
      // One message for missing/used/expired: no reason is leaked (SPEC §7).
      const invite = store.getInvite(body.code.trim(), now);
      if (!invite) {
        recordFailure(source, now);
        sendJson(response, 404, { error: 'Invite code is invalid.' });
        return;
      }
      if (store.nameTaken(name)) {
        recordFailure(source, now);
        sendJson(response, 409, { error: `"${name}" is already taken in this team. Pick another name.` });
        return;
      }
      if (!store.consumeInvite(invite.code, name, now)) {
        recordFailure(source, now);
        sendJson(response, 404, { error: 'Invite code is invalid.' });
        return;
      }
      joinFailures.delete(source);
      const id = makeRequestId();
      store.createJoinRequest(id, name, invite.code, now);
      store.appendAudit({ kind: 'join.requested', actor: name, detail: invite.code, createdAt: now });
      const created = store.getJoinRequest(id)!;
      options.onJoinRequest?.(created);
      sendJson(response, 202, { requestId: id, status: 'pending' });
      return;
    }
    const joinStatus = /^\/v1\/join\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && joinStatus) {
      const entry = store.getJoinRequest(joinStatus[1]!);
      if (!entry) {
        sendJson(response, 404, { error: 'Unknown join request.' });
        return;
      }
      if (entry.status === 'pending') {
        sendJson(response, 200, { status: 'pending' });
        return;
      }
      if (entry.status === 'denied') {
        sendJson(response, 200, { status: 'denied' });
        return;
      }
      // Idempotent pickup: the ticket is returned until the joiner confirms it
      // or the pickup TTL passes, so a lost response is recoverable.
      const ticket = store.peekTicket(entry.id, now, JOIN_TICKET_TTL_MS);
      if (!ticket) {
        sendJson(response, 410, { error: 'This approval was already picked up or expired.' });
        return;
      }
      sendJson(response, 200, { status: 'approved', ticket, team: teamName, teamId: store.teamId(), memberName: entry.name });
      return;
    }
    const joinConfirm = /^\/v1\/join\/([A-Za-z0-9_-]+)\/confirm$/.exec(url.pathname);
    if (request.method === 'POST' && joinConfirm) {
      store.confirmTicket(joinConfirm[1]!);
      sendJson(response, 200, { confirmed: true });
      return;
    }
    // Everything below needs a member ticket. The database lookup on the
    // ticket hash is the check: unknown or revoked tickets find nothing.
    const ticket = bearerTicket(request);
    const member = ticket ? store.findByTicketHash(hashTicket(ticket)) : null;
    if (!member) {
      sendJson(response, 401, { error: 'A valid member ticket is required.' });
      return;
    }
    store.touchMember(member.name, now);
    if (request.method === 'POST' && ['/v1/profile', '/v1/work', '/v1/capabilities'].includes(url.pathname)) {
      const input: unknown = await readJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        sendJson(response, 400, { error: 'An object is required.' });
        return;
      }
      try {
        const body = input as Record<string, unknown>;
        const result =
          url.pathname === '/v1/profile'
            ? coordination.profile(member.name, body)
            : url.pathname === '/v1/work'
              ? coordination.work(member.name, body)
              : coordination.reportCapabilities(member.name, body);
        sendJson(response, 200, { result: result ?? null });
      } catch (error) {
        if (error instanceof TeamError) {
          sendJson(response, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      sendJson(response, 200, {
        protocol: PROTOCOL_VERSION,
        team: teamName,
        you: member.name,
        memberCount: store.listMembers().length,
        groupCursor: store.getGroupCursor(member.name),
        groupLatestSeq: store.groupLatestSeq(),
        members: store.memberSummaries(now, PRESENCE_WINDOW_MS),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/messages') {
      const body = (await readJson(request)) as { recipient?: unknown; body?: unknown; replyTo?: unknown; msgId?: unknown };
      if (typeof body?.recipient !== 'string' || typeof body?.body !== 'string') {
        sendJson(response, 400, { error: 'Sending needs { recipient, body }.' });
        return;
      }
      try {
        const result = operations.postMessage(member.name, {
          recipient: body.recipient,
          body: body.body,
          ...(typeof body.replyTo === 'string' && body.replyTo ? { replyTo: body.replyTo } : {}),
          ...(typeof body.msgId === 'string' ? { msgId: body.msgId } : {}),
        });
        if (result.duplicate) {
          sendJson(response, 200, { msgId: result.msgId, duplicate: true });
          return;
        }
        sendJson(response, 200, { msgId: result.message.msgId, seq: result.message.seq, createdAt: result.message.createdAt });
      } catch (error) {
        if (error instanceof TeamError) {
          sendJson(response, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/group') {
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw === null ? 0 : Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) {
        sendJson(response, 400, { error: 'since must be a non-negative integer.' });
        return;
      }
      const messages = store.groupMessages(since, MAX_GROUP_PAGE);
      sendJson(response, 200, { latestSeq: store.groupLatestSeq(), messages });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/group/cursor') {
      const body = (await readJson(request)) as { seq?: unknown };
      if (typeof body?.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < 0) {
        sendJson(response, 400, { error: 'cursor needs { seq }.' });
        return;
      }
      store.setGroupCursor(member.name, body.seq);
      sendJson(response, 200, { cursor: store.getGroupCursor(member.name) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/group/read') {
      const body = (await readJson(request)) as { limit?: unknown };
      const limit =
        typeof body?.limit === 'number' && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), MAX_GROUP_PAGE) : 50;
      // Read after the member's stored cursor and advance it, so a read is
      // incremental and stateless for the caller.
      const cursor = store.getGroupCursor(member.name);
      const messages = store.groupMessages(cursor, limit);
      if (messages.length > 0) store.setGroupCursor(member.name, messages.at(-1)!.seq);
      sendJson(response, 200, { messages, cursor: store.getGroupCursor(member.name), latestSeq: store.groupLatestSeq() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/inbox') {
      const messages = store.unreadDms(member.name, MAX_INBOX_PAGE);
      sendJson(response, 200, { count: store.unreadDmCount(member.name), messages });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/history') {
      const scope = url.searchParams.get('scope');
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw === null ? 0 : Number(beforeRaw);
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 50 : Number(limitRaw);
      if ((scope !== 'group' && scope !== 'dm') || !Number.isInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1) {
        sendJson(response, 400, { error: 'history needs scope=group|dm and non-negative before, positive limit.' });
        return;
      }
      const page = Math.min(limit, MAX_HISTORY_PAGE);
      if (scope === 'group') {
        sendJson(response, 200, { messages: store.groupHistory(before, page) });
        return;
      }
      const peer = (url.searchParams.get('peer') ?? '').trim();
      const canonical = peer ? store.canonicalMemberName(peer) : null;
      if (!canonical) {
        sendJson(response, 404, { error: `No member named "${peer}" in this team.` });
        return;
      }
      sendJson(response, 200, { messages: store.dmHistory(member.name, canonical, before, page) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/files') {
      sendJson(response, 200, { files: store.filesForMember(member.name) });
      return;
    }
    const fileMatch = /^\/v1\/files\/(f_[0-9a-f]+)$/.exec(url.pathname);
    if (request.method === 'GET' && fileMatch) {
      const file = store.getFile(fileMatch[1]!);
      if (!file) {
        sendJson(response, 404, { error: 'No such file.' });
        return;
      }
      if (file.recipient !== member.name && file.recipient !== GROUP_RECIPIENT && file.sender !== member.name) {
        sendJson(response, 403, { error: 'This file is not addressed to you.' });
        return;
      }
      if (!fileExists(file.id)) {
        sendJson(response, 410, { error: 'The file bytes are no longer on the hub.' });
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': file.size,
        'x-file-name': encodeURIComponent(file.name),
        'x-file-sha256': file.sha256,
      });
      await pipeline(readFileStream(file.id), response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/files') {
      const recipient = url.searchParams.get('recipient') ?? '';
      const name = url.searchParams.get('name') ?? '';
      const sha256 = url.searchParams.get('sha256') ?? '';
      const size = Number(url.searchParams.get('size') ?? '');
      const id = makeFileId();
      ensureFilesDir();
      const destination = filePath(id);
      const hash = createHash('sha256');
      let received = 0;
      let overflowed = false;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > MAX_FILE_BYTES) {
            overflowed = true;
            callback(new Error('File exceeds the size limit.'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(request, meter, createWriteStream(destination));
      } catch {
        deleteFileBytes(id);
        sendJson(response, overflowed ? 413 : 400, { error: overflowed ? 'File exceeds the size limit.' : 'Upload failed.' });
        return;
      }
      if (received !== size || hash.digest('hex') !== sha256) {
        deleteFileBytes(id);
        sendJson(response, 400, { error: 'Uploaded bytes do not match the declared size or sha256.' });
        return;
      }
      try {
        const message = operations.registerFile(member.name, { recipient, name, size, sha256, fileId: id });
        sendJson(response, 200, { id, seq: message.seq, msgId: message.msgId });
      } catch (error) {
        deleteFileBytes(id);
        if (error instanceof TeamError) {
          sendJson(response, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/inbox/read') {
      const body = (await readJson(request)) as { limit?: unknown };
      const limit =
        typeof body?.limit === 'number' && Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), MAX_INBOX_PAGE) : 20;
      // Read and consume in one step: a read direct message is handled, so it
      // never returns on a later wake.
      const messages = store.unreadDms(member.name, limit);
      if (messages.length > 0)
        store.ackDms(
          member.name,
          messages.map((message) => message.msgId),
          now,
        );
      sendJson(response, 200, { count: messages.length, messages, remaining: store.unreadDmCount(member.name) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/inbox/ack') {
      const body = (await readJson(request)) as { msgIds?: unknown };
      const ids = Array.isArray(body?.msgIds) ? body.msgIds.filter((id): id is string => typeof id === 'string') : null;
      if (!ids) {
        sendJson(response, 400, { error: 'ack needs { msgIds: [...] }.' });
        return;
      }
      const acknowledged = store.ackDms(member.name, ids, now);
      sendJson(response, 200, { acknowledged, remaining: store.unreadDmCount(member.name) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/memory') {
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw === null ? 0 : Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) {
        sendJson(response, 400, { error: 'since must be a non-negative integer.' });
        return;
      }
      sendJson(response, 200, { latestSeq: store.memoryLatestSeq(), entries: store.memoryEntries(since, MAX_MEMORY_PAGE) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/memory') {
      const body = (await readJson(request)) as { topic?: unknown; body?: unknown };
      if ((body?.topic !== 'decisions' && body?.topic !== 'shared') || typeof body?.body !== 'string') {
        sendJson(response, 400, { error: 'Remembering needs { topic: "decisions"|"shared", body }.' });
        return;
      }
      try {
        const seq = operations.appendMemory(member.name, body.topic, body.body);
        store.appendAudit({ kind: 'memory.appended', actor: member.name, detail: body.topic, createdAt: now });
        sendJson(response, 200, { seq, latestSeq: store.memoryLatestSeq() });
      } catch (error) {
        if (error instanceof TeamError) {
          sendJson(response, error.status, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/leave') {
      if (member.role === 'hub') {
        sendJson(response, 403, { error: 'The hub cannot leave its own team. Shut the team down instead.' });
        return;
      }
      store.removeMember(member.name, now);
      store.appendAudit({ kind: 'member.left', actor: member.name, detail: null, createdAt: now });
      sendJson(response, 200, { left: true });
      return;
    }
    sendJson(response, 404, { error: 'Unknown team endpoint.' });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindAddress, () => {
      server.off('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://${bindAddress}:${boundPort}`,
        close: () =>
          new Promise<void>((done, failed) => {
            server.close((error?: Error) => (error ? failed(error) : done()));
          }),
      });
    });
  });
}
