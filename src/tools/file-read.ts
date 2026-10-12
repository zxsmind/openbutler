import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { JSONValue } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import {
  createFileToolResult,
  createImageToolResult,
  imageTypeFromBytes,
  isImageSourceType,
  loadImageSource,
  summarizeFileToolResult,
  summarizeImageToolResult,
  type ImageSourceType,
} from '../image.js';
import { classifyFilePath, resolveFilePath } from '../file-write-core.js';
import { isMemoryDocumentPath, isMemoryIndexPath } from '../memory-paths.js';
import { isTrustedSkillResourcePath } from '../skills.js';
import { MAX_TOOL_INPUT_CHARS, type ToolDefinition, type ToolEffect } from './registry.js';
import { classifyTrustedPath, resolveThroughExistingParents, trustedRootsFor } from '../workspace-scope.js';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CONTENT_CODE_POINTS = 30_000;
const MAX_READ_INPUT_CHARS = MAX_TOOL_INPUT_CHARS;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_DIR_CHILD_STAT = 500;
const MAX_FILE_READ_LINES = 5_000;
const MAX_OTHER_MEDIA_BYTES = 10 * 1024 * 1024;

const readEffect: ToolEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
};

type DirectoryPageEntry =
  | { name: string; type: 'file'; sizeBytes: number | null; mtime: string | null }
  | {
      name: string;
      type: 'directory';
      sizeBytes: null;
      filesBytes: number | null;
      childEntries: number | null;
      truncated?: boolean;
      mtime: string | null;
    }
  | { name: string; type: 'symlink' | 'other'; sizeBytes: null; mtime: string | null };

async function statEntrySize(root: string, name: string): Promise<{ size: number; mtime: string } | null> {
  try {
    const details = await stat(join(root, name));
    return { size: details.size, mtime: details.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Directory entries carry sizes and modification times; directories add a capped shallow file total. */
async function describeDirectoryEntry(root: string, entry: Dirent): Promise<DirectoryPageEntry> {
  const name = entry.name;
  if (entry.isFile()) {
    const details = await statEntrySize(root, name);
    return { name, type: 'file', sizeBytes: details?.size ?? null, mtime: details?.mtime ?? null };
  }
  if (!entry.isDirectory()) {
    return { name, type: entry.isSymbolicLink() ? 'symlink' : 'other', sizeBytes: null, mtime: null };
  }
  const self = await statEntrySize(root, name);
  let children: Dirent[];
  try {
    children = await readdir(join(root, name), { withFileTypes: true });
  } catch {
    return { name, type: 'directory', sizeBytes: null, filesBytes: null, childEntries: null, mtime: self?.mtime ?? null };
  }
  let filesBytes = 0;
  const scanned = children.slice(0, MAX_DIR_CHILD_STAT);
  await Promise.all(
    scanned.map(async (child) => {
      if (!child.isFile()) return;
      const details = await statEntrySize(join(root, name), child.name);
      if (details) filesBytes += details.size;
    }),
  );
  return {
    name,
    type: 'directory',
    sizeBytes: null,
    filesBytes,
    childEntries: children.length,
    ...(children.length > scanned.length ? { truncated: true } : {}),
    mtime: self?.mtime ?? null,
  };
}

/** Reads UTF-8 text or passes a validated image to a vision-capable model. */
export function createReadTool(inputModalities: readonly string[], workspaceRoot = process.cwd()): ToolDefinition {
  const supportsVision = inputModalities.includes('image');
  return {
    providerId: 'host',
    name: 'file_read',
    description:
      'Read a directory listing or a bounded range of a local UTF-8 text file. offset is a 1-based line/entry number and limit is a line/entry count. Directory entries carry sizes and modification times; directories additionally report the byte total of their direct files (filesBytes, capped scan) and child entry counts. If a text result has nextCharacterOffset, continue by repeating the same offset/limit and passing that value as characterOffset; when nextOffset is returned, continue at that line with characterOffset 0. sha256 always covers the complete on-disk text file, even when content is paged. Local image, audio, video, and PDF files are attached only when the selected model advertises that input modality. Images may also be loaded from HTTP(S) URLs, data URLs, base64, or clipboard. Workspace reads follow the active permission mode. Ranite memory, bundled skills, and installed global skill files are pre-authorized.',
    maxInputChars: MAX_READ_INPUT_CHARS,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'An absolute or workspace-relative file/directory path, HTTP(S) image URL, data:image URL, base64 image data, or "clipboard".',
        },
        sourceType: {
          type: 'string',
          enum: ['auto', 'path', 'url', 'data-url', 'base64', 'clipboard'],
          description: 'Optional hint when the source cannot be identified automatically.',
        },
        offset: { type: 'integer', minimum: 1, description: 'Optional 1-based line or directory-entry offset; defaults to 1.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_FILE_READ_LINES,
          description: 'Optional maximum number of lines or directory entries to return.',
        },
        characterOffset: {
          type: 'integer',
          minimum: 0,
          description:
            'Optional 0-based Unicode code-point offset within the selected text line range; use nextCharacterOffset to continue the same range without losing long-line content.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    effect: readEffect,
    resolveTarget: (input) => resolvePathTarget(input, workspaceRoot),
    workspaceScope: (input, target) => {
      const source = typeof input.path === 'string' ? input.path.trim() : '';
      if (!source) return 'unknown';
      const sourceType = isImageSourceType(input.sourceType) ? input.sourceType : 'auto';
      if (resolveImageSourceType(source, sourceType) !== 'path') return 'outside';
      try {
        return classifyTrustedPath(target ?? resolveFilePath(source, workspaceRoot), trustedRootsFor(workspaceRoot));
      } catch {
        return 'unknown';
      }
    },
    autoApprove: (input, target) => {
      const path = target ?? (typeof input.path === 'string' ? input.path : '');
      return (
        isMemoryIndexPath(path, workspaceRoot) ||
        isMemoryDocumentPath(path, workspaceRoot) ||
        isTrustedSkillResourcePath(path, workspaceRoot)
      );
    },
    assess: (input, target) => {
      const source = typeof input.path === 'string' ? input.path : '';
      const sourceType = isImageSourceType(input.sourceType) ? input.sourceType : 'auto';
      const remote = sourceType === 'url' || (sourceType === 'auto' && /^https?:\/\//i.test(source));
      return { ...readEffect, data: classifyFilePath(target ?? source, workspaceRoot), network: remote ? 'used' : 'none' };
    },
    toModelOutput: (output) =>
      summarizeImageToolResult(output) !== null || summarizeFileToolResult(output) !== null
        ? (output as ToolResultOutput)
        : { type: 'json', value: output as JSONValue },
    execute: async (input, signal, context) => {
      const source = typeof input.path === 'string' ? input.path.trim() : '';
      const sourceType = isImageSourceType(input.sourceType) ? input.sourceType : 'auto';
      if (!source) return { status: 'invalid', error: 'path must be a non-empty string.' };
      const requestedOffset = input.offset;
      const requestedLimit = input.limit;
      const requestedCharacterOffset = input.characterOffset;
      if (requestedOffset !== undefined && (!Number.isSafeInteger(requestedOffset) || Number(requestedOffset) < 1)) {
        return { status: 'invalid', error: 'offset must be a positive 1-based line or entry number.' };
      }
      if (
        requestedLimit !== undefined &&
        (!Number.isSafeInteger(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > MAX_FILE_READ_LINES)
      ) {
        return { status: 'invalid', error: 'limit must be between 1 and 5000.' };
      }
      if (
        requestedCharacterOffset !== undefined &&
        (!Number.isSafeInteger(requestedCharacterOffset) || Number(requestedCharacterOffset) < 0)
      ) {
        return { status: 'invalid', error: 'characterOffset must be a non-negative Unicode code-point offset.' };
      }
      const hasRange = requestedOffset !== undefined || requestedLimit !== undefined || requestedCharacterOffset !== undefined;

      const kind = resolveImageSourceType(source, sourceType);
      if (kind !== 'path') {
        if (hasRange) return { status: 'invalid', error: 'offset and limit apply only to local files and directories.' };
        if (!supportsVision) return { status: 'unsupported', error: 'The selected model does not support image input.' };
        const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
        const image = await loadImageSource(source, kind, operationSignal);
        return createImageToolResult(image.bytes, image.mediaType);
      }

      const path = context?.target ?? resolveFilePath(source, workspaceRoot);
      const details = await stat(path);
      if (details.isDirectory()) {
        if (requestedCharacterOffset !== undefined)
          return { status: 'invalid', path: path.slice(0, 512), error: 'characterOffset applies only to text files.' };
        const entries = await readdir(path, { withFileTypes: true });
        const offset = typeof requestedOffset === 'number' ? requestedOffset : 1;
        const limit = Math.min(typeof requestedLimit === 'number' ? requestedLimit : MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES);
        if (offset > entries.length && entries.length > 0) {
          return {
            status: 'invalid',
            path: path.slice(0, 512),
            entryCount: entries.length,
            error: 'offset is beyond the end of the directory listing.',
          };
        }
        const page = await Promise.all(
          entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(offset - 1, offset - 1 + limit)
            .map((entry) => describeDirectoryEntry(path, entry)),
        );
        return {
          status: 'completed',
          path: path.slice(0, 512),
          offset,
          limit,
          entries: page,
          totalEntries: entries.length,
          truncated: offset - 1 + page.length < entries.length,
        };
      }
      if (!details.isFile()) return { status: 'invalid', error: 'path must refer to a regular file or directory.' };
      if (details.size > MAX_OTHER_MEDIA_BYTES) {
        return { status: 'too_large', path: path.slice(0, 512), sizeBytes: details.size, maxBytes: MAX_OTHER_MEDIA_BYTES };
      }

      const bytes = await readFile(path, signal ? { signal } : undefined);
      const mediaType = imageTypeFromBytes(bytes);
      if (mediaType !== null) {
        if (hasRange)
          return {
            status: 'invalid',
            path: path.slice(0, 512),
            error: 'offset, limit, and characterOffset apply only to text files and directories.',
          };
        if (!supportsVision)
          return { status: 'unsupported', path: path.slice(0, 512), error: 'The selected model does not support image input.' };
        if (bytes.length > MAX_IMAGE_BYTES) {
          return { status: 'too_large', path: path.slice(0, 512), sizeBytes: bytes.length, maxBytes: MAX_IMAGE_BYTES };
        }
        return createImageToolResult(bytes, mediaType);
      }
      const media = detectFileMedia(path, bytes);
      if (media) {
        if (hasRange)
          return {
            status: 'invalid',
            path: path.slice(0, 512),
            error: 'offset, limit, and characterOffset apply only to text files and directories.',
          };
        if (!inputModalities.includes(media.modality)) {
          return {
            status: 'unsupported',
            path: path.slice(0, 512),
            mediaType: media.mediaType,
            error: 'The selected model does not support ' + media.modality + ' input.',
          };
        }
        return createFileToolResult(bytes, media.mediaType, basename(path));
      }
      if (bytes.length > MAX_TEXT_FILE_BYTES) {
        return { status: 'too_large', path: path.slice(0, 512), sizeBytes: bytes.length, maxBytes: MAX_TEXT_FILE_BYTES };
      }

      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return { status: 'unsupported', path: path.slice(0, 512), error: 'Only UTF-8 text files and supported images are supported.' };
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) {
        return { status: 'unsupported', path: path.slice(0, 512), error: 'Binary or control-character files are not supported.' };
      }

      const lines = content.split(/\r?\n/);
      const offset = typeof requestedOffset === 'number' ? requestedOffset : 1;
      const limit = typeof requestedLimit === 'number' ? requestedLimit : MAX_FILE_READ_LINES;
      const endOffset = offset + limit;
      if (offset > lines.length) {
        return { status: 'invalid', path: path.slice(0, 512), lineCount: lines.length, error: 'offset is beyond the end of the file.' };
      }
      const selectedLines = lines.slice(offset - 1, endOffset - 1);
      const endLine = offset + selectedLines.length - 1;
      const selectedContent = selectedLines.join('\n');
      const characterOffset = typeof requestedCharacterOffset === 'number' ? requestedCharacterOffset : 0;
      const page = sliceUnicodeCodePoints(selectedContent, characterOffset, MAX_CONTENT_CODE_POINTS);
      if (!page) {
        return {
          status: 'invalid',
          path: path.slice(0, 512),
          offset,
          limit,
          totalCharacters: countUnicodeCodePoints(selectedContent),
          error: 'characterOffset is beyond the end of this selected line range.',
        };
      }
      const hasMoreLines = endLine < lines.length;
      const truncated = page.nextCharacterOffset !== undefined || hasMoreLines;
      return {
        status: 'completed',
        path: path.slice(0, 512),
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        offset,
        limit,
        endLine,
        characterOffset,
        content: page.content,
        truncated,
        hasMore: truncated,
        ...(page.nextCharacterOffset === undefined
          ? hasMoreLines
            ? { nextOffset: endLine + 1 }
            : {}
          : { nextCharacterOffset: page.nextCharacterOffset }),
        ...(truncated ? { totalCharacters: page.totalCharacters } : {}),
      };
    },
  };
}

type FileMedia = { modality: 'audio' | 'video' | 'pdf'; mediaType: string };

function sliceUnicodeCodePoints(
  value: string,
  offset: number,
  limit: number,
): { content: string; totalCharacters: number; nextCharacterOffset?: number } | null {
  let index = 0;
  let count = 0;
  while (index < value.length && count < offset) {
    const codePoint = value.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
    count++;
  }
  if (count < offset) return null;
  const start = index;
  let pageCharacters = 0;
  while (index < value.length && pageCharacters < limit) {
    const codePoint = value.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
    pageCharacters++;
  }
  const end = index;
  const nextCharacterOffset = index < value.length ? offset + pageCharacters : undefined;
  let totalCharacters = offset + pageCharacters;
  while (index < value.length) {
    const codePoint = value.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
    totalCharacters++;
  }
  return { content: value.slice(start, end), totalCharacters, ...(nextCharacterOffset === undefined ? {} : { nextCharacterOffset }) };
}

function countUnicodeCodePoints(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

function detectFileMedia(path: string, bytes: Buffer): FileMedia | null {
  const extension = extname(path).toLowerCase();
  const riff = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF';
  const wave = riff && bytes.toString('ascii', 8, 12) === 'WAVE';
  const avi = riff && bytes.toString('ascii', 8, 12) === 'AVI ';
  const ftyp = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  const ebml = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const ogg = bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS';
  const flac = bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'fLaC';
  const pdf = bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
  const mp3 =
    (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  const aac = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
  const mpegVideo = bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && (bytes[3] === 0xb3 || bytes[3] === 0xba);

  if (extension === '.pdf' && pdf) return { modality: 'pdf', mediaType: 'application/pdf' };
  if (['.wav', '.wave'].includes(extension) && wave) return { modality: 'audio', mediaType: 'audio/wav' };
  if (extension === '.flac' && flac) return { modality: 'audio', mediaType: 'audio/flac' };
  if (['.ogg', '.oga', '.opus'].includes(extension) && ogg) return { modality: 'audio', mediaType: 'audio/ogg' };
  if (['.mp3', '.mpga'].includes(extension) && mp3) return { modality: 'audio', mediaType: 'audio/mpeg' };
  if (extension === '.aac' && aac) return { modality: 'audio', mediaType: 'audio/aac' };
  if (['.m4a', '.mp4a'].includes(extension) && ftyp) return { modality: 'audio', mediaType: 'audio/mp4' };
  if (['.mp4', '.m4v'].includes(extension) && ftyp) return { modality: 'video', mediaType: 'video/mp4' };
  if (['.mov', '.qt'].includes(extension) && ftyp) return { modality: 'video', mediaType: 'video/quicktime' };
  if (extension === '.webm' && ebml) return { modality: 'video', mediaType: 'video/webm' };
  if (extension === '.mkv' && ebml) return { modality: 'video', mediaType: 'video/x-matroska' };
  if (extension === '.avi' && avi) return { modality: 'video', mediaType: 'video/x-msvideo' };
  if (['.mpg', '.mpeg'].includes(extension) && mpegVideo) return { modality: 'video', mediaType: 'video/mpeg' };
  return null;
}

function resolveImageSourceType(source: string, sourceType: ImageSourceType): Exclude<ImageSourceType, 'auto'> {
  if (sourceType !== 'auto') return sourceType;
  if (source.toLowerCase() === 'clipboard') return 'clipboard';
  if (/^data:/i.test(source)) return 'data-url';
  if (/^https?:\/\//i.test(source)) return 'url';
  return 'path';
}

function resolvePathTarget(input: Record<string, unknown>, workspaceRoot: string): string | null {
  const source = typeof input.path === 'string' ? input.path.trim() : '';
  if (!source) return null;
  const sourceType = isImageSourceType(input.sourceType) ? input.sourceType : 'auto';
  if (resolveImageSourceType(source, sourceType) !== 'path') return null;
  try {
    return resolveThroughExistingParents(resolveFilePath(source, workspaceRoot));
  } catch {
    return null;
  }
}
