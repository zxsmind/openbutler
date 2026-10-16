import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getDataPath } from '../paths.js';

const TEAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS team_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  name TEXT PRIMARY KEY,
  name_lower TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('hub', 'member')),
  ticket_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS team_invites (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT
);
CREATE TABLE IF NOT EXISTS team_join_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')) DEFAULT 'pending',
  decided_at INTEGER,
  ticket TEXT
);
CREATE TABLE IF NOT EXISTS team_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reply_to TEXT
);
CREATE INDEX IF NOT EXISTS team_messages_recipient_seq_idx ON team_messages(recipient, seq);
CREATE TABLE IF NOT EXISTS team_group_cursors (
  member TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS team_dm_acks (
  msg_id TEXT PRIMARY KEY,
  reader TEXT NOT NULL,
  acked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_memory (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL CHECK (topic IN ('decisions', 'shared')),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`;

export interface TeamMember {
  name: string;
  role: 'hub' | 'member';
  createdAt: number;
  lastSeen: number;
  removedAt: number | null;
}

export interface TeamInvite {
  code: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
}

export type JoinStatus = 'pending' | 'approved' | 'denied';

export interface TeamMessage {
  seq: number;
  msgId: string;
  sender: string;
  recipient: string;
  body: string;
  createdAt: number;
  replyTo: string | null;
}

export interface JoinRequest {
  id: string;
  name: string;
  code: string;
  createdAt: number;
  status: JoinStatus;
  decidedAt: number | null;
}

export type TeamMemoryTopic = 'decisions' | 'shared';

export interface TeamMemoryEntry {
  seq: number;
  topic: TeamMemoryTopic;
  author: string;
  body: string;
  createdAt: number;
}

export interface TeamAuditEntry {
  seq: number;
  kind: string;
  actor: string;
  detail: string | null;
  createdAt: number;
}

export interface MemberSummary {
  name: string;
  role: 'hub' | 'member';
  online: boolean;
  lastSeen: number;
  lastMessageAt: number | null;
  lastMessageTo: string | null;
  lastMemoryAt: number | null;
}

/**
 * Hub-side team database. Tickets live here hashed; the single raw ticket of
 * an approved join stays only until the joiner picks it up once, then it is
 * nulled. The file is owner-only: it holds bearer-equivalent material.
 */
export class TeamStore {
  private readonly database: DatabaseSync;

  constructor(path: string = getDataPath('team.db')) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.database.exec(TEAM_SCHEMA);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows uses the directory ACL. */
    }
  }

  close(): void {
    this.database.close();
  }

  getMeta(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM team_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.database
      .prepare('INSERT INTO team_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  initHub(hubId: string, teamName: string, hubName: string, now: number): void {
    if (this.getMeta('hub_id') !== null) throw new Error('This machine already initialized a team. Leave or reset it first.');
    this.setMeta('hub_id', hubId);
    this.setMeta('team_name', teamName);
    this.database
      .prepare(
        "INSERT INTO team_members (name, name_lower, role, ticket_hash, created_at, last_seen, removed_at) VALUES (?, ?, 'hub', NULL, ?, ?, NULL)",
      )
      .run(hubName, hubName.toLowerCase(), now, now);
  }

  isInitialized(): boolean {
    return this.getMeta('hub_id') !== null;
  }

  createInvite(code: string, ttlMs: number, now: number): void {
    this.database
      .prepare('INSERT INTO team_invites (code, created_at, expires_at, used_at, used_by) VALUES (?, ?, ?, NULL, NULL)')
      .run(code, now, now + ttlMs);
  }

  /** Live invite or null (missing, used, or expired). Expired rows are pruned on read. */
  getInvite(code: string, now: number): TeamInvite | null {
    this.database.prepare('DELETE FROM team_invites WHERE expires_at <= ? AND used_at IS NULL').run(now);
    const row = this.database
      .prepare(
        'SELECT code, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt, used_by AS usedBy FROM team_invites WHERE code = ?',
      )
      .get(code) as TeamInvite | undefined;
    if (!row || row.usedAt !== null) return null;
    return row;
  }

  /** Marks the invite used. False when it was already gone (single-use race). */
  consumeInvite(code: string, usedBy: string, now: number): boolean {
    const result = this.database
      .prepare('UPDATE team_invites SET used_at = ?, used_by = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?')
      .run(now, usedBy, code, now);
    return result.changes === 1;
  }

  revokeInvite(code: string): boolean {
    return this.database.prepare('DELETE FROM team_invites WHERE code = ?').run(code).changes === 1;
  }

  listInvites(now: number): TeamInvite[] {
    this.database.prepare('DELETE FROM team_invites WHERE expires_at <= ? AND used_at IS NULL').run(now);
    return this.database
      .prepare(
        'SELECT code, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt, used_by AS usedBy FROM team_invites WHERE used_at IS NULL ORDER BY created_at',
      )
      .all() as unknown as TeamInvite[];
  }

  /** Case-insensitive, among active members only. Removed names stay retired: never reused. */
  nameTaken(name: string): boolean {
    const row = this.database.prepare('SELECT 1 FROM team_members WHERE name_lower = ?').get(name.toLowerCase()) as
      { '1': number } | undefined;
    return !!row;
  }

  createJoinRequest(id: string, name: string, code: string, now: number): void {
    this.database
      .prepare(
        "INSERT INTO team_join_requests (id, name, code, created_at, status, decided_at, ticket) VALUES (?, ?, ?, ?, 'pending', NULL, NULL)",
      )
      .run(id, name, code, now);
  }

  getJoinRequest(id: string): JoinRequest | null {
    const row = this.database
      .prepare('SELECT id, name, code, created_at AS createdAt, status, decided_at AS decidedAt FROM team_join_requests WHERE id = ?')
      .get(id) as JoinRequest | undefined;
    return row ?? null;
  }

  listPendingJoins(): JoinRequest[] {
    return this.database
      .prepare(
        "SELECT id, name, code, created_at AS createdAt, status, decided_at AS decidedAt FROM team_join_requests WHERE status = 'pending' ORDER BY created_at",
      )
      .all() as unknown as JoinRequest[];
  }

  /**
   * Decides a pending request. On approval the raw ticket is stored for a
   * single pickup and its hash is returned alongside; on denial nothing is
   * issued. Deciding twice is refused.
   */
  decideJoin(id: string, approve: boolean, ticket: string | null, ticketHash: string | null, now: number): boolean {
    const request = this.getJoinRequest(id);
    if (!request || request.status !== 'pending') return false;
    if (approve) {
      if (!ticket || !ticketHash) throw new Error('Approving a join needs a ticket.');
      if (this.nameTaken(request.name)) return false;
      this.database
        .prepare('UPDATE team_join_requests SET status = ?, decided_at = ?, ticket = ? WHERE id = ? AND status = ?')
        .run('approved', now, ticket, id, 'pending');
      this.database
        .prepare(
          "INSERT INTO team_members (name, name_lower, role, ticket_hash, created_at, last_seen, removed_at) VALUES (?, ?, 'member', ?, ?, ?, NULL)",
        )
        .run(request.name, request.name.toLowerCase(), ticketHash, now, now);
      return true;
    }
    this.database
      .prepare('UPDATE team_join_requests SET status = ?, decided_at = ?, ticket = NULL WHERE id = ? AND status = ?')
      .run('denied', now, id, 'pending');
    return true;
  }

  /** Returns the raw ticket exactly once, then forgets it. */
  revealTicket(id: string): string | null {
    const row = this.database.prepare("SELECT ticket FROM team_join_requests WHERE id = ? AND status = 'approved'").get(id) as
      { ticket: string | null } | undefined;
    if (!row || !row.ticket) return null;
    this.database.prepare('UPDATE team_join_requests SET ticket = NULL WHERE id = ?').run(id);
    return row.ticket;
  }

  /** Revokes the member: ticket hash dropped, name retired (never reusable). */
  removeMember(name: string, now: number): 'removed' | 'missing' | 'hub' {
    const row = this.database
      .prepare('SELECT role, removed_at AS removedAt FROM team_members WHERE name_lower = ?')
      .get(name.toLowerCase()) as
      | {
          role: string;
          removedAt: number | null;
        }
      | undefined;
    if (!row || row.removedAt !== null) return 'missing';
    if (row.role === 'hub') return 'hub';
    this.database.prepare('UPDATE team_members SET ticket_hash = NULL, removed_at = ? WHERE name_lower = ?').run(now, name.toLowerCase());
    return 'removed';
  }

  findByTicketHash(ticketHash: string): TeamMember | null {
    const row = this.database
      .prepare(
        'SELECT name, role, created_at AS createdAt, last_seen AS lastSeen, removed_at AS removedAt FROM team_members WHERE ticket_hash = ? AND removed_at IS NULL',
      )
      .get(ticketHash) as TeamMember | undefined;
    return row ?? null;
  }

  listMembers(): TeamMember[] {
    return this.database
      .prepare(
        'SELECT name, role, created_at AS createdAt, last_seen AS lastSeen, removed_at AS removedAt FROM team_members WHERE removed_at IS NULL ORDER BY created_at',
      )
      .all() as unknown as TeamMember[];
  }

  touchMember(name: string, now: number): void {
    this.database.prepare('UPDATE team_members SET last_seen = ? WHERE name_lower = ? AND removed_at IS NULL').run(now, name.toLowerCase());
  }

  /**
   * Appends a message. `seq` is the AUTOINCREMENT rowid, so ordering is
   * atomic and total without any app-level counter; `createdAt` is the hub
   * clock, the single time authority for the team.
   */
  postMessage(input: {
    msgId: string;
    sender: string;
    recipient: string;
    body: string;
    createdAt: number;
    replyTo?: string | null;
  }): TeamMessage {
    const info = this.database
      .prepare('INSERT INTO team_messages (msg_id, sender, recipient, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.msgId, input.sender, input.recipient, input.body, input.createdAt, input.replyTo ?? null);
    return {
      seq: Number(info.lastInsertRowid),
      msgId: input.msgId,
      sender: input.sender,
      recipient: input.recipient,
      body: input.body,
      createdAt: input.createdAt,
      replyTo: input.replyTo ?? null,
    };
  }

  /** Group messages strictly after `sinceSeq`, oldest first. */
  groupMessages(sinceSeq: number, limit: number): TeamMessage[] {
    return this.database
      .prepare(
        "SELECT seq, msg_id AS msgId, sender, recipient, body, created_at AS createdAt, reply_to AS replyTo FROM team_messages WHERE recipient = 'group' AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(sinceSeq, limit) as unknown as TeamMessage[];
  }

  groupLatestSeq(): number {
    const row = this.database.prepare("SELECT MAX(seq) AS seq FROM team_messages WHERE recipient = 'group'").get() as
      { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  getGroupCursor(member: string): number {
    const row = this.database.prepare('SELECT last_seq AS lastSeq FROM team_group_cursors WHERE member = ?').get(member) as
      { lastSeq: number } | undefined;
    return row?.lastSeq ?? 0;
  }

  setGroupCursor(member: string, seq: number): void {
    this.database
      .prepare(
        'INSERT INTO team_group_cursors (member, last_seq) VALUES (?, ?) ON CONFLICT(member) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)',
      )
      .run(member, seq);
  }

  /** Direct messages to `member` that have not been acknowledged yet, oldest first. */
  unreadDms(member: string, limit: number): TeamMessage[] {
    return this.database
      .prepare(
        'SELECT m.seq AS seq, m.msg_id AS msgId, m.sender AS sender, m.recipient AS recipient, m.body AS body, m.created_at AS createdAt, m.reply_to AS replyTo ' +
          'FROM team_messages m LEFT JOIN team_dm_acks a ON a.msg_id = m.msg_id ' +
          'WHERE m.recipient = ? AND a.msg_id IS NULL ORDER BY m.seq LIMIT ?',
      )
      .all(member, limit) as unknown as TeamMessage[];
  }

  unreadDmCount(member: string): number {
    const row = this.database
      .prepare(
        'SELECT COUNT(*) AS count FROM team_messages m LEFT JOIN team_dm_acks a ON a.msg_id = m.msg_id WHERE m.recipient = ? AND a.msg_id IS NULL',
      )
      .get(member) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Acknowledges the named DMs the member owns. Returns how many were newly acknowledged. */
  ackDms(member: string, msgIds: readonly string[], now: number): number {
    let acknowledged = 0;
    const insert = this.database.prepare(
      'INSERT INTO team_dm_acks (msg_id, reader, acked_at) SELECT msg_id, ?, ? FROM team_messages WHERE msg_id = ? AND recipient = ? ON CONFLICT(msg_id) DO NOTHING',
    );
    for (const msgId of msgIds) acknowledged += Number(insert.run(member, now, msgId, member).changes);
    return acknowledged;
  }

  /** Whether a message id is already stored, so a retry cannot duplicate it. */
  hasMessage(msgId: string): boolean {
    const row = this.database.prepare('SELECT 1 FROM team_messages WHERE msg_id = ?').get(msgId) as { '1': number } | undefined;
    return !!row;
  }

  /** Appends a signed team-memory entry. The hub is the single source of truth. */
  appendMemory(input: { topic: TeamMemoryTopic; author: string; body: string; createdAt: number }): number {
    const info = this.database
      .prepare('INSERT INTO team_memory (topic, author, body, created_at) VALUES (?, ?, ?, ?)')
      .run(input.topic, input.author, input.body, input.createdAt);
    return Number(info.lastInsertRowid);
  }

  /** Signed entries strictly after `sinceSeq`, oldest first. */
  memoryEntries(sinceSeq: number, limit: number): TeamMemoryEntry[] {
    return this.database
      .prepare('SELECT seq, topic, author, body, created_at AS createdAt FROM team_memory WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(sinceSeq, limit) as unknown as TeamMemoryEntry[];
  }

  memoryLatestSeq(): number {
    const row = this.database.prepare('SELECT MAX(seq) AS seq FROM team_memory').get() as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  /** Append-only audit trail of protocol events. Never updated, never deleted. */
  appendAudit(input: { kind: string; actor: string; detail?: string | null; createdAt: number }): void {
    this.database
      .prepare('INSERT INTO team_audit (kind, actor, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(input.kind, input.actor, input.detail ?? null, input.createdAt);
  }

  /** Most recent audit entries first. */
  listAudit(limit: number): TeamAuditEntry[] {
    return this.database
      .prepare('SELECT seq, kind, actor, detail, created_at AS createdAt FROM team_audit ORDER BY seq DESC LIMIT ?')
      .all(limit) as unknown as TeamAuditEntry[];
  }

  /**
   * Active members considered online: the hub always (it is answering this
   * very query), and any member seen within `windowMs`. The hub talks to its
   * own store directly, so it never touches its own last_seen; treating it as
   * online while it serves is the honest reading.
   */
  onlineMemberNames(now: number, windowMs: number): Set<string> {
    const rows = this.database
      .prepare("SELECT name FROM team_members WHERE removed_at IS NULL AND (role = 'hub' OR last_seen >= ?)")
      .all(now - windowMs) as unknown as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  /**
   * One row per active member with presence and last activity: when they last
   * sent a message (and where), and when they last wrote shared memory. The
   * hub derives this so every member sees the same picture.
   */
  memberSummaries(now: number, windowMs: number): MemberSummary[] {
    const online = this.onlineMemberNames(now, windowMs);
    const rows = this.database
      .prepare(
        `SELECT m.name AS name, m.role AS role, m.last_seen AS lastSeen,
           (SELECT created_at FROM team_messages WHERE sender = m.name ORDER BY seq DESC LIMIT 1) AS lastMessageAt,
           (SELECT recipient FROM team_messages WHERE sender = m.name ORDER BY seq DESC LIMIT 1) AS lastMessageTo,
           (SELECT created_at FROM team_memory WHERE author = m.name ORDER BY seq DESC LIMIT 1) AS lastMemoryAt
         FROM team_members m WHERE m.removed_at IS NULL ORDER BY m.created_at`,
      )
      .all() as unknown as Array<Omit<MemberSummary, 'online'>>;
    return rows.map((row) => ({ ...row, online: online.has(row.name) }));
  }
}
