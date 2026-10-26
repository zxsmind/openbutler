import { createElement, Fragment, type ComponentProps, type ReactNode } from 'react';
import type { Element, Root, RootContent } from 'hast';
import type { ExtraProps } from 'react-markdown';
import { fromHtml } from 'hast-util-from-html';
import { SKIP, visit } from 'unist-util-visit';
import { StreamChunk, StreamText } from './components/stream-text.js';
import { revealParts, textOffsets, streamRevealDuration, type StreamRange } from './stream-reveal.js';

/** Runs after sanitization and math. Generated math and block code have their
 * own renderers; only text with a reliable source location can fade. */
export function rehypeStreamReveal({ source, ranges }: { source: string; ranges: readonly StreamRange[] }) {
  return (tree: Root) => {
    if (!ranges.length) return;
    const now = performance.now();
    visit(tree, (node, index, parent) => {
      if (
        node.type === 'element' &&
        (node.tagName === 'pre' || node.tagName === 'math' || node.properties.className?.toString().includes('katex'))
      )
        return SKIP;
      if (node.type !== 'text' || !parent || index === undefined) return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      if (!ranges.some((range) => range.from < end && range.to > start && now - range.at < streamRevealDuration())) return;
      const offsets = textOffsets(node.value, source.slice(start, end), start);
      if (!offsets) return;
      const parts = revealParts(node.value, offsets, ranges, now);
      if (!parts.some((part) => part.at !== undefined)) return;
      const children: RootContent[] = parts.map((part) =>
        part.at === undefined
          ? { type: 'text', value: part.text }
          : {
              type: 'element',
              tagName: 'span',
              properties: { dataStreamAt: part.at },
              children: [{ type: 'text', value: part.text }],
            },
      );
      parent.children.splice(index, 1, ...children);
      return [SKIP, index + children.length];
    });
  };
}

export function StreamSpan({ node, children, ...props }: ComponentProps<'span'> & ExtraProps) {
  const at = node?.properties.dataStreamAt;
  return typeof at === 'number' ? <StreamChunk at={at}>{children}</StreamChunk> : <span {...props}>{children}</span>;
}

/** Parse highlight.js' escaped HTML with the existing HTML parser, so syntax
 * spans and arrival spans are composed by React instead of replacing innerHTML. */
export function highlightedStream(html: string, ranges: readonly StreamRange[]): ReactNode {
  let offset = 0;
  function render(node: RootContent, index: number): ReactNode {
    if (node.type === 'text') {
      const start = offset;
      offset += node.value.length;
      return <StreamText key={index} text={node.value} offset={start} ranges={ranges} />;
    }
    if (node.type !== 'element') return null;
    const element: Element = node;
    return createElement(
      'span',
      { key: index, className: (element.properties.className as string[] | undefined)?.join(' ') },
      element.children.map(render),
    );
  }
  return <Fragment>{fromHtml(html, { fragment: true }).children.map(render)}</Fragment>;
}
