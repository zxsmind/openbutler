import { createContext, memo, useContext, useId, useMemo, type ComponentProps } from 'react';
import type { Root } from 'hast';
import { visit } from 'unist-util-visit';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { CodeBlock } from './markdown-code.js';
import MarkdownDiagram from './markdown-diagram.js';
import { StreamRanges } from './components/stream-text.js';
import { rehypeStreamReveal, StreamSpan } from './stream-markdown.js';
import { revealParts, textOffsets, type StreamRange } from './stream-reveal.js';
import 'katex/dist/katex.min.css';
import './markdown.css';

const MarkdownSource = createContext('');
const remarkPlugins = [remarkGfm, remarkMath];
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u', 'mark', 'sub', 'sup', 'kbd'],
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};
function localAnchors({ prefix }: { prefix: string }) {
  return (tree: Root) => {
    const ids = new Map<string, string>();
    visit(tree, 'element', (node) => {
      if (typeof node.properties.id === 'string') {
        const original = node.properties.id;
        node.properties.id = prefix + original;
        ids.set(original, node.properties.id);
      }
    });
    const target = (id: string) => ids.get(id) ?? ids.get(`${defaultSchema.clobberPrefix}${id}`);
    visit(tree, 'element', (node) => {
      const href = node.properties.href;
      if (typeof href === 'string' && href.startsWith('#')) {
        try {
          const id = target(decodeURIComponent(href.slice(1)));
          if (id) node.properties.href = `#${id}`;
        } catch {
          /* An invalid fragment remains an ordinary link. */
        }
      }
      const describedBy = node.properties.ariaDescribedBy;
      if (Array.isArray(describedBy)) node.properties.ariaDescribedBy = describedBy.map((id) => target(String(id)) ?? id);
    });
  };
}

const basePlugins: NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [rehypeRaw, [rehypeSanitize, schema]];

function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const markdown = useContext(MarkdownSource);
  const ranges = useContext(StreamRanges);
  const code = node?.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code' || code.children.some((child) => child.type !== 'text'))
    return <pre {...props}>{children}</pre>;
  const source = code.children
    .map((child) => (child.type === 'text' ? child.value : ''))
    .join('')
    .replace(/\n$/, '');
  const classes = Array.isArray(code.properties.className) ? code.properties.className : [];
  const language = String(classes.find((name) => String(name).startsWith('language-')) ?? '')
    .replace(/^language-/, '')
    .toLowerCase();
  const raw = markdown.slice(node?.position?.start.offset ?? 0, node?.position?.end.offset ?? 0);
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
  const complete = !fence || new RegExp(`\\n {0,3}${fence[0]}{${fence.length},}[\\t ]*(?:\\r?\\n)*$`).test(raw);
  const start = (node?.position?.start.offset ?? 0) + (fence ? raw.indexOf('\n') + 1 : 0);
  const body = fence
    ? markdown
        .slice(start, node?.position?.end.offset)
        .replace(new RegExp(`\\r?\\n[>\\t ]*${fence[0]}{${fence.length},}[\\t ]*(?:\\r?\\n)*$`), '\n')
        .replace(/\r?\n$/, '')
    : raw.replace(/\r?\n$/, '');
  const offsets = ranges.length ? textOffsets(source, body, start, true) : null;
  let cursor = 0;
  const codeRanges: StreamRange[] = offsets
    ? revealParts(source, offsets, ranges).flatMap((part) => {
        const from = cursor;
        cursor += part.text.length;
        return part.at === undefined ? [] : [{ from, to: cursor, at: part.at }];
      })
    : [];
  return (
    <StreamRanges.Provider value={codeRanges}>
      {language === 'mermaid' ? (
        <MarkdownDiagram source={source} complete={complete} />
      ) : (
        <CodeBlock source={source} language={language} complete={complete} />
      )}
    </StreamRanges.Provider>
  );
}

// Stable component identities preserve code controls while the message streams.
const components: Components = {
  span: StreamSpan,
  pre: MarkdownPre,
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table-scroll" role="region" aria-label="Table" tabIndex={0} data-scroll-viewport>
      <table {...props} />
    </div>
  ),
  a: ({ node: _node, href, ...props }) => (
    <a
      {...props}
      href={href}
      target={href?.startsWith('#') ? undefined : '_blank'}
      data-scroll-preserve={href?.startsWith('#') || undefined}
      rel="noreferrer"
    />
  ),
  img: ({ node: _node, ...props }) => <img {...props} loading="lazy" decoding="async" referrerPolicy="no-referrer" />,
};

const noRanges: readonly StreamRange[] = [];

export const Markdown = memo(function Markdown({ text, reveal = noRanges }: { text: string; reveal?: readonly StreamRange[] }) {
  const id = useId();
  const rehypePlugins = useMemo<NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>>(
    () => [
      ...basePlugins,
      [localAnchors, { prefix: `md-${id.replace(/[^a-zA-Z0-9_-]/g, '')}-` }],
      [rehypeKatex, { strict: 'ignore', trust: false }],
      [rehypeStreamReveal, { source: text, ranges: reveal }],
    ],
    [id, text, reveal],
  );
  return (
    <MarkdownSource.Provider value={text}>
      <StreamRanges.Provider value={reveal}>
        <div className="markdown">
          <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
            {text}
          </ReactMarkdown>
        </div>
      </StreamRanges.Provider>
    </MarkdownSource.Provider>
  );
});
