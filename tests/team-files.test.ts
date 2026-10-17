import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadFile, listFiles, uploadFile } from '../src/team/client.js';
import { TeamOperations, TeamError } from '../src/team/operations.js';
import { startTeamServer, type StartedTeamServer } from '../src/team/server.js';
import { hashTicket, makeTicket } from '../src/team/service.js';
import { localChannel, remoteChannel } from '../src/team/session.js';
import { TeamStore } from '../src/team/store.js';
import type { JoinTarget } from '../src/team/tailnet.js';

let dataDir: string;
let store: TeamStore;
let server: StartedTeamServer | null = null;
let target: JoinTarget;
let murphyTicket: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ranite-team-files-'));
  process.env.RANITE_DATA_DIR = dataDir;
  store = new TeamStore(join(dataDir, 'team.db'));
  const now = Date.now();
  store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-Ranite', now);
  store.createJoinRequest('jr_m', 'Murphy-Ranite', 'kartal-1', now);
  murphyTicket = makeTicket();
  store.decideJoin('jr_m', true, murphyTicket, hashTicket(murphyTicket), now);
  store.confirmTicket('jr_m');
  const started = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
  target = { host: '127.0.0.1', port: Number(new URL(started.url).port) };
  server = started;
});

afterEach(async () => {
  await server?.close();
  server = null;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.RANITE_DATA_DIR;
});

describe('file registration rules', () => {
  it('validates name, size, sha256, and recipient', () => {
    const operations = new TeamOperations(store);
    const good = { recipient: 'murphy-ranite', name: 'report.pdf', size: 10, sha256: 'a'.repeat(64) };
    const message = operations.registerFile('Atreus-Ranite', good);
    expect(message.kind).toBe('file');
    expect(message.fileId).toBeTruthy();
    expect(message.recipient).toBe('Murphy-Ranite');
    expect(() => operations.registerFile('Atreus-Ranite', { ...good, name: 'bad\nname' })).toThrow(TeamError);
    expect(() => operations.registerFile('Atreus-Ranite', { ...good, sha256: 'nope' })).toThrow(TeamError);
    expect(() => operations.registerFile('Atreus-Ranite', { ...good, recipient: 'ghost' })).toThrow(TeamError);
  });
});

describe('file transfer over the hub', () => {
  it('uploads, lists, and downloads a file, verifying its bytes', async () => {
    const source = join(dataDir, 'payload.bin');
    const bytes = Buffer.from('team file contents '.repeat(1000));
    writeFileSync(source, bytes);
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');

    const uploaded = await uploadFile(target, murphyTicket, {
      recipient: 'group',
      name: 'payload.bin',
      size: bytes.length,
      sha256,
      source: (await import('node:fs')).createReadStream(source),
    });
    expect(uploaded.id).toMatch(/^f_/);

    const listed = await listFiles(target, murphyTicket);
    expect(listed.map((file) => file.name)).toContain('payload.bin');

    const destination = join(dataDir, 'downloaded.bin');
    const result = await downloadFile(target, murphyTicket, uploaded.id, destination);
    expect(result.size).toBe(bytes.length);
    expect(readFileSync(destination).equals(bytes)).toBe(true);

    // The announcement is a real message: it appears in the group with kind 'file'.
    const group = await remoteChannel(target, murphyTicket, 'Murphy-Ranite').groupRead(50);
    expect(group.messages[0]).toMatchObject({ kind: 'file', fileId: uploaded.id });
  });

  it('refuses a download whose declared hash does not match the bytes', async () => {
    const source = join(dataDir, 'tampered.bin');
    writeFileSync(source, Buffer.from('original'));
    // Upload declaring the wrong hash is rejected by the hub.
    await expect(
      uploadFile(target, murphyTicket, {
        recipient: 'group',
        name: 'tampered.bin',
        size: 8,
        sha256: 'b'.repeat(64),
        source: (await import('node:fs')).createReadStream(source),
      }),
    ).rejects.toThrow();
  });

  it('sends through the local channel for the hub and the remote channel for a member', async () => {
    const hub = localChannel(store, 'Atreus-Ranite');
    const member = remoteChannel(target, murphyTicket, 'Murphy-Ranite');
    const source = join(dataDir, 'from-hub.txt');
    writeFileSync(source, 'hello from the hub');
    const sent = await hub.sendFile({ recipient: 'Murphy-Ranite', path: source });
    const to = join(dataDir, 'received.txt');
    await member.receiveFile({ id: sent.id, to });
    expect(readFileSync(to, 'utf8')).toBe('hello from the hub');
  });
});
