import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamDelivery } from '../src/team/delivery.js';
import { TeamOutbox } from '../src/team/outbox.js';
import { TeamTransportError } from '../src/team/contracts.js';
import { outboundFilePath } from '../src/team/files.js';
import type { TeamChannel, TeamConnection } from '../src/team/session.js';

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ranite-delivery-'));
  previous = process.env.RANITE_DATA_DIR;
  process.env.RANITE_DATA_DIR = root;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.RANITE_DATA_DIR;
  else process.env.RANITE_DATA_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

function binding(key: string, channel: Partial<TeamChannel>, current = () => true): TeamConnection {
  return { key, teamId: key, channel: channel as TeamChannel, isCurrent: current, close: () => {} };
}

describe('durable team delivery', () => {
  it('persists before sending and retries a 503 with exactly the same operation id', async () => {
    const path = join(root, 'outbox.json');
    const queue = new TeamOutbox(path);
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(new TeamOutbox(path).size()).toBe(1);
        throw new TeamTransportError('503', true, 503);
      })
      .mockResolvedValue({ msgId: 'accepted' });
    const service = new TeamDelivery(() => binding('A', { send }), queue);
    const result = (await service.send({ recipient: 'Peer', text: 'request' })) as { status: string; messageId: string };
    expect(result.status).toBe('queued');
    expect(queue.list('A')[0]?.state).toBe('pending');
    await service.manage({ action: 'retry', id: result.messageId });
    expect(send.mock.calls[0]?.[3]).toBe(send.mock.calls[1]?.[3]);
    expect(queue.size()).toBe(0);
    const restarted = new TeamDelivery(() => binding('A', { send }), new TeamOutbox(path));
    expect(await restarted.manage({ action: 'read', id: result.messageId })).toMatchObject({
      delivery: { state: 'sent', msgId: result.messageId },
    });
  });

  it('keeps a permanent rejection inspectable and cancellable', async () => {
    const queue = new TeamOutbox(join(root, 'outbox.json'));
    const send = vi.fn().mockRejectedValue(new TeamTransportError('Unknown recipient', false, 404));
    const service = new TeamDelivery(() => binding('A', { send }), queue);
    const result = (await service.send({ recipient: 'Missing', text: 'request' })) as { status: string; messageId: string };
    expect(result.status).toBe('error');
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(service.status('A')[0]).toMatchObject({ state: 'failed', error: 'Unknown recipient' });
    await service.manage({ action: 'cancel', id: result.messageId });
    expect(queue.size()).toBe(0);
  });

  it('does not retarget a captured queue when membership changes between sends', async () => {
    const queue = new TeamOutbox(join(root, 'outbox.json'));
    for (const body of ['first', 'second']) queue.enqueue({ teamId: 'A', bindingKey: 'A', recipient: 'Peer', body });
    let active = 'A';
    const routes: string[] = [];
    const connect = () => {
      const captured = active;
      return binding(
        captured,
        {
          send: async () => {
            routes.push(captured);
            active = 'B';
            return { msgId: 'accepted' };
          },
        },
        () => active === captured,
      );
    };
    const service = new TeamDelivery(connect, queue);
    await service.flush();
    await service.flush();
    expect(routes).toEqual(['A']);
    expect(queue.list('A')).toHaveLength(1);
    await expect(service.manage({ action: 'retry', id: queue.list('A')[0]!.msgId })).rejects.toThrow('original team');
  });

  it('queues an immutable file snapshot and preserves its transfer id across retries', async () => {
    const queue = new TeamOutbox(join(root, 'outbox.json'));
    const source = join(root, 'report.md');
    writeFileSync(source, 'original bytes');
    const sendFile = vi.fn().mockRejectedValue(new TeamTransportError('lost response', true));
    const service = new TeamDelivery(() => binding('A', { sendFile }), queue);
    await service.sendFile({ path: source, to: 'Peer' });
    await service.flush();
    const entry = queue.list('A')[0]!;
    writeFileSync(source, 'changed afterwards');
    expect(readFileSync(outboundFilePath(entry.file!.id), 'utf8')).toBe('original bytes');
    sendFile.mockResolvedValue({ id: entry.file!.id, seq: 1 });
    await service.manage({ action: 'retry', id: entry.msgId });
    expect(sendFile.mock.calls[0]?.[0].transfer.id).toBe(sendFile.mock.calls[1]?.[0].transfer.id);
    expect(queue.size()).toBe(0);
  });
});

it('does not send a cancelled intent from an older drain snapshot', async () => {
  const queue = new TeamOutbox(join(root, 'outbox.json'));
  queue.enqueue({ teamId: 'A', bindingKey: 'A', recipient: 'Peer', body: 'first' });
  const second = queue.enqueue({ teamId: 'A', bindingKey: 'A', recipient: 'Peer', body: 'second' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn(async () => {
    await gate;
    return { msgId: 'accepted' };
  });
  const service = new TeamDelivery(() => binding('A', { send }), queue);
  const drain = service.flush();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await service.manage({ action: 'cancel', id: second.msgId });
  release();
  await drain;
  expect(send).toHaveBeenCalledTimes(1);
  expect(queue.size()).toBe(0);
});

it('reconciles in-flight intent after shutdown without the old owner publishing a receipt', async () => {
  const path = join(root, 'outbox.json');
  const queue = new TeamOutbox(path);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn(async (..._input: Parameters<TeamChannel['send']>) => {
    await gate;
    return { msgId: 'accepted' };
  });
  const old = new TeamDelivery(() => binding('A', { send }), queue);
  const first = old.send({ recipient: 'Peer', text: 'request' });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  old.close();
  release();
  const result = (await first) as { messageId: string };
  expect(new TeamOutbox(path).get(result.messageId)?.state).toBe('pending');
  const restarted = new TeamDelivery(() => binding('A', { send }), new TeamOutbox(path));
  await restarted.flush();
  expect(send.mock.calls[0]?.[3]).toBe(send.mock.calls[1]?.[3]);
  expect(await restarted.manage({ action: 'read', id: result.messageId })).toMatchObject({ delivery: { state: 'sent' } });
});

it('continues at a verified new route only when the logical membership is unchanged', async () => {
  const queue = new TeamOutbox(join(root, 'outbox.json'));
  for (const body of ['first', 'second']) queue.enqueue({ teamId: 'A', bindingKey: 'A', recipient: 'Peer', body });
  let route = 'old';
  const routes: string[] = [];
  const service = new TeamDelivery(() => {
    const captured = route;
    return binding(
      'A',
      {
        send: async () => {
          routes.push(captured);
          route = 'new';
          return { msgId: 'accepted' };
        },
      },
      () => route === captured,
    );
  }, queue);
  await service.flush();
  expect(routes).toEqual(['old']);
  await service.flush();
  expect(routes).toEqual(['old', 'new']);
  expect(queue.size()).toBe(0);
});
