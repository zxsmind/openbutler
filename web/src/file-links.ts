/**
 * The one place an "open this file" request travels.
 *
 * A citation clicked in a message pushes a request here; the surfaces that can
 * act on it subscribe independently: the workspace panel opens, the Files tab
 * becomes active, and the Files app selects the path. A request stays pending
 * until the Files app acknowledges it, so an app mounted later (Suspense, a tab
 * remount, a closed panel) still receives the newest target instead of losing
 * it during the state changes that bring it on screen.
 *
 * The target is already workspace-relative and line-checked by the link
 * contract before it reaches this module; nothing here re-validates paths.
 */

export interface FileLinkRequest {
  path: string;
  line?: number;
  /** Identifies one request so a late acknowledgement cannot clear a newer one. */
  nonce: number;
}

type FileLinkListener = (request: FileLinkRequest) => void;

let sequence = 0;
let pending: FileLinkRequest | null = null;
const listeners = new Set<FileLinkListener>();

/** Queues a target and notifies every current subscriber. */
export function openFileRequest(target: { path: string; line?: number }): void {
  pending = { ...target, nonce: ++sequence };
  for (const listener of [...listeners]) listener(pending);
}

/** Subscribes to requests; anything still pending is replayed immediately. */
export function subscribeFileLink(listener: FileLinkListener): () => void {
  listeners.add(listener);
  if (pending) listener(pending);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Character offset where a 1-based line starts inside a file's text, or -1
 * when the file has no such line. Pure, so the focus behaviour can be tested
 * without a DOM: the renderer turns offsets into a range, a highlight and a
 * smooth scroll.
 */
export function lineStartOffset(content: string, line: number): number {
  if (!Number.isInteger(line) || line < 1) return -1;
  let offset = 0;
  for (let index = 1; index < line; index++) {
    const next = content.indexOf('\n', offset);
    if (next === -1) return -1;
    offset = next + 1;
  }
  return offset <= content.length ? offset : -1;
}

/** Character offset just past a line's text, including its newline when present. */
export function lineEndOffset(content: string, line: number): number {
  const start = lineStartOffset(content, line);
  if (start === -1) return -1;
  const next = content.indexOf('\n', start);
  return next === -1 ? content.length : Math.min(content.length, next + 1);
}

/** Drops the request once the surface that applies it has done so. */
export function acknowledgeFileLink(nonce: number): void {
  if (pending?.nonce === nonce) pending = null;
}

/** Test seam: clears the queue and every subscription. */
export function resetFileLinks(): void {
  pending = null;
  listeners.clear();
}
