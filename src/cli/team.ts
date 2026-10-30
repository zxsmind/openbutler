import { requestHost, startDaemon } from '../daemon.js';
import { confirm } from '@inquirer/prompts';
import type { Parsed } from './args.js';
import { loadSecrets, loadSettings, saveSecrets, saveSettings } from '../settings.js';
import { confirmJoin, fetchHubFingerprint, fetchHubStatus, pollJoin, postJoin, postLeave, type JoinPollResult } from '../team/client.js';
import {
  fingerprintOf,
  hashTicket,
  makeHubId,
  makeInviteCode,
  makeTeamId,
  makeTicket,
  validateMemberName,
  validateTeamName,
} from '../team/service.js';
import { localChannel, remoteChannel, type TeamChannel, type TeamMessage } from '../team/session.js';
import { defaultInboxPath } from '../team/files.js';
import { teamSlug } from '../memory-paths.js';
import { resolve } from 'node:path';
import { TeamStore } from '../team/store.js';
import { TEAM_DEFAULT_PORT, findTailnetAddress, parseJoinTarget, type JoinTarget } from '../team/tailnet.js';
import * as ui from './ui.js';

const JOIN_POLL_INTERVAL_MS = 2000;
const JOIN_POLL_TIMEOUT_MS = 10 * 60_000;
const INVITE_TTL_DEFAULT_MS = 10 * 60_000;

const USAGE = `Usage:
  openbutler team init --as <name> [--name <team>] [--port <n>]
  openbutler team invite [--ttl-minutes <n>]
  openbutler team invites
  openbutler team invite-revoke <code>
  openbutler team join <address> --code <code> --as <name> [--fingerprint <fp>]
  openbutler team join-status <address> <request-id>
  openbutler team pending
  openbutler team approve <request-id>
  openbutler team deny <request-id>
  openbutler team members
  openbutler team leave
  openbutler team remove <name>
  openbutler team status
  openbutler team log [--limit <n>]
  openbutler team rejoin <address>
  openbutler team say <message>
  openbutler team dm <member> <message>
  openbutler team inbox
  openbutler team read [--group] [--from <member>]
  openbutler team history [--group | --with <member>] [--before <seq>] [--limit <n>]
  openbutler team send-file <member|group> <path>
  openbutler team files
  openbutler team get <file-id> [--to <path>]`;

function words(parsed: Parsed): string[] {
  return parsed.words;
}

function flag(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name);
}

function localAddress(): string {
  const address = findTailnetAddress();
  if (!address) throw new Error('No tailnet address found. Join the tailnet first, then retry.');
  return address;
}

/** Hub-side store. Only the hub needs it; members never touch it. */
function openStore(): TeamStore {
  return new TeamStore();
}

async function runInit(parsed: Parsed): Promise<void> {
  const as = flag(parsed, 'as');
  if (!as) throw new Error('Usage: openbutler team init --as <name> [--name <team>] [--port <n>]');
  const memberName = validateMemberName(as);
  const teamName = validateTeamName(flag(parsed, 'name') ?? `${memberName}-team`);
  const portRaw = flag(parsed, 'port');
  const port = portRaw === undefined ? TEAM_DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535.');
  const address = localAddress();
  const settings = loadSettings();
  if (settings.team)
    throw new Error(`This machine is already in team "${settings.team.teamName}" as ${settings.team.memberName}. Leave it first.`);
  const store = openStore();
  const teamId = makeTeamId();
  try {
    store.initHub(makeHubId(), teamId, teamName, memberName, Date.now());
  } finally {
    store.close();
  }
  settings.team = { role: 'hub', teamName, memberName, hubHost: address, hubPort: port, teamId };
  saveSettings(settings);
  ui.success(`Team "${teamName}" created. This machine is the hub as ${memberName}.`);
  ui.info(`Hub address: ${address}:${port}`);
  ui.info('The background host picks this up automatically. Invite members with: openbutler team invite');
}

async function runInvite(parsed: Parsed): Promise<void> {
  const settings = loadSettings();
  if (settings.team?.role !== 'hub') throw new Error('Only the hub invites members.');
  const ttlMinutes = Number(flag(parsed, 'ttl-minutes') ?? String(INVITE_TTL_DEFAULT_MS / 60_000));
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new Error('--ttl-minutes must be 1-1440.');
  const store = openStore();
  try {
    if (!store.isInitialized()) throw new Error('Team store is not initialized. Run team init first.');
    const code = makeInviteCode();
    store.createInvite(code, ttlMinutes * 60_000, Date.now());
    const hubId = store.getMeta('hub_id')!;
    store.appendAudit({ kind: 'invite.created', actor: settings.team.memberName, detail: code, createdAt: Date.now() });
    ui.success(`Invite code: ${code} (single use, expires in ${ttlMinutes}m)`);
    ui.info(`Fingerprint: ${fingerprintOf(hubId)} (the joiner must confirm this)`);
    ui.info(`Join with: openbutler team join ${settings.team.hubHost}:${settings.team.hubPort} --code ${code} --as <name>`);
  } finally {
    store.close();
  }
}

async function runInvites(): Promise<void> {
  const settings = loadSettings();
  if (settings.team?.role !== 'hub') throw new Error('Only the hub lists invites.');
  const store = openStore();
  try {
    const invites = store.listInvites(Date.now());
    if (invites.length === 0) {
      ui.info('No open invites. Create one with: openbutler team invite');
      return;
    }
    ui.table(
      ['CODE', 'EXPIRES IN'],
      invites.map((invite) => [invite.code, `${Math.max(0, Math.round((invite.expiresAt - Date.now()) / 60000))}m`]),
    );
  } finally {
    store.close();
  }
}

async function runInviteRevoke(parsed: Parsed): Promise<void> {
  const code = words(parsed)[1]?.trim();
  if (!code) throw new Error('Usage: openbutler team invite-revoke <code>');
  const settings = loadSettings();
  if (settings.team?.role !== 'hub') throw new Error('Only the hub revokes invites.');
  const store = openStore();
  try {
    if (!store.revokeInvite(code)) {
      ui.info('No such open invite.');
      return;
    }
    store.appendAudit({ kind: 'invite.revoked', actor: settings.team.memberName, detail: code, createdAt: Date.now() });
    ui.success(`Invite ${code} revoked.`);
  } finally {
    store.close();
  }
}

async function runJoin(parsed: Parsed): Promise<void> {
  const arg = words(parsed);
  const addressRaw = arg[1];
  const code = flag(parsed, 'code');
  const as = flag(parsed, 'as');
  if (!addressRaw || !code || !as) throw new Error('Usage: openbutler team join <address> --code <code> --as <name> [--fingerprint <fp>]');
  const memberName = validateMemberName(as);
  const settings = loadSettings();
  if (settings.team) throw new Error(`Already in team "${settings.team.teamName}". Leave it first.`);
  const target = parseJoinTarget(addressRaw);
  const hub = await fetchHubFingerprint(target);
  const expected = flag(parsed, 'fingerprint')?.trim().toUpperCase();
  if (expected) {
    if (expected !== hub.fingerprint)
      throw new Error(`Fingerprint mismatch. Hub shows ${hub.fingerprint}; invite said ${expected}. Stopping.`);
  } else if (process.stdin.isTTY) {
    ui.info(`Hub team: ${hub.team}`);
    ui.info(`Hub fingerprint: ${hub.fingerprint}`);
    const ok = await confirm({ message: 'Does this fingerprint match the one on the invite?', default: false });
    if (!ok) throw new Error('Fingerprint was not confirmed. Stopping.');
  } else {
    throw new Error('Non-interactive join needs --fingerprint <fp> from the invite.');
  }
  const requestId = await postJoin(target, code.trim(), memberName);
  ui.info(`Join requested (${requestId}). Waiting for the hub owner to approve…`);
  const approved = await waitForApproval(target, requestId);
  if (approved.status === 'denied') throw new Error('The hub owner denied the join request.');
  if (approved.status !== 'approved') throw new Error('Join is still pending. Resume later with: openbutler team join-status');
  const secrets = loadSecrets();
  saveSecrets({ ...secrets, teamTicket: approved.ticket });
  const next = loadSettings();
  next.team = {
    role: 'member',
    teamName: approved.team,
    memberName: approved.memberName,
    hubHost: target.host,
    hubPort: target.port,
    hubFingerprint: hub.fingerprint,
    teamId: approved.teamId,
  };
  saveSettings(next);
  // The ticket is stored; tell the hub it is safe to forget it.
  await confirmJoin(target, requestId);
  ui.success(`Joined "${approved.team}" as ${approved.memberName}.`);
}

async function waitForApproval(target: JoinTarget, requestId: string): Promise<JoinPollResult | { status: 'timeout' }> {
  const deadline = Date.now() + JOIN_POLL_TIMEOUT_MS;
  for (;;) {
    const result = await pollJoin(target, requestId);
    if (result.status !== 'pending') return result;
    if (Date.now() >= deadline) return { status: 'timeout' };
    await new Promise((done) => setTimeout(done, JOIN_POLL_INTERVAL_MS));
  }
}

async function runJoinStatus(parsed: Parsed): Promise<void> {
  const arg = words(parsed);
  const addressRaw = arg[1];
  const requestId = arg[2];
  if (!addressRaw || !requestId) throw new Error('Usage: openbutler team join-status <address> <request-id>');
  const target = parseJoinTarget(addressRaw);
  const result = await pollJoin(target, requestId);
  if (result.status === 'pending') {
    ui.info('Still pending. The hub owner has not decided yet.');
    return;
  }
  if (result.status === 'denied') {
    ui.info('Denied by the hub owner.');
    return;
  }
  const hub = await fetchHubFingerprint(target);
  const secrets = loadSecrets();
  saveSecrets({ ...secrets, teamTicket: result.ticket });
  const settings = loadSettings();
  settings.team = {
    role: 'member',
    teamName: result.team,
    memberName: result.memberName,
    hubHost: target.host,
    hubPort: target.port,
    hubFingerprint: hub.fingerprint,
    teamId: result.teamId,
  };
  saveSettings(settings);
  await confirmJoin(target, requestId);
  ui.success(`Joined "${result.team}" as ${result.memberName}.`);
}

async function runPending(): Promise<void> {
  const settings = loadSettings();
  if (settings.team?.role !== 'hub') throw new Error('Only the hub reviews join requests.');
  const store = openStore();
  try {
    const pending = store.listPendingJoins();
    if (pending.length === 0) {
      ui.info('No pending join requests.');
      return;
    }
    ui.table(
      ['REQUEST', 'NAME', 'CODE', 'WAITING'],
      pending.map((entry) => [entry.id, entry.name, entry.code, `${Math.round((Date.now() - entry.createdAt) / 1000)}s`]),
    );
    ui.info('Approve with: openbutler team approve <request> · deny with: openbutler team deny <request>');
  } finally {
    store.close();
  }
}

async function runDecide(parsed: Parsed, approve: boolean): Promise<void> {
  const requestId = words(parsed)[1];
  if (!requestId) throw new Error(`Usage: openbutler team ${approve ? 'approve' : 'deny'} <request-id>`);
  const settings = loadSettings();
  if (settings.team?.role !== 'hub') throw new Error('Only the hub decides join requests.');
  const store = openStore();
  try {
    const entry = store.getJoinRequest(requestId);
    if (!entry) throw new Error('Unknown join request.');
    if (entry.status !== 'pending') throw new Error(`Request is already ${entry.status}.`);
    if (!approve) {
      store.decideJoin(requestId, false, null, null, Date.now());
      store.appendAudit({ kind: 'join.denied', actor: settings.team.memberName, detail: entry.name, createdAt: Date.now() });
      ui.success(`Denied ${entry.name}.`);
      return;
    }
    const ticket = makeTicket();
    if (!store.decideJoin(requestId, true, ticket, hashTicket(ticket), Date.now())) {
      throw new Error(`"${entry.name}" is already taken in this team. Deny the request and invite them to pick another name.`);
    }
    store.appendAudit({ kind: 'join.approved', actor: settings.team.memberName, detail: entry.name, createdAt: Date.now() });
    ui.success(`Approved ${entry.name}. They pick up the ticket by polling.`);
  } finally {
    store.close();
  }
}

async function runMembers(): Promise<void> {
  const { channel, close } = openChannel();
  try {
    const view = await channel.status();
    const now = Date.now();
    ui.info(`${view.memberCount} member${view.memberCount === 1 ? '' : 's'} in "${view.team}".`);
    ui.table(
      ['MEMBER', 'ROLE', 'PRESENCE', 'LAST SEEN', 'LAST ACTED'],
      view.members.map((member) => [
        member.name,
        member.role,
        member.online ? 'online' : 'offline',
        member.lastSeen ? `${Math.max(0, Math.round((now - member.lastSeen) / 1000))}s ago` : 'never',
        lastAction(member),
      ]),
    );
  } finally {
    close();
  }
}

/** One short phrase for what a member last did: a message (and where) or a memory write. */
function lastAction(member: { lastMessageAt: number | null; lastMessageTo: string | null; lastMemoryAt: number | null }): string {
  const message = member.lastMessageAt ?? 0;
  const memory = member.lastMemoryAt ?? 0;
  if (message === 0 && memory === 0) return 'nothing yet';
  if (message >= memory) {
    const where = member.lastMessageTo === 'group' ? 'group' : `DM to ${member.lastMessageTo}`;
    return `messaged ${where}`;
  }
  return 'wrote team memory';
}

async function runLeave(): Promise<void> {
  const settings = loadSettings();
  if (!settings.team) throw new Error('This machine is not in a team.');
  if (settings.team.role === 'hub') throw new Error('The hub cannot leave its own team. Remove members first, then reset the team.');
  const ticket = loadSecrets().teamTicket;
  if (ticket) {
    try {
      await postLeave({ host: settings.team.hubHost, port: settings.team.hubPort }, ticket);
    } catch (error) {
      ui.warn(
        `Hub did not confirm the leave (${error instanceof Error ? error.message : String(error)}). Forgetting the team locally anyway.`,
      );
    }
  }
  const secrets = loadSecrets();
  const { teamTicket: _dropped, ...rest } = secrets;
  void _dropped;
  saveSecrets(rest);
  const teamName = settings.team.teamName;
  delete settings.team;
  saveSettings(settings);
  ui.success(`Left "${teamName}". The ticket is forgotten on both sides.`);
}

async function runRemove(parsed: Parsed): Promise<void> {
  const name = words(parsed)[1];
  if (!name) throw new Error('Usage: openbutler team remove <name>');
  const settings = loadSettings();
  if (settings.team?.role !== 'hub') throw new Error('Only the hub removes members.');
  const store = openStore();
  try {
    const outcome = store.removeMember(validateMemberName(name), Date.now());
    if (outcome === 'missing') {
      ui.info('No such active member.');
      return;
    }
    if (outcome === 'hub') throw new Error('The hub cannot remove itself.');
    store.appendAudit({ kind: 'member.removed', actor: settings.team.memberName, detail: name, createdAt: Date.now() });
    ui.success(`Removed ${name}. Their ticket no longer opens anything.`);
  } finally {
    store.close();
  }
}

async function runStatus(): Promise<void> {
  const settings = loadSettings();
  if (!settings.team) {
    ui.info('Not in a team. Create one with: openbutler team init --as <name>');
    return;
  }
  const team = settings.team;
  ui.table(
    ['FIELD', 'VALUE'],
    [
      ['Team', team.teamName],
      ['You', `${team.memberName} (${team.role})`],
      ['Hub', `${team.hubHost}:${team.hubPort}`],
      ['Tailnet', findTailnetAddress() ?? 'not on a tailnet'],
    ],
  );
  if (team.role === 'member') {
    const ticket = loadSecrets().teamTicket;
    if (!ticket) {
      ui.warn('No ticket stored. Rejoin the team.');
      return;
    }
    try {
      const live = await fetchHubStatus({ host: team.hubHost, port: team.hubPort }, ticket);
      ui.success(`Hub reachable. ${live.members.length} member(s) in "${live.team}".`);
    } catch (error) {
      ui.warn(`Hub unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Opens the machine's channel to its team. The hub talks to its own store
 * directly; a member talks to the hub over the tailnet with its ticket.
 * The returned `close` must be called (the hub holds an open database).
 */
function openChannel(): { channel: TeamChannel; close: () => void } {
  const settings = loadSettings();
  const team = settings.team;
  if (!team) throw new Error('This machine is not in a team. Create one with: openbutler team init --as <name>');
  if (team.role === 'hub') {
    const store = openStore();
    return { channel: localChannel(store, team.memberName), close: () => store.close() };
  }
  const ticket = loadSecrets().teamTicket;
  if (!ticket) throw new Error('No member ticket stored. Rejoin the team.');
  return { channel: remoteChannel({ host: team.hubHost, port: team.hubPort }, ticket, team.memberName), close: () => {} };
}

function renderMessages(messages: TeamMessage[]): void {
  for (const message of messages) {
    const when = new Date(message.createdAt).toISOString().slice(11, 19);
    const reply = message.replyTo ? ` ↪${message.replyTo}` : '';
    ui.line(`  ${when}  ${message.sender}${message.recipient === 'group' ? '' : ' (DM)'}: ${message.body}${reply}`);
  }
}

async function runSay(parsed: Parsed): Promise<void> {
  const text = words(parsed).slice(1).join(' ').trim();
  if (!text) throw new Error('Usage: openbutler team say <message>');
  await startDaemon();
  const result = await requestHost('team.send', { recipient: 'group', text });
  ui.line(JSON.stringify(result));
}

async function runDm(parsed: Parsed): Promise<void> {
  const arg = words(parsed);
  const recipient = arg[1];
  const text = arg.slice(2).join(' ').trim();
  if (!recipient || !text) throw new Error('Usage: openbutler team dm <member> <message>');
  await startDaemon();
  const result = await requestHost('team.send', { recipient, text });
  ui.line(JSON.stringify(result));
}

async function runInbox(): Promise<void> {
  const { channel, close } = openChannel();
  try {
    const [inbox, view] = await Promise.all([channel.inbox(), channel.status()]);
    const newGroup = Math.max(0, view.groupLatestSeq - view.groupCursor);
    ui.info(`${inbox.count} unread DM${inbox.count === 1 ? '' : 's'}, ${newGroup} new group message${newGroup === 1 ? '' : 's'}.`);
    if (inbox.count > 0) {
      renderMessages(inbox.messages);
      ui.info('Read them with: openbutler team read');
    }
    if (newGroup > 0) ui.info('Read the group with: openbutler team read --group');
  } finally {
    close();
  }
}

async function runRead(parsed: Parsed): Promise<void> {
  const group = parsed.booleans.has('group');
  const from = flag(parsed, 'from')?.trim().toLowerCase();
  const { channel, close } = openChannel();
  try {
    if (group) {
      // A filtered read is a peek: it never consumes messages it does not show.
      const messages = from
        ? (await channel.group(0)).messages.filter((message) => message.sender.toLowerCase() === from)
        : (await channel.groupRead(100)).messages;
      if (messages.length === 0) {
        ui.info('No new group messages.');
        return;
      }
      renderMessages(messages);
      if (!from) await channel.setGroupCursor(messages.at(-1)!.seq);
      return;
    }
    // Displaying a DM never acknowledges handling on behalf of the agent.
    const inbox = from ? await channel.inbox() : await channel.readInbox(100);
    const messages = from ? inbox.messages.filter((message) => message.sender.toLowerCase() === from) : inbox.messages;
    if (messages.length === 0) {
      ui.info('No unread DMs.');
      return;
    }
    renderMessages(messages);
    if (!from) ui.info(`Shown ${messages.length}. Messages remain pending until acknowledged or answered with replyTo.`);
  } finally {
    close();
  }
}

async function runLog(parsed: Parsed): Promise<void> {
  const settings = loadSettings();
  if (settings.team?.role !== 'hub') throw new Error('Only the hub keeps the team log.');
  const limit = Number(flag(parsed, 'limit') ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be 1-1000.');
  const store = openStore();
  try {
    const entries = store.listAudit(limit);
    if (entries.length === 0) {
      ui.info('The team log is empty.');
      return;
    }
    ui.table(
      ['WHEN', 'EVENT', 'ACTOR', 'DETAIL'],
      entries.map((entry) => [
        new Date(entry.createdAt).toISOString().slice(0, 19).replace('T', ' '),
        entry.kind,
        entry.actor,
        entry.detail ?? '',
      ]),
    );
  } finally {
    store.close();
  }
}

async function runRejoin(parsed: Parsed): Promise<void> {
  const addressRaw = words(parsed)[1];
  if (!addressRaw) throw new Error('Usage: openbutler team rejoin <address>');
  const settings = loadSettings();
  const team = settings.team;
  if (!team) throw new Error('This machine is not in a team. Join first with: openbutler team join');
  if (team.role === 'hub') throw new Error('A hub does not rejoin itself.');
  const target = parseJoinTarget(addressRaw);
  const hub = await fetchHubFingerprint(target);
  if (team.hubFingerprint && hub.fingerprint !== team.hubFingerprint)
    throw new Error(`Fingerprint mismatch. This hub shows ${hub.fingerprint}; the team expected ${team.hubFingerprint}. Stopping.`);
  if (hub.team !== team.teamName) throw new Error(`This hub serves team "${hub.team}", not "${team.teamName}". Stopping.`);
  team.hubHost = target.host;
  team.hubPort = target.port;
  team.hubFingerprint = hub.fingerprint;
  saveSettings(settings);
  const ticket = loadSecrets().teamTicket;
  if (ticket) {
    try {
      const live = await fetchHubStatus(target, ticket);
      ui.success(`Rejoined "${live.team}" at ${target.host}:${target.port}.`);
      return;
    } catch (error) {
      ui.warn(`Address updated, but the hub did not accept the stored ticket: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  ui.success(`Hub address updated to ${target.host}:${target.port}.`);
}

async function runHistory(parsed: Parsed): Promise<void> {
  const group = parsed.booleans.has('group');
  const peer = flag(parsed, 'with')?.trim();
  if (!group && !peer) throw new Error('Usage: openbutler team history [--group | --with <member>] [--before <seq>] [--limit <n>]');
  const before = Number(flag(parsed, 'before') ?? '0');
  const limit = Number(flag(parsed, 'limit') ?? '50');
  if (!Number.isInteger(before) || before < 0) throw new Error('--before must be a non-negative integer.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit must be 1-200.');
  const { channel, close } = openChannel();
  try {
    const result = await channel.history({ scope: group ? 'group' : 'dm', ...(peer ? { peer } : {}), before, limit });
    if (result.messages.length === 0) {
      ui.info('No messages found.');
      return;
    }
    // Newest first from the hub; show oldest-first for reading.
    renderMessages([...result.messages].reverse());
    const oldest = result.messages.at(-1);
    if (oldest) ui.info(`Page back with: openbutler team history ${group ? '--group' : `--with ${peer}`} --before ${oldest.seq}`);
  } finally {
    close();
  }
}

async function runSendFile(parsed: Parsed): Promise<void> {
  const arg = words(parsed);
  const recipient = arg[1];
  const path = arg.slice(2).join(' ').trim();
  if (!recipient || !path) throw new Error('Usage: openbutler team send-file <member|group> <path>');
  await startDaemon();
  const result = await requestHost('team.send-file', { to: recipient, path: resolve(path) });
  ui.line(JSON.stringify(result));
}

async function runFiles(): Promise<void> {
  const { channel, close } = openChannel();
  try {
    const files = await channel.listFiles();
    if (files.length === 0) {
      ui.info('No shared files.');
      return;
    }
    ui.table(
      ['FILE ID', 'NAME', 'SIZE', 'FROM', 'TO'],
      files.map((file) => [file.id, file.name, String(file.size), file.sender, file.recipient]),
    );
  } finally {
    close();
  }
}

async function runGet(parsed: Parsed): Promise<void> {
  const id = words(parsed)[1];
  if (!id) throw new Error('Usage: openbutler team get <file-id> [--to <path>]');
  const to = flag(parsed, 'to');
  const { channel, close } = openChannel();
  try {
    const destination = to ? resolve(to) : undefined;
    const result = await channel.receiveFile({ id, to: destination ?? (await defaultDestination(channel, id)) });
    ui.success(`Saved ${result.name} (${result.size} bytes) to ${result.path}.`);
  } finally {
    close();
  }
}

/** The default inbox path for a file id, derived from its metadata. */
async function defaultDestination(channel: TeamChannel, id: string): Promise<string> {
  const team = loadSettings().team!;
  const meta = (await channel.listFiles()).find((file) => file.id === id);
  if (!meta) throw new Error(`No such file: ${id}`);
  return defaultInboxPath(team.teamId || teamSlug(team.teamName), meta.name);
}

/** Usage: openbutler team <subcommand> … (see USAGE). */
export async function runTeamCommand(parsed: Parsed): Promise<void> {
  const action = words(parsed)[0] ?? 'status';
  switch (action) {
    case 'init':
      await runInit(parsed);
      return;
    case 'invite':
      await runInvite(parsed);
      return;
    case 'invites':
      await runInvites();
      return;
    case 'invite-revoke':
      await runInviteRevoke(parsed);
      return;
    case 'join':
      await runJoin(parsed);
      return;
    case 'join-status':
      await runJoinStatus(parsed);
      return;
    case 'pending':
      await runPending();
      return;
    case 'approve':
      await runDecide(parsed, true);
      return;
    case 'deny':
      await runDecide(parsed, false);
      return;
    case 'members':
      await runMembers();
      return;
    case 'leave':
      await runLeave();
      return;
    case 'remove':
      await runRemove(parsed);
      return;
    case 'status':
      await runStatus();
      return;
    case 'log':
      await runLog(parsed);
      return;
    case 'rejoin':
      await runRejoin(parsed);
      return;
    case 'say':
      await runSay(parsed);
      return;
    case 'dm':
      await runDm(parsed);
      return;
    case 'inbox':
      await runInbox();
      return;
    case 'read':
      await runRead(parsed);
      return;
    case 'history':
      await runHistory(parsed);
      return;
    case 'send-file':
      await runSendFile(parsed);
      return;
    case 'files':
      await runFiles();
      return;
    case 'get':
      await runGet(parsed);
      return;
    default:
      throw new Error(USAGE);
  }
}

export const TEAM_USAGE = USAGE;
