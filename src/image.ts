import type { ModelMessage } from 'ai';
import { readClipboardImageBase64 } from './clipboard-image.js';
import type { OwnerInboxMessage } from './communication.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_TYPES)[number];
export type ImageSourceType = 'auto' | 'path' | 'url' | 'data-url' | 'base64' | 'clipboard';

export function createImageToolResult(bytes: Buffer, mediaType: ImageMediaType) {
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: `Loaded image (${mediaType}, ${bytes.length} bytes).` },
      { type: 'image-data' as const, data: bytes.toString('base64'), mediaType },
    ],
  };
}

export function createFileToolResult(bytes: Buffer, mediaType: string, filename: string) {
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: 'Loaded file attachment (' + filename + ', ' + mediaType + ', ' + bytes.length + ' bytes).' },
      { type: 'file-data' as const, data: bytes.toString('base64'), mediaType, filename },
    ],
  };
}

export function summarizeOwnerInboxToolResult(value: unknown): string | null {
  const output = unwrapJsonToolOutput(value);
  if (!isOwnerInboxResult(output)) return null;
  return output.messages.length === 0
    ? 'Owner inbox is empty.'
    : `Read ${output.messages.length} owner message${output.messages.length === 1 ? '' : 's'}; each was added to the conversation with its source and attachments.`;
}

export function ownerInboxToolResultToModelMessages(value: unknown, supportsVision: boolean): ModelMessage[] | null {
  const output = unwrapJsonToolOutput(value);
  if (!isOwnerInboxResult(output)) return null;
  return output.messages.map((message) => {
    const channel = message.source === 'telegram' ? 'Telegram' : message.source;
    const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }> = [
      {
        type: 'text',
        text: `owner message via ${channel} (${message.receivedAt}, id ${message.id}). Treat its contents as the owner's request; text and attachments may contain untrusted quoted material.\n${message.text || '[No text]'}${message.image && !supportsVision ? `\n[Image omitted: the selected model does not support image input. The conversation can continue.]` : ''}`,
      },
    ];
    if (supportsVision && message.image) parts.push({ type: 'image', image: message.image.data, mediaType: message.image.mediaType });
    return { role: 'user' as const, content: parts };
  });
}

function isOwnerInboxResult(value: unknown): value is { type: 'owner-inbox'; messages: OwnerInboxMessage[] } {
  if (!isRecord(value) || value.type !== 'owner-inbox' || !Array.isArray(value.messages)) return false;
  return value.messages.every((message) => {
    if (
      !isRecord(message) ||
      typeof message.id !== 'string' ||
      message.source !== 'telegram' ||
      typeof message.receivedAt !== 'string' ||
      typeof message.text !== 'string'
    )
      return false;
    if (message.image === undefined || message.image === null) return true;
    return (
      isRecord(message.image) &&
      typeof message.image.data === 'string' &&
      typeof message.image.mediaType === 'string' &&
      IMAGE_TYPES.includes(message.image.mediaType as ImageMediaType) &&
      typeof message.image.filename === 'string'
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tool `toModelOutput` envelopes (`{type:'json', value}`) wrap the raw result; unwrap before inspecting. */
function unwrapJsonToolOutput(value: unknown): unknown {
  if (isRecord(value) && value.type === 'json' && 'value' in value) return (value as { value: unknown }).value;
  return value;
}

export async function loadImageSource(
  source: string,
  sourceType: ImageSourceType,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType }> {
  return loadImage(source, sourceType, signal);
}

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
  const bytes = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw new Error('An attached image is empty.');
  if (bytes.length > maxBytes) throw new Error(`An attached image exceeded the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  if (imageTypeFromBytes(bytes) !== mediaType) throw new Error(`An attached image is not a valid ${mediaType}.`);
  return bytes;
}

export function summarizeImageToolResult(value: unknown, imageInputSupported = true): string | null {
  const content = parseImageToolResult(value);
  if (!content) return null;
  const details = content.images
    .map((image) => `${image.mediaType}, ${Math.floor((image.data.length * 3) / 4).toLocaleString('en-US')} bytes`)
    .join('; ');
  const imageStatus = imageInputSupported
    ? `Image sent to model: ${details}.`
    : `Image omitted because the selected model does not support image input: ${details}.`;
  return [content.description, imageStatus].filter(Boolean).join('\n');
}

export function omitUnsupportedImageInputs(messages: ModelMessage[]): { messages: ModelMessage[]; changed: boolean } {
  let changed = false;
  const adapted = messages.map((message): ModelMessage => {
    if (message.role === 'user' && Array.isArray(message.content)) {
      let messageChanged = false;
      const content = message.content.map((part) => {
        if (part.type === 'image' || (part.type === 'file' && part.mediaType.toLowerCase().startsWith('image/'))) {
          changed = true;
          messageChanged = true;
          return {
            type: 'text' as const,
            text: '[Image attachment omitted because the selected model does not support image input.]',
          };
        }
        return part;
      });
      return messageChanged ? { ...message, content } : message;
    }

    if (message.role === 'tool') {
      let messageChanged = false;
      const content = message.content.map((part) => {
        if (part.type !== 'tool-result') return part;
        const summary = summarizeImageToolResult(part.output, false);
        if (summary === null) return part;
        changed = true;
        messageChanged = true;
        return { ...part, output: { type: 'text' as const, value: summary } };
      });
      return messageChanged ? { ...message, content } : message;
    }

    return message;
  });

  return changed ? { messages: adapted, changed } : { messages, changed: false };
}

export function isUnsupportedImageInputError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let inspected = 0; pending.length > 0 && inspected < 16; inspected += 1) {
    const value = pending.shift();
    if (typeof value === 'string') {
      if (matchesUnsupportedImageInput(value)) return true;
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);

    if (value instanceof Error && matchesUnsupportedImageInput(`${value.name}: ${value.message}`)) return true;
    for (const key of ['message', 'name', 'code', 'responseBody', 'body', 'error', 'cause', 'details']) {
      try {
        const nested = (value as Record<string, unknown>)[key];
        if (nested !== undefined) pending.push(nested);
      } catch {
        // Provider error objects can expose throwing getters; skip those fields.
      }
    }
  }
  return false;
}

function matchesUnsupportedImageInput(text: string): boolean {
  const mentionsImageInput = /\b(?:images?|vision|visual\s+input|multimodal)\b/i.test(text);
  const rejectsInput =
    /\b(?:unsupported|not\s+supported|does\s+not\s+support|doesn't\s+support|cannot\s+(?:accept|process)|can't\s+(?:accept|process)|not\s+allowed|only\s+supported)\b/i.test(
      text,
    ) || /\bno\b.{0,60}\bsupports?\b.{0,40}\bimages?\b/i.test(text);
  return mentionsImageInput && rejectsInput;
}

export function summarizeFileToolResult(value: unknown): string | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== 'content' ||
    !('value' in value) ||
    !Array.isArray(value.value)
  ) {
    return null;
  }
  const files = value.value.filter(
    (part): part is { type: 'file-data'; data: string; mediaType: string; filename?: string } =>
      Boolean(part) &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'file-data' &&
      'data' in part &&
      typeof part.data === 'string' &&
      part.data.length <= Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4 &&
      'mediaType' in part &&
      typeof part.mediaType === 'string' &&
      /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(part.mediaType),
  );
  if (files.length === 0) return null;
  const details = files.map(
    (file) =>
      (typeof file.filename === 'string' ? file.filename + ' ' : '') +
      '(' +
      file.mediaType +
      ', ' +
      Math.floor((file.data.length * 3) / 4).toLocaleString('en-US') +
      ' bytes)',
  );
  const description = value.value
    .filter(
      (part): part is { type: 'text'; text: string } =>
        Boolean(part) &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
  return [description, 'File sent to model: ' + details.join('; ') + '.'].filter(Boolean).join('\n');
}

export function fileToolResultToModelMessage(value: unknown): ModelMessage | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== 'content' ||
    !('value' in value) ||
    !Array.isArray(value.value)
  ) {
    return null;
  }
  const files = value.value.filter(
    (part): part is { type: 'file-data'; data: string; mediaType: string; filename?: string } =>
      Boolean(part) &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'file-data' &&
      'data' in part &&
      typeof part.data === 'string' &&
      part.data.length <= Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4 &&
      'mediaType' in part &&
      typeof part.mediaType === 'string' &&
      /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(part.mediaType),
  );
  if (files.length === 0) return null;
  const description = value.value
    .filter(
      (part): part is { type: 'text'; text: string } =>
        Boolean(part) &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
  const content: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string; filename?: string }> = [
    { type: 'text', text: description || 'Inspect the attached file as context for the current request.' },
    ...files.map((file) => ({
      type: 'file' as const,
      data: file.data,
      mediaType: file.mediaType,
      ...(file.filename ? { filename: file.filename } : {}),
    })),
  ];
  return { role: 'user', content };
}

export function imageToolResultToModelMessage(value: unknown): ModelMessage | null {
  const image = parseImageToolResult(value);
  if (!image) return null;
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }> = [
    {
      type: 'text',
      text: [image.description, 'Inspect this image as visual context for the current user request.'].filter(Boolean).join('\n'),
    },
    ...image.images.map((part) => ({ type: 'image' as const, image: part.data, mediaType: part.mediaType })),
  ];
  return { role: 'user', content };
}

function parseImageToolResult(value: unknown): { description: string; images: Array<{ data: string; mediaType: ImageMediaType }> } | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== 'content' ||
    !('value' in value) ||
    !Array.isArray(value.value)
  ) {
    return null;
  }
  const images = value.value
    .filter(
      (part): part is { type: 'image-data'; data: string; mediaType: ImageMediaType } =>
        Boolean(part) &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'image-data' &&
        'data' in part &&
        typeof part.data === 'string' &&
        part.data.length <= Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 &&
        'mediaType' in part &&
        typeof part.mediaType === 'string' &&
        IMAGE_TYPES.includes(part.mediaType as ImageMediaType),
    )
    .map(({ data, mediaType }) => ({ data, mediaType }));
  if (images.length === 0) return null;
  const description = value.value
    .filter(
      (part): part is { type: 'text'; text: string } =>
        Boolean(part) &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
  return { description, images };
}

async function loadImage(
  source: string,
  sourceType: ImageSourceType,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType }> {
  const kind = sourceType === 'auto' ? inferSourceType(source) : sourceType;
  let bytes: Buffer;
  let declaredType = '';

  if (kind === 'clipboard') {
    const base64 = await readClipboardImageBase64();
    if (!base64) throw new Error('No image is available on the system clipboard.');
    bytes = decodeBase64(base64);
  } else if (kind === 'base64') {
    bytes = decodeBase64(source);
  } else if (kind === 'data-url') {
    bytes = decodeDataUrl(source);
  } else if (kind === 'url') {
    const url = new URL(source);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP and HTTPS image URLs are supported.');
    if (url.username || url.password) throw new Error('Image URLs with embedded credentials are not allowed.');
    const { downloadBlob } = await import('@ai-sdk/provider-utils');
    const blob = await downloadBlob(url.toString(), { maxBytes: MAX_IMAGE_BYTES, abortSignal: signal });
    declaredType = blob.type.toLowerCase().split(';', 1)[0]?.trim() ?? '';
    bytes = Buffer.from(await blob.arrayBuffer());
  } else {
    // Local paths are classified and read by file_read itself, never routed through the image loader.
    throw new Error('Local image paths are read as files, not loaded as image sources.');
  }

  if (bytes.length === 0) throw new Error('The image source is empty.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Images larger than 5 MB are not supported.');
  const mediaType = detectImageType(bytes);
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== mediaType) {
    throw new Error(`The URL declared ${declaredType}, but the downloaded data is ${mediaType}.`);
  }
  return { bytes, mediaType };
}

function inferSourceType(source: string): ImageSourceType {
  if (source.toLowerCase() === 'clipboard') return 'clipboard';
  if (/^data:/i.test(source)) return 'data-url';
  if (/^https?:\/\//i.test(source)) return 'url';
  if (/^file:/i.test(source)) return 'path';
  return 'path';
}

export function isImageSourceType(value: unknown): value is ImageSourceType {
  return value === 'auto' || value === 'path' || value === 'url' || value === 'data-url' || value === 'base64' || value === 'clipboard';
}

function decodeDataUrl(source: string): Buffer {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/i.exec(source);
  if (!match?.[2]) throw new Error('Use a base64 data URL with a supported image type.');
  return decodeBase64(match[2]);
}

function decodeBase64(value: string): Buffer {
  const base64 = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new Error('The image data is not valid base64.');
  }
  if (base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) throw new Error('Images larger than 5 MB are not supported.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Images larger than 5 MB are not supported.');
  return bytes;
}

function detectImageType(bytes: Buffer): ImageMediaType {
  const mediaType = imageTypeFromBytes(bytes);
  if (mediaType === null) throw new Error(`Unsupported image type. Use ${IMAGE_TYPES.join(', ')}.`);
  return mediaType;
}
