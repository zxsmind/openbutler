/**
 * Models answer with the LaTeX delimiters \(...\) and \[...\] as often as with
 * dollars, but remark-math parses only the dollar grammar - and commonmark
 * consumes the backslash of `\(` as an escape before any plugin sees it, so a
 * later AST pass is already too late. Normalize on the way into session state,
 * before the text reaches the renderer or the reveal ranges are measured:
 * both then work on one consistent string.
 *
 * Code is never rewritten: fenced blocks and inline code spans are copied
 * through verbatim, because their backslashes are content.
 */

const FENCE = /(```[^\n]*\n[\s\S]*?(?:\n```|$)|~~~[^\n]*\n[\s\S]*?(?:\n~~~|$))/g;
const INLINE_CODE = /(`+[^`]*`+)/g;
const DISPLAY_ONLY = /^\\\[([\s\S]+?)\\\]$/;
const INLINE_LATEX = /\\\(([\s\S]+?)\\\)/g;
const INLINE_DISPLAY_LATEX = /\\\[([\s\S]+?)\\\]/g;

function normalizeText(text: string): string {
  return text
    .replace(INLINE_LATEX, (_match, body: string) => `$${body}$`)
    .replace(INLINE_DISPLAY_LATEX, (_match, body: string) => `$${body}$`);
}

function normalizeSegment(segment: string): string {
  // Paragraph-wise, so a sole \[...\] paragraph becomes a display block.
  return segment
    .split(/(\n{2,})/)
    .map((part) => {
      if (part.startsWith('\n')) return part;
      const display = DISPLAY_ONLY.exec(part.trim());
      if (display) return `$$\n${display[1]}\n$$`;
      return normalizeText(part);
    })
    .join('');
}

function normalizeOutsideCode(text: string): string {
  let out = '';
  let cursor = 0;
  FENCE.lastIndex = 0;
  for (const match of text.matchAll(FENCE)) {
    const index = match.index ?? 0;
    out += normalizeOutsideInlineCode(text.slice(cursor, index));
    out += match[0];
    cursor = index + match[0].length;
  }
  out += normalizeOutsideInlineCode(text.slice(cursor));
  return out;
}

function normalizeOutsideInlineCode(text: string): string {
  let out = '';
  let cursor = 0;
  INLINE_CODE.lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    const index = match.index ?? 0;
    out += normalizeSegment(text.slice(cursor, index));
    out += match[0];
    cursor = index + match[0].length;
  }
  out += normalizeSegment(text.slice(cursor));
  return out;
}

/** Rewrite LaTeX delimiters to dollars outside code; a no-op when none exist. */
export function normalizeLatexMath(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  return normalizeOutsideCode(text);
}
