import type { Token, Tokens } from 'marked';

/**
 * Merges freshly completed markdown tokens into the already rendered stable
 * sequence, joining list fragments that were split by a streaming boundary.
 *
 * Pure: never mutates `previous` or any token it has already returned.
 */
export function mergeMarkdownTokenSegments(previous: Token[], next: Token[]): Token[] {
  const merged = [...previous];
  for (const token of next) {
    if (token.type === 'space') continue;
    const last = merged.at(-1);
    if (last?.type === 'list' && token.type === 'list') {
      const left = last as Tokens.List;
      const right = token as Tokens.List;
      const leftStart = typeof left.start === 'number' ? left.start : 1;
      const rightStart = typeof right.start === 'number' ? right.start : 1;
      if (left.ordered === right.ordered && (!left.ordered || rightStart === leftStart + left.items.length)) {
        merged[merged.length - 1] = {
          ...left,
          raw: `${left.raw}\n${right.raw}`,
          loose: true,
          items: [...left.items, ...right.items],
        };
        continue;
      }
    }
    merged.push(token);
  }
  return merged;
}
