import { describe, expect, it } from 'vitest';
import { DaemonFrameDecoder } from '../src/daemon-frames.js';

describe('daemon newline framing', () => {
  it('accepts multiple individually valid frames even if their combined TCP chunk exceeds the limit', () => {
    const decoder = new DaemonFrameDecoder(20);
    const results = decoder.append(Buffer.from('a'.repeat(15) + '\n' + 'b'.repeat(15) + '\n'));
    expect(results.map((frame) => frame.toString())).toEqual(['a'.repeat(15), 'b'.repeat(15)]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('enforces a limit across multiple chunks belonging to one frame', () => {
    const decoder = new DaemonFrameDecoder(4);
    expect(decoder.append(Buffer.from('abc'))).toEqual([]);
    expect(() => decoder.append(Buffer.from('de\n'))).toThrow(/frame exceeded/);
  });

  it('owns partial data rather than keeping the complete received buffer alive', () => {
    const decoder = new DaemonFrameDecoder(64);
    const large = Buffer.from('complete\ntrailing');
    expect(decoder.append(large).map((frame) => frame.toString())).toEqual(['complete']);
    expect(decoder.pendingBytes).toBe(8);
    const frames = decoder.append(Buffer.from('\n'));
    expect(frames[0]?.toString()).toBe('trailing');
    expect(decoder.pendingBytes).toBe(0);
  });
});
