import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { BoundedSseWriter } from '../../src/web/sse-output.js';

class FakeResponse extends EventEmitter {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  writes: string[] = [];
  accept = false;
  write(payload: string): boolean {
    this.writes.push(payload);
    return this.accept;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}
describe('SSE output backpressure', () => {
  it('queues while blocked and replays in order on drain', () => {
    const res = new FakeResponse();
    const writer = new BoundedSseWriter(res, 128);
    expect(writer.send('first')).toBe(true);
    expect(writer.send('second')).toBe(true);
    expect(res.writes).toEqual(['first']);
    res.accept = true;
    res.emit('drain');
    expect(res.writes).toEqual(['first', 'second']);
  });
  it('disconnects a client whose queued frames exceed its bounded memory budget', () => {
    const res = new FakeResponse();
    const writer = new BoundedSseWriter(res, 12);
    expect(writer.send('first')).toBe(true);
    expect(writer.send('12345678')).toBe(true);
    expect(writer.send('12345678')).toBe(false);
    expect(res.destroyed).toBe(true);
  });
});
