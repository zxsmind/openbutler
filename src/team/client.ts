import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JoinTarget } from './tailnet.js';
import type { PeerProfile, PeerCapabilities } from './coordination.js';

const REQUEST_TIMEOUT_MS = 15_000;

/** Thrown when the hub cannot be reached at all (network/timeout), as opposed to a refusal. */
export class HubUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnreachableError';
  }
}

export interface HubFingerprint {
  team: string;
  fingerprint: string;
  teamId: string;
}

export type JoinPollResult =
  { status: 'pending' } | { status: 'denied' } | { status: 'approved'; ticket: string; team: string; teamId: string; memberName: string };

export interface HubMember {
  name: string;
  role: string;
  online?: boolean;
  lastSeen?: number;
  lastMessageAt?: number | null;
  lastMessageTo?: string | null;
  lastMemoryAt?: number | null;
  profile?: PeerProfile | null;
  capabilities?: PeerCapabilities | null;
  activeWorkCount?: number;
}

export interface HubStatus {
  protocol: string;
  team: string;
  you: string;
  memberCount?: number;
  groupCursor?: number;
  groupLatestSeq?: number;
  members: HubMember[];
}

function baseUrl(target: JoinTarget): string {
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host;
  return `http://${host}:${target.port}`;
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON hub answers are hub bugs; surface the status instead.
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new HubUnreachableError(`Hub did not answer within ${timeoutMs / 1000}s: ${url}`);
    throw new HubUnreachableError(`Cannot reach the hub at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function hubError(status: number, body: Record<string, unknown>, fallback: string): Error {
  const detail = typeof body.error === 'string' && body.error ? body.error : fallback;
  return new Error(`Hub refused (${status}): ${detail}`);
}

/** The server binds the actor to the ticket; the input never selects an acting member. */
export async function peerOperation(
  target: JoinTarget,
  ticket: string,
  operation: 'profile' | 'work' | 'capabilities',
  input: Record<string, unknown>,
): Promise<unknown> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (status !== 200) throw hubError(status, body, 'Peer operation failed.');
  return body.result;
}

/** Who the hub claims to be. Compare the fingerprint with the invite before trusting it. */
export async function fetchHubFingerprint(target: JoinTarget): Promise<HubFingerprint> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/fingerprint`, {});
  if (status !== 200 || typeof body.team !== 'string' || typeof body.fingerprint !== 'string')
    throw hubError(status, body, 'Unexpected hub answer.');
  return { team: body.team, fingerprint: body.fingerprint, teamId: typeof body.teamId === 'string' ? body.teamId : '' };
}

/** Opens a join request. Returns the request id; approval still needs the hub owner. */
export async function postJoin(target: JoinTarget, code: string, name: string): Promise<string> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  if (status !== 202 || typeof body.requestId !== 'string') throw hubError(status, body, 'Join was not accepted.');
  return body.requestId;
}

/**
 * Polls one join request. Approved answers carry the ticket exactly once:
 * the hub forgets it after this call, so the caller must persist it now.
 */
export async function pollJoin(target: JoinTarget, requestId: string): Promise<JoinPollResult> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/join/${encodeURIComponent(requestId)}`, {});
  if (status === 200 && body.status === 'pending') return { status: 'pending' };
  if (status === 200 && body.status === 'denied') return { status: 'denied' };
  if (status === 200 && body.status === 'approved' && typeof body.ticket === 'string') {
    if (typeof body.team !== 'string' || typeof body.memberName !== 'string')
      throw hubError(status, body, 'Approval answer is incomplete.');
    return {
      status: 'approved',
      ticket: body.ticket,
      team: body.team,
      teamId: typeof body.teamId === 'string' ? body.teamId : '',
      memberName: body.memberName,
    };
  }
  throw hubError(status, body, 'Join status is unknown.');
}

/** Confirms a ticket was received, so the hub stops handing it out. */
export async function confirmJoin(target: JoinTarget, requestId: string): Promise<void> {
  await requestJson(`${baseUrl(target)}/v1/join/${encodeURIComponent(requestId)}/confirm`, { method: 'POST' }).catch(() => undefined);
}

/** Authenticated: who the hub sees and who else is in the team. */
export async function fetchHubStatus(target: JoinTarget, ticket: string): Promise<HubStatus> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/status`, { headers: { authorization: `Bearer ${ticket}` } });
  if (status !== 200 || typeof body.team !== 'string' || typeof body.you !== 'string' || !Array.isArray(body.members))
    throw hubError(status, body, 'Status answer is incomplete.');
  return body as unknown as HubStatus;
}

/** Authenticated: leave the team. The hub revokes the ticket immediately. */
export async function postLeave(target: JoinTarget, ticket: string): Promise<void> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/leave`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}` },
  });
  if (status !== 200) throw hubError(status, body, 'Leave was not accepted.');
}

export interface TeamMessage {
  seq: number;
  msgId: string;
  sender: string;
  recipient: string;
  body: string;
  createdAt: number;
  replyTo: string | null;
}

export interface SendResult {
  msgId: string;
  seq?: number;
  createdAt?: number;
  duplicate?: boolean;
}

/** Authenticated: post to the group or DM a member. `replyTo` threads a reply. */
export async function postMessage(
  target: JoinTarget,
  ticket: string,
  input: { recipient: string; body: string; replyTo?: string; msgId?: string },
): Promise<SendResult> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (status !== 200 || typeof body.msgId !== 'string') throw hubError(status, body, 'Message was not accepted.');
  return body as unknown as SendResult;
}

/** Authenticated: group messages after `since`, oldest first. */
export async function fetchGroup(
  target: JoinTarget,
  ticket: string,
  since: number,
): Promise<{ latestSeq: number; messages: TeamMessage[] }> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/group?since=${since}`, {
    headers: { authorization: `Bearer ${ticket}` },
  });
  if (status !== 200 || !Array.isArray(body.messages)) throw hubError(status, body, 'Group read failed.');
  return body as unknown as { latestSeq: number; messages: TeamMessage[] };
}

/** Authenticated: advance this member's group read cursor. */
export async function setGroupCursor(target: JoinTarget, ticket: string, seq: number): Promise<void> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/group/cursor`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify({ seq }),
  });
  if (status !== 200) throw hubError(status, body, 'Cursor update failed.');
}

/** Authenticated: read new group messages after this member's stored cursor, advancing it. */
export async function readGroup(
  target: JoinTarget,
  ticket: string,
  limit: number,
): Promise<{ messages: TeamMessage[]; cursor: number; latestSeq: number }> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/group/read`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  if (status !== 200 || !Array.isArray(body.messages)) throw hubError(status, body, 'Group read failed.');
  return body as unknown as { messages: TeamMessage[]; cursor: number; latestSeq: number };
}

/** Authenticated: page older messages from the group or a DM conversation, newest first. */
export async function fetchHistory(
  target: JoinTarget,
  ticket: string,
  query: { scope: 'group' | 'dm'; peer?: string; before?: number; limit?: number },
): Promise<{ messages: TeamMessage[] }> {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.peer) params.set('peer', query.peer);
  if (query.before) params.set('before', String(query.before));
  if (query.limit) params.set('limit', String(query.limit));
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/history?${params.toString()}`, {
    headers: { authorization: `Bearer ${ticket}` },
  });
  if (status !== 200 || !Array.isArray(body.messages)) throw hubError(status, body, 'History read failed.');
  return body as unknown as { messages: TeamMessage[] };
}

export interface TeamFileInfo {
  id: string;
  name: string;
  size: number;
  sha256: string;
  sender: string;
  recipient: string;
  createdAt: number;
}

/** Authenticated: files this member can receive (addressed to them or to the group). */
export async function listFiles(target: JoinTarget, ticket: string): Promise<TeamFileInfo[]> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/files`, { headers: { authorization: `Bearer ${ticket}` } });
  if (status !== 200 || !Array.isArray(body.files)) throw hubError(status, body, 'File list failed.');
  return body.files as TeamFileInfo[];
}

/**
 * Streams a local file to the hub as a shared file, without buffering it in
 * memory. The caller supplies the name, size, and sha256 it measured.
 */
export async function uploadFile(
  target: JoinTarget,
  ticket: string,
  input: { recipient: string; name: string; size: number; sha256: string; source: NodeJS.ReadableStream },
): Promise<{ id: string; seq: number }> {
  const params = new URLSearchParams({ recipient: input.recipient, name: input.name, size: String(input.size), sha256: input.sha256 });
  const response = await fetch(`${baseUrl(target)}/v1/files?${params.toString()}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/octet-stream', 'content-length': String(input.size) },
    body: Readable.toWeb(input.source as Readable) as ReadableStream,
    // Node's fetch needs this to send a streamed request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON hub answers surface as a status error below */
  }
  if (!response.ok || typeof body.id !== 'string') throw hubError(response.status, body, 'File upload failed.');
  return body as unknown as { id: string; seq: number };
}

/**
 * Streams a shared file from the hub to a local path, verifying size and
 * sha256 as it writes. Writes to a temporary file and renames on success, so a
 * failed transfer never leaves a partial file at the destination.
 */
export async function downloadFile(
  target: JoinTarget,
  ticket: string,
  id: string,
  destination: string,
): Promise<{ name: string; size: number; sha256: string }> {
  const response = await fetch(`${baseUrl(target)}/v1/files/${id}`, { headers: { authorization: `Bearer ${ticket}` } });
  if (!response.ok || !response.body) {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    throw hubError(response.status, body, 'File download failed.');
  }
  const name = decodeURIComponent(response.headers.get('x-file-name') ?? '');
  const sha256 = response.headers.get('x-file-sha256') ?? '';
  const size = Number(response.headers.get('content-length') ?? '0');
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(temporary));
    if (received !== size || hash.digest('hex') !== sha256) throw new Error('Downloaded bytes do not match the file hash.');
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { name, size, sha256 };
}

/** Authenticated: unread DMs for this member. */
export async function fetchInbox(target: JoinTarget, ticket: string): Promise<{ count: number; messages: TeamMessage[] }> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/inbox`, { headers: { authorization: `Bearer ${ticket}` } });
  if (status !== 200 || !Array.isArray(body.messages)) throw hubError(status, body, 'Inbox read failed.');
  return body as unknown as { count: number; messages: TeamMessage[] };
}

/** Authenticated: read unread DMs and consume them in one step (reading is handled). */
export async function readInbox(
  target: JoinTarget,
  ticket: string,
  limit: number,
): Promise<{ count: number; messages: TeamMessage[]; remaining: number }> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/inbox/read`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  if (status !== 200 || !Array.isArray(body.messages)) throw hubError(status, body, 'Inbox read failed.');
  return body as unknown as { count: number; messages: TeamMessage[]; remaining: number };
}

/** Authenticated: acknowledge DMs so they stop counting as unread. */
export async function ackInbox(
  target: JoinTarget,
  ticket: string,
  msgIds: readonly string[],
): Promise<{ acknowledged: number; remaining: number }> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/inbox/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify({ msgIds }),
  });
  if (status !== 200) throw hubError(status, body, 'Ack failed.');
  return body as unknown as { acknowledged: number; remaining: number };
}

export interface TeamMemoryEntry {
  seq: number;
  topic: 'decisions' | 'shared';
  author: string;
  body: string;
  createdAt: number;
}

/** Authenticated: shared team-memory entries after `since`, oldest first. */
export async function fetchTeamMemory(
  target: JoinTarget,
  ticket: string,
  since: number,
): Promise<{ latestSeq: number; entries: TeamMemoryEntry[] }> {
  const { status, body } = await requestJson(`${baseUrl(target)}/v1/memory?since=${since}`, {
    headers: { authorization: `Bearer ${ticket}` },
  });
  if (status !== 200 || !Array.isArray(body.entries)) throw hubError(status, body, 'Memory read failed.');
  return body as unknown as { latestSeq: number; entries: TeamMemoryEntry[] };
}

/** Authenticated: append a signed entry to shared team memory. */
export async function postTeamMemory(
  target: JoinTarget,
  ticket: string,
  topic: 'decisions' | 'shared',
  body: string,
): Promise<{ seq: number }> {
  const { status, body: response } = await requestJson(`${baseUrl(target)}/v1/memory`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
    body: JSON.stringify({ topic, body }),
  });
  if (status !== 200 || typeof response.seq !== 'number') throw hubError(status, response, 'Memory write failed.');
  return response as unknown as { seq: number };
}
