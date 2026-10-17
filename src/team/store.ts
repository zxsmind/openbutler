import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getDataPath } from '../paths.js';
import { TERMINAL_WORK_STATES, type PeerProfile, type PeerCapabilities, type PeerWork } from './coordination.js';

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
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  file_id TEXT,
  created_at INTEGER NOT NULL,
  reply_to TEXT
);
CREATE INDEX IF NOT EXISTS team_messages_recipient_seq_idx ON team_messages(recipient, seq);
CREATE TABLE IF NOT EXISTS team_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
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
CREATE TABLE IF NOT EXISTS team_profiles (
  member TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_capabilities (
  member TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_work (
  id TEXT PRIMARY KEY,
  requester TEXT NOT NULL,
  assignee TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_work_requester_idx ON team_work(requester, updated_at);
CREATE INDEX IF NOT EXISTS team_work_assignee_idx ON team_work(assignee, updated_at);
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
  kind: string;
  body: string;
  fileId: string | null;
  createdAt: number;
  replyTo: string | null;
}

export interface TeamFile {
  id: string;
  name: string;
  size: number;
  sha256: string;
  sender: string;
  recipient: string;
  createdAt: number;
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
  profile: PeerProfile | null;
  capabilities: PeerCapabilities | null;
  activeWorkCount: number;
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
    // Older databases predate the message kind/file columns; add them in place.
    const messageColumns = this.database.prepare('PRAGMA table_info(team_messages)').all() as unknown as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === 'kind'))
      this.database.exec("ALTER TABLE team_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
    if (!messageColumns.some((column) => column.name === 'file_id'))
      this.database.exec('ALTER TABLE team_messages ADD COLUMN file_id TEXT');
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

  peerProfile(member: string): PeerProfile | null {
    const row = this.database.prepare('SELECT value FROM team_profiles WHERE member = ?').get(member) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as PeerProfile) : null;
  }

  savePeerProfile(member: string, profile: PeerProfile, expected: number): boolean {
    const result =
      expected === 0
        ? this.database
            .prepare('INSERT OR IGNORE INTO team_profiles (member, revision, value) VALUES (?, ?, ?)')
            .run(member, profile.revision, JSON.stringify(profile))
        : this.database
            .prepare('UPDATE team_profiles SET revision = ?, value = ? WHERE member = ? AND revision = ?')
            .run(profile.revision, JSON.stringify(profile), member, expected);
    return result.changes === 1;
  }

  peerCapabilities(member: string): PeerCapabilities | null {
    const row = this.database.prepare('SELECT value FROM team_capabilities WHERE member = ?').get(member) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as PeerCapabilities) : null;
  }

  savePeerCapabilities(member: string, report: PeerCapabilities): void {
    this.database
      .prepare('INSERT INTO team_capabilities (member, value) VALUES (?, ?) ON CONFLICT(member) DO UPDATE SET value = excluded.value')
      .run(member, JSON.stringify(report));
  }

  peerWork(id: string): PeerWork | null {
    const row = this.database.prepare('SELECT value FROM team_work WHERE id = ?').get(id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as PeerWork) : null;
  }

  listPeerWork(member: string, includeClosed: boolean, limit: number, offset: number): PeerWork[] {
    const terminal = TERMINAL_WORK_STATES.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `SELECT value FROM team_work WHERE (requester = ? OR assignee = ?) ${includeClosed ? '' : `AND state NOT IN (${terminal})`} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(member, member, ...(includeClosed ? [] : TERMINAL_WORK_STATES), limit, offset) as unknown as Array<{ value: string }>;
    return rows.map((row) => JSON.parse(row.value) as PeerWork);
  }

  activePeerWorkCount(member: string): number {
    const terminal = TERMINAL_WORK_STATES.map(() => '?').join(', ');
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM team_work WHERE assignee = ? AND state NOT IN (${terminal}, 'proposed', 'countered')`)
      .get(member, ...TERMINAL_WORK_STATES) as { count: number };
    return row.count;
  }

  savePeerWork(
    work: PeerWork,
    expected: number,
    notice: { msgId: string; sender: string; recipient: string; body: string; createdAt: number },
  ): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result =
        expected === 0
          ? this.database
              .prepare(
                'INSERT OR IGNORE INTO team_work (id, requester, assignee, state, revision, updated_at, value) VALUES (?, ?, ?, ?, ?, ?, ?)',
              )
              .run(work.id, work.requester, work.assignee, work.state, work.revision, work.updatedAt, JSON.stringify(work))
          : this.database
              .prepare('UPDATE team_work SET state = ?, revision = ?, updated_at = ?, value = ? WHERE id = ? AND revision = ?')
              .run(work.state, work.revision, work.updatedAt, JSON.stringify(work), work.id, expected);
      if (result.changes !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.postMessage(notice);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  setMeta(key: string, value: string): void {
    this.database
      .prepare('INSERT INTO team_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  initHub(hubId: string, teamId: string, teamName: string, hubName: string, now: number): void {
    if (this.getMeta('hub_id') !== null) throw new Error('This machine already initialized a team. Leave or reset it first.');
    this.setMeta('hub_id', hubId);
    this.setMeta('team_id', teamId);
    this.setMeta('team_name', teamName);
    this.database
      .prepare(
        "INSERT INTO team_members (name, name_lower, role, ticket_hash, created_at, last_seen, removed_at) VALUES (?, ?, 'hub', NULL, ?, ?, NULL)",
      )
      .run(hubName, hubName.toLowerCase(), now, now);
  }

  /** The team's stable, public identity. Used to key shared memory and to scope local state. */
  teamId(): string {
    return this.getMeta('team_id') ?? '';
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

  /**
   * The canonical stored name for an active member, matched case-insensitively,
   * or null. Every recipient is resolved through this so a message is always
   * stored under the member's real name, never the sender's spelling.
   */
  canonicalMemberName(name: string): string | null {
    const row = this.database
      .prepare('SELECT name FROM team_members WHERE name_lower = ? AND removed_at IS NULL')
      .get(name.toLowerCase()) as { name: string } | undefined;
    return row?.name ?? null;
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

  /**
   * Returns the approved ticket without consuming it, so a lost response can be
   * retried. The ticket is forgotten only on explicit confirmation or after the
   * pickup TTL, so delivery survives a dropped connection.
   */
  peekTicket(id: string, now: number, ttlMs: number): string | null {
    const row = this.database
      .prepare("SELECT ticket, decided_at AS decidedAt FROM team_join_requests WHERE id = ? AND status = 'approved'")
      .get(id) as { ticket: string | null; decidedAt: number | null } | undefined;
    if (!row || !row.ticket) return null;
    if (row.decidedAt !== null && now - row.decidedAt > ttlMs) {
      this.database.prepare('UPDATE team_join_requests SET ticket = NULL WHERE id = ?').run(id);
      return null;
    }
    return row.ticket;
  }

  /** Marks an approved ticket as picked up, so it is never handed out again. */
  confirmTicket(id: string): void {
    this.database.prepare('UPDATE team_join_requests SET ticket = NULL WHERE id = ?').run(id);
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
    kind?: string;
    fileId?: string | null;
  }): TeamMessage {
    const kind = input.kind ?? 'text';
    const fileId = input.fileId ?? null;
    const info = this.database
      .prepare(
        'INSERT INTO team_messages (msg_id, sender, recipient, kind, body, file_id, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.msgId, input.sender, input.recipient, kind, input.body, fileId, input.createdAt, input.replyTo ?? null);
    return {
      seq: Number(info.lastInsertRowid),
      msgId: input.msgId,
      sender: input.sender,
      recipient: input.recipient,
      kind,
      body: input.body,
      fileId,
      createdAt: input.createdAt,
      replyTo: input.replyTo ?? null,
    };
  }

  /** Group messages strictly after `sinceSeq`, oldest first. */
  groupMessages(sinceSeq: number, limit: number): TeamMessage[] {
    return this.database
      .prepare(
        "SELECT seq, msg_id AS msgId, sender, recipient, kind, body, file_id AS fileId, created_at AS createdAt, reply_to AS replyTo FROM team_messages WHERE recipient = 'group' AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(sinceSeq, limit) as unknown as TeamMessage[];
  }

  /** Group history page: messages before `beforeSeq` (0 = newest), newest first. */
  groupHistory(beforeSeq: number, limit: number): TeamMessage[] {
    const ceiling = beforeSeq > 0 ? beforeSeq : Number.MAX_SAFE_INTEGER;
    return this.database
      .prepare(
        "SELECT seq, msg_id AS msgId, sender, recipient, kind, body, file_id AS fileId, created_at AS createdAt, reply_to AS replyTo FROM team_messages WHERE recipient = 'group' AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(ceiling, limit) as unknown as TeamMessage[];
  }

  /** Direct-message history between two members, newest first, before `beforeSeq`. */
  dmHistory(memberA: string, memberB: string, beforeSeq: number, limit: number): TeamMessage[] {
    const ceiling = beforeSeq > 0 ? beforeSeq : Number.MAX_SAFE_INTEGER;
    return this.database
      .prepare(
        'SELECT seq, msg_id AS msgId, sender, recipient, kind, body, file_id AS fileId, created_at AS createdAt, reply_to AS replyTo FROM team_messages ' +
          'WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND seq < ? ORDER BY seq DESC LIMIT ?',
      )
      .all(memberA, memberB, memberB, memberA, ceiling, limit) as unknown as TeamMessage[];
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
        'SELECT m.seq AS seq, m.msg_id AS msgId, m.sender AS sender, m.recipient AS recipient, m.kind AS kind, m.body AS body, m.file_id AS fileId, m.created_at AS createdAt, m.reply_to AS replyTo ' +
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
    return rows.map((row) => ({
      ...row,
      online: online.has(row.name),
      profile: this.peerProfile(row.name),
      capabilities: this.peerCapabilities(row.name),
      activeWorkCount: this.activePeerWorkCount(row.name),
    }));
  }

  /** Records a shared file's metadata. The bytes live on the hub's disk, keyed by id. */
  insertFile(input: TeamFile): void {
    this.database
      .prepare('INSERT INTO team_files (id, name, size, sha256, sender, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.id, input.name, input.size, input.sha256, input.sender, input.recipient, input.createdAt);
  }

  getFile(id: string): TeamFile | null {
    const row = this.database
      .prepare('SELECT id, name, size, sha256, sender, recipient, created_at AS createdAt FROM team_files WHERE id = ?')
      .get(id) as TeamFile | undefined;
    return row ?? null;
  }

  /** Files a member can receive: addressed to them, or shared with the whole team. */
  filesForMember(member: string): TeamFile[] {
    return this.database
      .prepare(
        "SELECT id, name, size, sha256, sender, recipient, created_at AS createdAt FROM team_files WHERE recipient = ? OR recipient = 'group' ORDER BY created_at DESC",
      )
      .all(member) as unknown as TeamFile[];
  }

  /** Removes a file's metadata. The hub owner deletes the bytes separately. */
  removeFile(id: string): boolean {
    return this.database.prepare('DELETE FROM team_files WHERE id = ?').run(id).changes === 1;
  }
}
