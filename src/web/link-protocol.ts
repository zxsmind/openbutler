/**
 * The link contract shared by every surface that writes or renders a link.
 *
 * Canonical form: a markdown link whose target is a workspace-relative POSIX
 * path with an optional single-line anchor, e.g. `src/agent.ts#L79`. External
 * sources keep their http(s) URL unchanged. Surfaces degrade that one link
 * instead of asking the author to write twice: the web app opens files in the
 * Files panel, the terminal prints the path beside the label, a messaging
 * channel drops the markdown and keeps the text.
 *
 * Safety mirrors the files API, which refuses absolute and out-of-workspace
 * paths: everything is normalised here so no surface re-implements the rules,
 * and anything ambiguous resolves to null and the surface falls back to its
 * plain link behaviour rather than guessing.
 */

export type LinkTarget = { kind: 'file'; path: string; line?: number } | { kind: 'url'; href: string } | { kind: 'anchor'; id: string };

/** `#L12`, never a range: one line is what a citation can honestly point at. */
const LINE_ANCHOR = /^L([1-9]\d{0,6})$/;
/** A Windows drive prefix looks like a URL scheme to a naive parser. */
const DRIVE_PREFIX = /^[a-z]:/i;

function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:\//i.test(path);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Canonical absolute target: unified separators, no dot segments, never a bare
 * root or drive. The server re-validates it and previews single files only.
 */
function cleanAbsolutePath(path: string): string | null {
  const drive = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : (/^[a-z]:\//i.exec(path)?.[0] ?? '');
  if (!drive) return null;
  const segments: string[] = [];
  for (const segment of path.slice(drive.length).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  if (segments.length === 0 || DRIVE_PREFIX.test(segments[0])) return null;
  return `${drive}${segments.join('/')}`;
}

/**
 * Percent-decoded, separator-normalised citation target: workspace-relative
 * inside the scope, absolute when the target lies beyond it (the server then
 * previews that one file read-only and lists no folder). Null for malformed
 * escapes, parent steps, and anything that carries nothing openable.
 */
export function normalizeFilePath(rawPath: string, workspaceRoot?: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) return null;

  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  path = toPosix(path);
  // `/C:/Users/...` is how some renderers quote a Windows absolute path.
  if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);

  if (isAbsoluteLike(path)) {
    const root = workspaceRoot ? toPosix(workspaceRoot).replace(/\/+$/, '') : '';
    const lowerPath = path.toLowerCase();
    const lowerRoot = root.toLowerCase();
    // The scope itself is a folder, never a citable file.
    if (root && lowerPath === lowerRoot) return null;
    if (root && lowerPath.startsWith(`${lowerRoot}/`)) {
      path = path.slice(root.length).replace(/^\/+/, '');
    } else {
      // Beyond the scope: keep it absolute; the server's file-only preview
      // policy is what keeps this read-only.
      return cleanAbsolutePath(path);
    }
  }

  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    // The canonical form is workspace-relative, so any parent step is a
    // request this contract refuses instead of resolving.
    if (segment === '..') return null;
    segments.push(segment);
  }
  if (segments.length === 0 || DRIVE_PREFIX.test(segments[0])) return null;
  return segments.join('/');
}

/**
 * Classifies a rendered href. Unknown schemes, malformed escapes and line
 * ranges return null; a path beyond the scope stays absolute so the server's
 * read-only, single-file preview policy can decide it.
 */
export function parseHref(href: string, workspaceRoot?: string): LinkTarget | null {
  if (typeof href !== 'string') return null;
  const value = href.trim();
  if (value.length === 0) return null;

  if (value.startsWith('#')) {
    const id = value.slice(1);
    return id.length > 0 ? { kind: 'anchor', id } : null;
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme && !DRIVE_PREFIX.test(value)) {
    const name = `${scheme[1].toLowerCase()}:`;
    return name === 'http:' || name === 'https:' ? { kind: 'url', href: value } : null;
  }

  const hash = value.indexOf('#');
  const rawPath = hash === -1 ? value : value.slice(0, hash);
  const path = normalizeFilePath(rawPath, workspaceRoot);
  if (path === null) return null;
  if (hash === -1) return { kind: 'file', path };

  const anchor = LINE_ANCHOR.exec(value.slice(hash + 1));
  return anchor ? { kind: 'file', path, line: Number(anchor[1]) } : null;
}

/** Canonical target for a citation, used by tests and any future authoring path. */
export function formatFileLink(path: string, line?: number): string {
  const normalised = normalizeFilePath(path);
  if (normalised === null) throw new Error('formatFileLink expects a workspace-relative path.');
  if (line === undefined) return normalised;
  if (!Number.isInteger(line) || line < 1) throw new Error('formatFileLink expects a positive line number.');
  return `${normalised}#L${line}`;
}

/** How surfaces that cannot open a file still show it: `src/agent.ts:79`. */
export function displayFilePath(target: { path: string; line?: number }): string {
  return target.line === undefined ? target.path : `${target.path}:${target.line}`;
}
