/** Binary image validation shared by attachment ingestion and explicit image reads. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_TYPES)[number];

export function imageTypeFromBytes(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * The single authority for decoding an image that arrived as base64. It
 * validates the decoded bytes, not the string: a payload is accepted only if it
 * decodes to a real image of the requested type within the size cap. Incidental
 * whitespace (line breaks from a base64 encoder) is harmless here, and a
 * non-image is rejected by its magic bytes rather than by a character-class
 * regex that could both reject valid input and accept garbage.
 */
export function decodeBase64Image(base64: string, mediaType: ImageMediaType, maxBytes: number): Buffer {
  if (!base64.trim()) throw new Error('An attached image is empty.');
  const bytes = decodeBase64(base64, maxBytes);
  if (bytes.length === 0) throw new Error('An attached image is empty.');
  if (bytes.length > maxBytes) throw new Error(`An attached image exceeded the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  if (imageTypeFromBytes(bytes) !== mediaType) throw new Error(`An attached image is not a valid ${mediaType}.`);
  return bytes;
}

export function decodeDataUrl(source: string): Buffer {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/i.exec(source);
  if (!match?.[2]) throw new Error('Use a base64 data URL with a supported image type.');
  return decodeBase64(match[2]);
}

export function decodeBase64(value: string, maxBytes = MAX_IMAGE_BYTES): Buffer {
  const base64 = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new Error('The image data is not valid base64.');
  }
  if (base64.length > Math.ceil((maxBytes * 4) / 3) + 4) throw new Error('The image data exceeded its size limit.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxBytes) throw new Error('The image data exceeded its size limit.');
  return bytes;
}
