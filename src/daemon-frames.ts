/** Length-limited newline-delimited framing. A TCP chunk is not a frame: one
 * chunk may contain many complete messages, and a message can span chunks.
 * Retain only an owned copy of an unfinished tail, never a view of a large read.
 */
export class DaemonFrameDecoder {
  private pending = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {}

  append(chunk: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        const tail = chunk.subarray(start);
        if (this.pending.length + tail.length > this.maxFrameBytes) throw new Error('IPC frame exceeded the 32 MB limit.');
        this.pending = this.pending.length ? Buffer.concat([this.pending, tail]) : Buffer.from(tail);
        return frames;
      }
      const part = chunk.subarray(start, newline);
      if (this.pending.length + part.length > this.maxFrameBytes) throw new Error('IPC frame exceeded the 32 MB limit.');
      frames.push(this.pending.length ? Buffer.concat([this.pending, part]) : part);
      this.pending = Buffer.alloc(0);
      start = newline + 1;
    }
    return frames;
  }

  get pendingBytes(): number {
    return this.pending.length;
  }
}
