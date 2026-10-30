import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { filePath } from '../src/team/files.js';
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
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-team-files-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  store = new TeamStore(join(dataDir, 'team.db'));
  const now = Date.now();
  store.initHub('hub-id', 'team-id', 'MyTeam', 'Atreus-OpenButler', now);
  store.createJoinRequest('jr_m', 'Murphy-OpenButler', 'kartal-1', now);
  murphyTicket = makeTicket();
  store.decideJoin('jr_m', true, murphyTicket, hashTicket(murphyTicket), now);
  store.confirmTicket('jr_m');
  const started = await startTeamServer({ store, bindAddress: '127.0.0.1', port: 0, allowLoopback: true });
  target = { host: '127.0.0.1', port: Number(new URL(started.url).port) };
  server = started;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = null;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OPENBUTLER_DATA_DIR;
});

describe('file registration rules', () => {
  it('validates name, size, sha256, and recipient', () => {
    const operations = new TeamOperations(store);
    const good = { recipient: 'murphy-openbutler', name: 'report.pdf', size: 10, sha256: 'a'.repeat(64) };
    const message = operations.registerFile('Atreus-OpenButler', good);
    expect(message.kind).toBe('file');
    expect(message.fileId).toBeTruthy();
    expect(message.recipient).toBe('Murphy-OpenButler');
    expect(() => operations.registerFile('Atreus-OpenButler', { ...good, name: 'bad\nname' })).toThrow(TeamError);
    expect(() => operations.registerFile('Atreus-OpenButler', { ...good, sha256: 'nope' })).toThrow(TeamError);
    expect(() => operations.registerFile('Atreus-OpenButler', { ...good, recipient: 'ghost' })).toThrow(TeamError);
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
    const group = await remoteChannel(target, murphyTicket, 'Murphy-OpenButler').groupRead(50);
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
    const hub = localChannel(store, 'Atreus-OpenButler');
    const member = remoteChannel(target, murphyTicket, 'Murphy-OpenButler');
    const source = join(dataDir, 'from-hub.txt');
    writeFileSync(source, 'hello from the hub');
    const sent = await hub.sendFile({ recipient: 'Murphy-OpenButler', path: source });
    const to = join(dataDir, 'received.txt');
    await member.receiveFile({ id: sent.id, to });
    expect(readFileSync(to, 'utf8')).toBe('hello from the hub');
  });
});

describe('file delivery invariants', () => {
  it('reuses the same transfer id without duplicating metadata or notifications', async () => {
    const bytes = Buffer.from('same report bytes');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const input = { id: 'f_1234567890abcdef', recipient: 'Atreus-OpenButler', name: 'report.md', size: bytes.length, sha256 };
    const first = await uploadFile(target, murphyTicket, { ...input, source: Readable.from(bytes) });
    const retry = await uploadFile(target, murphyTicket, { ...input, source: Readable.from(bytes) });
    expect(retry).toEqual(first);
    expect(store.filesForMember('Atreus-OpenButler')).toHaveLength(1);
    expect(store.unreadDmCount('Atreus-OpenButler')).toBe(1);
    await expect(uploadFile(target, murphyTicket, { ...input, name: 'different-intent.md', source: Readable.from(bytes) })).rejects.toThrow(
      'different file',
    );
    expect(readFileSync(filePath(input.id))).toEqual(bytes);
  });

  it('verifies local hub receives and preserves an existing destination when hub bytes are corrupt', async () => {
    const source = join(dataDir, 'source.txt');
    const destination = join(dataDir, 'destination.txt');
    writeFileSync(source, 'original');
    writeFileSync(destination, 'keep this file');
    const hub = localChannel(store, 'Atreus-OpenButler');
    const sent = await hub.sendFile({ recipient: 'group', path: source });
    writeFileSync(filePath(sent.id), 'tampered');
    await expect(hub.receiveFile({ id: sent.id, to: destination })).rejects.toThrow('sha256');
    expect(readFileSync(destination, 'utf8')).toBe('keep this file');
  });

  it('binds upload cancellation to the complete network operation', async () => {
    const abort = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/v1/status'))
        return new Response(JSON.stringify({ protocol: 'openbutler-team/2', team: 'Proof', you: 'Self', members: [] }));
      expect(init?.signal).toBe(abort);
      throw abort.reason;
    });
    await expect(
      uploadFile(target, murphyTicket, { recipient: 'group', name: 'x', size: 0, sha256: 'a'.repeat(64), source: Readable.from([]) }),
    ).rejects.toThrow('did not complete');
  });
});
