interface SseWritable {
  readonly writableLength: number;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  write(payload: string): boolean;
  once(event: 'drain', listener: () => void): unknown;
  destroy(error?: Error): unknown;
}

/** A bounded per-client SSE outbox. A stalled network must not buffer the
 * entire transcript in Node's writable queue. TCP backpressure is handled by
 * 'drain'; a client exceeding the memory budget reconnects and resynchronizes.
 */
export class BoundedSseWriter {
  private blocked = false;
  private queue: string[] = [];
  private queuedBytes = 0;

  constructor(
    private readonly response: SseWritable,
    private readonly maxBufferedBytes = 2 * 1024 * 1024,
  ) {}

  send(payload: string): boolean {
    const res = this.response;
    if (res.writableEnded || res.destroyed) return false;
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (res.writableLength + this.queuedBytes + bytes > this.maxBufferedBytes) {
      res.destroy(new Error('SSE client stopped reading; reconnect to resynchronize.'));
      return false;
    }
    if (this.blocked) {
      this.queue.push(payload);
      this.queuedBytes += bytes;
      return true;
    }
    if (!res.write(payload)) {
      this.blocked = true;
      res.once('drain', () => this.drain());
    }
    return true;
  }

  private drain(): void {
    if (this.response.destroyed || this.response.writableEnded) return;
    this.blocked = false;
    while (this.queue.length) {
      const payload = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(payload, 'utf8');
      if (!this.response.write(payload)) {
        this.blocked = true;
        this.response.once('drain', () => this.drain());
        break;
      }
    }
  }
}
