import { createHash, randomBytes, randomInt } from 'node:crypto';

/** The reserved recipient name for the shared group channel. */
export const GROUP_RECIPIENT = 'group';

/**
 * Names a member may never take, case-insensitively. `group` is the group
 * channel's reserved recipient; letting a member take it would collapse the
 * direct-message and group channels into one.
 */
export const RESERVED_MEMBER_NAMES: ReadonlySet<string> = new Set([GROUP_RECIPIENT]);

/**
 * Member names are shown to humans and used as file names, so they stay
 * conservative: letters, digits, dash, underscore, 1-64 chars. Uniqueness is
 * enforced per team by the hub, case-insensitively.
 */
export function validateMemberName(raw: string): string {
  const name = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
    throw new Error(`"${raw}" is not a valid member name. Use 1-64 letters, digits, dashes, or underscores.`);
  if (RESERVED_MEMBER_NAMES.has(name.toLowerCase())) throw new Error(`"${name}" is reserved and cannot be used as a member name.`);
  return name;
}

/** Team names follow the same rule as member names. */
export function validateTeamName(raw: string): string {
  const name = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
    throw new Error(`"${raw}" is not a valid team name. Use 1-64 letters, digits, dashes, or underscores.`);
  return name;
}

/** Short human-readable invite code: `kartal-4821`. Single use, short TTL (hub enforces). */
export function makeInviteCode(randomWord: () => string = pickInviteWord): string {
  return `${randomWord()}-${String(randomInt(1000, 10000))}`;
}

const INVITE_WORDS = [
  'kartal',
  'kurt',
  'sahin',
  'pars',
  'ejder',
  'kaplan',
  'yildiz',
  'deniz',
  'dag',
  'ruzgar',
  'ates',
  'bulut',
  'orman',
  'nehir',
  'cakal',
  'dogan',
];

function pickInviteWord(): string {
  return INVITE_WORDS[randomInt(INVITE_WORDS.length)]!;
}

/** Bearer ticket the hub issues on approval. Stored hashed hub-side, raw client-side. */
export function makeTicket(): string {
  return `rt_${randomBytes(24).toString('hex')}`;
}

export function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/** Stable hub identity shown to humans at pairing time. The hub id never leaves the hub. */
export function fingerprintOf(hubId: string): string {
  const hex = createHash('sha256').update(`ranite-team-hub:${hubId}`, 'utf8').digest('hex');
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12)].join(':').toUpperCase();
}

export function makeHubId(): string {
  return randomBytes(16).toString('hex');
}

/** The team's stable public id. It keys shared memory and scopes local state. */
export function makeTeamId(): string {
  return `t_${randomBytes(12).toString('hex')}`;
}

/** Unguessable join-request id. Knowing it is the only credential for polling that request. */
export function makeRequestId(): string {
  return `jr_${randomBytes(12).toString('hex')}`;
}

/** Message id. Unique per team, so a re-sent message is recognised and not duplicated. */
export function makeMessageId(): string {
  return `m_${randomBytes(12).toString('hex')}`;
}

/** File id. Keys the stored bytes on the hub and the metadata row. */
export function makeFileId(): string {
  return `f_${randomBytes(12).toString('hex')}`;
}

export function isGroupRecipient(value: string): boolean {
  return value.trim().toLowerCase() === GROUP_RECIPIENT;
}

/**
 * Whether a member-side poll should hand a wake to the session. A direct message
 * wakes even while a run is in progress: the controller queues the wake and
 * steers it into the live run at its next tool batch, so the message is not held
 * back until the session goes idle. A burst wakes once because the highest seen
 * sequence advances the cursor. Group messages never reach here: they are ambient.
 */
export function shouldWakeForTeamDms(input: { count: number; highestSeq: number; seenSeq: number }): boolean {
  if (input.count <= 0) return false;
  return input.highestSeq > input.seenSeq;
}
