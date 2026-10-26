import { decodeString } from 'micromark-util-decode-string';

export const STREAM_REVEAL_MS = 180;
const MOBILE_STREAM_REVEAL_MS = 260;
/**
 * How long a freshly arrived range stays visible before it settles.
 *
 * The viewport is read through the global instead of `window`: this module is
 * compiled by the browser build and, through session-state, by the root
 * typecheck as well, which deliberately carries no DOM lib so server code can
 * never touch browser globals. Without a viewport (the test/Node side) the
 * desktop duration applies, exactly as `typeof window === 'undefined'` did.
 */
export function streamRevealDuration(): number {
  const viewportWidth = (globalThis as { innerWidth?: number | undefined }).innerWidth;
  return viewportWidth !== undefined && viewportWidth <= 760 ? MOBILE_STREAM_REVEAL_MS : STREAM_REVEAL_MS;
}
export interface StreamRange {
  from: number;
  to: number;
  at: number;
}

/** Arrival times belong to received data, never to a component's mount time. */
export function appendReveal(previous: string, next: string, ranges: readonly StreamRange[], now: number): StreamRange[] {
  if (!next.startsWith(previous)) return [];
  const active = ranges.filter((range) => now - range.at < streamRevealDuration());
  if (next.length > previous.length) active.push({ from: previous.length, to: next.length, at: now });
  return active;
}

export interface RevealPart {
  text: string;
  offset: number;
  at?: number | undefined;
}

/** Map decoded Markdown text back to source offsets. Ambiguous generated text
 * stays visible: a parser rewrite must never fade already received content. */
export function textOffsets(value: string, raw: string, start: number, literal = false): number[] | null {
  const exact = raw === value ? 0 : !literal && raw.startsWith('`') ? raw.indexOf(value) : -1;
  if (exact >= 0) return Array.from({ length: value.length }, (_, i) => start + exact + i);
  let decoded = '';
  const offsets: number[] = [];
  const tokens = /\\[!-/:-@[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});|\r\n|[\s\S]/gi;
  for (const match of raw.matchAll(tokens)) {
    const text = match[0] === '\r\n' ? '\n' : literal ? match[0] : decodeString(match[0]);
    decoded += text;
    for (let i = 0; i < text.length; i++) offsets.push(start + match.index + (text === match[0] ? i : match[0].length - 1));
  }
  if (decoded === value) return offsets;
  // HAST positions include container prefixes on continuation lines. Markdown
  // removes these from text, but their source offsets still identify arrivals.
  const lines = decoded.split('\n');
  const visible = value.split('\n');
  if (lines.length !== visible.length) return null;
  const mapped: number[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const prefix = lines[i].length - visible[i].length;
    if (prefix < 0 || !lines[i].endsWith(visible[i]) || !/^[\t >]*$/.test(lines[i].slice(0, prefix))) return null;
    for (let j = cursor + prefix; j < cursor + lines[i].length; j++) mapped.push(offsets[j]);
    cursor += lines[i].length;
    if (i < lines.length - 1) mapped.push(offsets[cursor++]);
  }
  return mapped;
}

export function revealParts(
  text: string,
  offsets: readonly number[],
  ranges: readonly StreamRange[],
  now = performance.now(),
): RevealPart[] {
  const active = ranges.filter((range) => now - range.at < streamRevealDuration());
  if (!text || !active.length) return [{ text, offset: offsets[0] ?? 0 }];
  const parts: RevealPart[] = [];
  let rangeIndex = 0;
  for (let i = 0; i < text.length; i++) {
    const offset = offsets[i];
    while (rangeIndex < active.length && active[rangeIndex].to <= offset) rangeIndex++;
    const range = active[rangeIndex];
    const at = range && offset >= range.from && offset < range.to ? range.at : undefined;
    const last = parts[parts.length - 1];
    // Keep a surrogate pair together even when the transport split it.
    if (last && (last.at === at || /[\uDC00-\uDFFF]/.test(text[i]))) last.text += text[i];
    else parts.push({ text: text[i], offset, at });
  }
  return parts;
}
