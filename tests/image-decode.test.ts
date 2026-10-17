import { describe, expect, it } from 'vitest';
import { decodeBase64Image } from '../src/image.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);

describe('decodeBase64Image', () => {
  it('accepts a real PNG and tolerates incidental whitespace from the encoder', () => {
    const base64 = PNG_HEADER.toString('base64');
    const wrapped = base64.replace(/(.{4})/g, '$1\n'); // a wrapping encoder
    expect(decodeBase64Image(wrapped, 'image/png', 1024).subarray(0, 8).equals(PNG_HEADER.subarray(0, 8))).toBe(true);
  });

  it('rejects a valid-base64 payload whose bytes are not the requested image type', () => {
    expect(() => decodeBase64Image(JPEG_HEADER.toString('base64'), 'image/png', 1024)).toThrow('not a valid image/png');
  });

  it('rejects an empty payload and one over the size cap', () => {
    expect(() => decodeBase64Image('', 'image/png', 1024)).toThrow('empty');
    expect(() => decodeBase64Image(PNG_HEADER.toString('base64'), 'image/png', 4)).toThrow('limit');
  });
});
