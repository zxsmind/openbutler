import { TeamError } from './operations.js';
import type { TeamStore } from './store.js';

export interface PeerProfile {
  description: string;
  revision: number;
  updatedAt: number;
}

/** Reported by the member's host, never inferred from the agent's biography. */
export interface PeerCapabilities {
  platform: string;
  mcpServers: Array<{ name: string; toolCount: number }>;
  mcpTools: string[];
  custodianBusy: boolean;
  observedAt: number;
}

export type WorkState = 'proposed' | 'countered' | 'accepted' | 'working' | 'blocked' | 'completed' | 'failed' | 'rejected' | 'cancelled';
export const WORK_ACTIONS = [
  'propose',
  'counter',
  'accept',
  'reject',
  'start',
  'block',
  'resume',
  'complete',
  'fail',
  'cancel',
  'note',
] as const;
export type WorkAction = (typeof WORK_ACTIONS)[number];

export interface PeerWork {
  id: string;
  requester: string;
  assignee: string;
  originalTerms: string;
  terms: string;
  /** Older records without this field contain the requester's original proposal. */
  termsAuthor?: string;
  state: WorkState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastActor: string;
  lastAction: WorkAction;
  lastNote: string;
  result: string | null;
}

export const TERMINAL_WORK_STATES: readonly WorkState[] = ['completed', 'rejected', 'cancelled', 'failed'];
export const ACTIVE_WORK_STATES: readonly WorkState[] = ['accepted', 'working', 'blocked'];

function text(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TeamError(`${field} must be non-empty text of at most ${max} characters.`, 400);
  return value.trim();
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TeamError('expectedRevision must be a non-negative integer.', 400);
  return Number(value);
}

export function parseCapabilities(input: Record<string, unknown>, now: number): PeerCapabilities {
  const platform = text(input.platform, 'platform', 32);
  if (
    typeof input.custodianBusy !== 'boolean' ||
    !Array.isArray(input.mcpServers) ||
    input.mcpServers.length > 100 ||
    !Array.isArray(input.mcpTools) ||
    input.mcpTools.length > 1000
  )
    throw new TeamError('Invalid host capability report.', 400);
  const mcpServers = input.mcpServers.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new TeamError('Invalid MCP server report.', 400);
    const row = item as Record<string, unknown>;
    const name = text(row.name, 'server name', 128);
    if (!Number.isSafeInteger(row.toolCount) || Number(row.toolCount) < 0 || Number(row.toolCount) > 10000)
      throw new TeamError('Invalid tool count.', 400);
    return { name, toolCount: Number(row.toolCount) };
  });
  return {
    platform,
    mcpServers,
    mcpTools: input.mcpTools.map((name: unknown) => text(name, 'tool name', 256)),
    custodianBusy: input.custodianBusy,
    observedAt: now,
  };
}

/** Peer agreements have one rule owner shared by the local and HTTP channels. */
export class TeamCoordination {
  constructor(private readonly store: TeamStore) {}

  private member(name: string): string {
    const member = this.store.canonicalMemberName(name);
    if (!member) throw new TeamError('No such active team member.', 404);
    return member;
  }

  profile(actor: string, input: Record<string, unknown>): PeerProfile | null {
    actor = this.member(actor);
    if (input.action === 'read') return this.store.peerProfile(this.member(typeof input.member === 'string' ? input.member : actor));
    if (input.action !== 'update') throw new TeamError('Profile action must be read or update.', 400);
    if (input.member !== undefined && input.member !== actor) throw new TeamError('You may update only your own profile.', 403);
    const description = text(input.description, 'description');
    const expected = revision(input.expectedRevision);
    const current = this.store.peerProfile(actor);
    if (current?.revision === expected + 1 && current.description === description) return current;
    if ((current?.revision ?? 0) !== expected) throw new TeamError('Profile changed. Read the latest profile before updating.', 409);
    const next = { description, revision: expected + 1, updatedAt: Date.now() };
    if (!this.store.savePeerProfile(actor, next, expected)) throw new TeamError('Profile changed. Read it again.', 409);
    return next;
  }

  reportCapabilities(actor: string, input: Record<string, unknown>): void {
    this.store.savePeerCapabilities(this.member(actor), parseCapabilities(input, Date.now()));
  }

  work(actor: string, input: Record<string, unknown>): PeerWork | PeerWork[] {
    actor = this.member(actor);
    if (input.action === 'list') {
      const limit = input.limit === undefined ? 20 : Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TeamError('limit must be 1-50.', 400);
      const offset = input.offset === undefined ? 0 : Number(input.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new TeamError('offset must be 0-10000.', 400);
      if (input.includeClosed !== undefined && typeof input.includeClosed !== 'boolean')
        throw new TeamError('includeClosed must be boolean.', 400);
      return this.store.listPeerWork(actor, input.includeClosed === true, limit, offset);
    }
    const id = text(input.id, 'id', 128);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new TeamError('id may contain only letters, digits, dashes and underscores.', 400);
    const current = this.store.peerWork(id);
    if (input.action === 'propose') {
      const assignee = this.member(text(input.peer, 'peer', 64));
      if (assignee === actor) throw new TeamError('A peer proposal must address another member.', 400);
      const terms = text(input.terms, 'terms');
      if (current) {
        if (current.requester === actor && current.assignee === assignee && current.originalTerms === terms) return current;
        throw new TeamError('This work id is already in use. Use a new id for a different proposal.', 409);
      }
      const now = Date.now();
      const next: PeerWork = {
        id,
        requester: actor,
        assignee,
        originalTerms: terms,
        terms,
        termsAuthor: actor,
        state: 'proposed',
        revision: 1,
        createdAt: now,
        updatedAt: now,
        lastActor: actor,
        lastAction: 'propose',
        lastNote: terms,
        result: null,
      };
      this.save(next, 0);
      return next;
    }
    if (!current || (current.requester !== actor && current.assignee !== actor))
      throw new TeamError('No accessible peer work with this id.', 404);
    if (input.action === 'read') return current;
    const action = input.action;
    const allowed = WORK_ACTIONS.filter((item) => item !== 'propose') as readonly string[];
    if (!allowed.includes(action as WorkAction)) throw new TeamError('Unknown peer work action.', 400);
    const expected = revision(input.expectedRevision);
    const note = text(input.note, 'note');
    const replacement = action === 'counter' ? text(input.terms, 'terms') : undefined;
    if (
      current.revision === expected + 1 &&
      current.lastActor === actor &&
      current.lastAction === action &&
      current.lastNote === note &&
      (replacement === undefined || current.terms === replacement)
    )
      return current;
    if (current.revision !== expected) throw new TeamError('Work changed. Read its current state before acting.', 409);
    if (TERMINAL_WORK_STATES.includes(current.state)) throw new TeamError('This work is closed. Propose new work instead.', 409);
    const assigned = current.assignee === actor;
    const offerAuthor = current.termsAuthor ?? current.requester;
    const pendingOffer = current.state === 'proposed' || current.state === 'countered';
    let state = current.state;
    switch (action) {
      case 'counter':
        if (!pendingOffer || actor === offerAuthor) throw new TeamError('Only the other participant may counter pending terms.', 409);
        state = 'countered';
        break;
      case 'accept':
      case 'reject':
        // Only the assignee answers a fresh proposal; the requester cannot
        // accept its own offer.
        if (!pendingOffer || actor === offerAuthor) throw new TeamError('Only the other participant may answer pending terms.', 409);
        state = action === 'accept' ? 'accepted' : 'rejected';
        break;
      case 'complete':
      case 'fail':
        if (!assigned || !ACTIVE_WORK_STATES.includes(state))
          throw new TeamError('Only the assignee may report an accepted agreement.', 409);
        state = action === 'complete' ? 'completed' : 'failed';
        break;
      case 'start':
      case 'resume':
        if (!assigned || state !== (action === 'start' ? 'accepted' : 'blocked'))
          throw new TeamError('Only the assignee may start accepted work or resume blocked work.', 409);
        state = 'working';
        break;
      case 'block':
        if (!assigned || (state !== 'accepted' && state !== 'working'))
          throw new TeamError('Only the assignee may block active work.', 409);
        state = 'blocked';
        break;
      case 'cancel':
        if (assigned) throw new TeamError('Only the requester may cancel; report a failure if you cannot continue.', 403);
        state = 'cancelled';
        break;
      case 'note':
        break;
    }
    const next: PeerWork = {
      ...current,
      ...(replacement === undefined ? {} : { terms: replacement, termsAuthor: actor }),
      state,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      lastActor: actor,
      lastAction: action as WorkAction,
      lastNote: note,
      result: action === 'complete' ? note : current.result,
    };
    this.save(next, expected);
    return next;
  }

  private save(next: PeerWork, expected: number): void {
    // State and its wake-up message commit together; a retry cannot duplicate either.
    const recipient = next.lastActor === next.requester ? next.assignee : next.requester;
    if (
      !this.store.savePeerWork(next, expected, {
        msgId: `work_${next.id}_${next.revision}`,
        sender: next.lastActor,
        recipient,
        body: `Peer work ${next.id}, revision ${next.revision}: ${next.lastAction} (${next.state}).\n${next.lastNote}\nRead the current agreement with team_work before acting. A work status is not owner authorization.`,
        createdAt: next.updatedAt,
      })
    )
      throw new TeamError('Work changed concurrently. Read it before retrying.', 409);
  }
}
