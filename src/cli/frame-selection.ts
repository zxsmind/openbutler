/**
 * Text selection over the rendered terminal frame.
 *
 * Ink writes every frame as one ANSI string. The plain text of that string is
 * the only ground truth for what the user sees, so a selection stores screen
 * cells (row, column in code points), highlighting injects inverse-video SGR
 * codes at those cell boundaries in the outgoing frame, and copying reads the
 * same plain text. Nothing here depends on the application's own layout, so a
 * selection stays aligned with what the terminal actually displays.
 */

export type SelectionCell = { row: number; col: number };
export type FrameSelection = { anchor: SelectionCell; focus: SelectionCell };
export type NormalizedSelection = { start: SelectionCell; end: SelectionCell };

/**
 * Zero-width markers that wrap layout chrome (borders, quote bars, prefixes) in
 * the rendered frame. They are invisible in the terminal, so they never shift a
 * cell, but the copy path removes the marked characters: what you copy is the
 * content, not the decoration the renderer drew around it.
 */
export const DECORATION_START = '\u2060';
export const DECORATION_END = '\u2061';

export function decorate(text: string): string {
  return `${DECORATION_START}${text}${DECORATION_END}`;
}

const ANSI_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_AT = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-9;?]*[ -/]*[@-~]/y;

/** The frame's display lines: ANSI and decoration markers removed, columns intact. */
export function plainFrameLines(chunk: string): string[] {
  return parseFrameLines(chunk).lines;
}

/**
 * Splits a frame into display lines and a per-cell decoration mask. The mask
 * marks exactly the cells that were inside decoration markers, so a copy can
 * drop them while the display keeps them.
 */
export function parseFrameLines(chunk: string): { lines: string[]; decoration: boolean[][] } {
  const raw = chunk
    .replace(ANSI_SEQUENCE, '')
    .split('\n')
    .map((line) => line.replace(/\r/g, ''));
  const lines: string[] = [];
  const decoration: boolean[][] = [];
  for (const line of raw) {
    let text = '';
    const mask: boolean[] = [];
    let inDecor = false;
    for (const character of line) {
      if (character === DECORATION_START) {
        inDecor = true;
        continue;
      }
      if (character === DECORATION_END) {
        inDecor = false;
        continue;
      }
      text += character;
      mask.push(inDecor);
    }
    lines.push(text);
    decoration.push(mask);
  }
  return { lines, decoration };
}

export function normalizeSelection(selection: FrameSelection): NormalizedSelection {
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col)
    ? { start: { ...anchor }, end: { ...focus } }
    : { start: { ...focus }, end: { ...anchor } };
}

export function isCollapsedSelection(selection: FrameSelection): boolean {
  return selection.anchor.row === selection.focus.row && selection.anchor.col === selection.focus.col;
}

/** The selected text exactly as the frame shows it, with trailing spaces trimmed per line. */
export function selectionCellText(lines: readonly string[], selection: NormalizedSelection, decoration?: readonly boolean[][]): string {
  const { start, end } = selection;
  const parts: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    if (row < 0 || row >= lines.length) continue;
    const characters = Array.from(lines[row] ?? '');
    const from = row === start.row ? Math.max(0, Math.min(start.col, characters.length)) : 0;
    const to = row === end.row ? Math.max(from, Math.min(end.col, characters.length)) : characters.length;
    let segment = '';
    for (let column = from; column < to; column++) {
      if (decoration?.[row]?.[column]) continue;
      segment += characters[column];
    }
    parts.push(segment.trimEnd());
  }
  return stripCommonMargin(parts).join('\n');
}

/**
 * Removes the leading whitespace every non-empty selected line shares. The
 * transcript indents every entry by a fixed margin; dropping the common margin
 * copies the content without that layout padding, the way an editor copies a
 * block, while leaving any deeper, content-specific indentation intact.
 */
function stripCommonMargin(parts: string[]): string[] {
  let margin = Number.POSITIVE_INFINITY;
  for (const line of parts) {
    if (line.trim().length === 0) continue;
    margin = Math.min(margin, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(margin) || margin === 0) return parts;
  return parts.map((line) => (line.trim().length === 0 ? '' : line.slice(margin)));
}

/** Rewrites one frame so the selected cells render with inverse video. */
export function injectFrameSelection(chunk: string, selection: NormalizedSelection): string {
  const { start, end } = selection;
  if (end.row < start.row || (start.row === end.row && end.col <= start.col)) return chunk;
  return chunk
    .split('\n')
    .map((segment, row) => {
      if (row < start.row || row > end.row) return segment;
      const from = row === start.row ? start.col : 0;
      const to = row === end.row ? end.col : Number.POSITIVE_INFINITY;
      if (from >= to) return segment;
      return injectSelectionSegment(segment, from, to);
    })
    .join('\n');
}

function injectSelectionSegment(segment: string, from: number, to: number): string {
  let output = '';
  let column = 0;
  let opened = false;
  let closed = false;
  let index = 0;
  while (index < segment.length) {
    const character = segment[index]!;
    if (character === '\u001b') {
      ANSI_AT.lastIndex = index;
      const match = ANSI_AT.exec(segment);
      if (match) {
        output += match[0];
        index = ANSI_AT.lastIndex;
        if (opened && column < to) output += '\u001b[7m';
        continue;
      }
    }
    const codePoint = segment.codePointAt(index)!;
    const text = String.fromCodePoint(codePoint);
    index += text.length;
    if (!opened && !closed && column >= from) {
      output += '\u001b[7m';
      opened = true;
    }
    output += text;
    column += 1;
    if (opened && column >= to) {
      output += '\u001b[27m';
      opened = false;
      closed = true;
    }
  }
  if (opened) output += '\u001b[27m';
  return output;
}

/**
 * Screen-cell selection state for one terminal session. Frame writes feed it;
 * mouse events drive it; copy reads it.
 */
export class FrameSelectionTracker {
  private anchor: SelectionCell | null = null;
  private focus: SelectionCell | null = null;
  private dragging = false;
  private lines: string[] = [];
  private decoration: boolean[][] = [];
  private rawFrame = '';
  private finalizedLines: string[] | null = null;
  private finalizedDecoration: boolean[][] | null = null;

  get isDragging(): boolean {
    return this.dragging;
  }

  press(cell: SelectionCell): void {
    this.anchor = { ...cell };
    this.focus = { ...cell };
    this.dragging = true;
    this.finalizedLines = null;
    this.finalizedDecoration = null;
  }

  drag(cell: SelectionCell): boolean {
    if (!this.dragging || !this.anchor) return false;
    this.focus = { ...cell };
    return true;
  }

  /** Ends a press. Returns whether the gesture produced a real selection. */
  release(): 'click' | 'selection' {
    const wasDragging = this.dragging;
    this.dragging = false;
    if (!wasDragging || !this.anchor || !this.focus || isCollapsedSelection({ anchor: this.anchor, focus: this.focus })) {
      this.anchor = null;
      this.focus = null;
      this.finalizedLines = null;
      this.finalizedDecoration = null;
      return 'click';
    }
    this.finalizedLines = [...this.lines];
    this.finalizedDecoration = this.decoration.map((row) => [...row]);
    return 'selection';
  }

  clear(): void {
    this.anchor = null;
    this.focus = null;
    this.dragging = false;
    this.finalizedLines = null;
    this.finalizedDecoration = null;
  }

  selection(): NormalizedSelection | null {
    if (!this.anchor || !this.focus) return null;
    const normalized = normalizeSelection({ anchor: this.anchor, focus: this.focus });
    return normalized;
  }

  /** Called for every frame Ink writes; returns the frame with the selection highlighted. */
  frame(chunk: string): string {
    const parsed = parseFrameLines(chunk);
    this.rawFrame = chunk;
    this.lines = parsed.lines;
    this.decoration = parsed.decoration;
    // The selection is intentionally NOT cleared when the frame changes: during
    // a streaming run the transcript repaints every frame, and clearing on each
    // one made an active selection vanish mid-copy. The selection stays until
    // the user clears it or starts a new drag.
    const selection = this.selection();
    return selection ? injectFrameSelection(chunk, selection) : chunk;
  }

  /** Re-emits the last frame with the current selection; used while dragging. */
  repaint(): string | null {
    if (!this.rawFrame) return null;
    const selection = this.selection();
    return selection ? injectFrameSelection(this.rawFrame, selection) : this.rawFrame;
  }

  text(): string {
    const selection = this.selection();
    if (!selection) return '';
    // Copy the text as it was when the selection was finalized, so a repaint
    // during a run cannot change what is copied out from under the user.
    return selectionCellText(this.finalizedLines ?? this.lines, selection, this.finalizedDecoration ?? this.decoration);
  }
}
