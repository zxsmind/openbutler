import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import commonLanguages from 'highlight.js/lib/common';
import { Icon } from './components/icon.js';
import { ScrollArea } from './components/scroll-area.js';
import { StreamRanges, StreamText } from './components/stream-text.js';
import { highlightedStream } from './stream-markdown.js';

export function CopyCode({ source }: { source: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 1800);
  };
  const label = status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy code';
  return (
    <button
      className="markdown-block-action"
      type="button"
      data-scroll-preserve
      onClick={() => void copy()}
      aria-label={label}
      title={label}
    >
      <Icon name={status === 'copied' ? 'check' : 'copy'} size={15} />
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </button>
  );
}

export const CodeBlock = memo(function CodeBlock({
  source,
  language = '',
  complete = true,
}: {
  source: string;
  language?: string;
  complete?: boolean;
}) {
  const ranges = useContext(StreamRanges);
  const [expanded, setExpanded] = useState(false);
  const [hljs, setHighlighter] = useState(commonLanguages);
  useEffect(() => {
    if (!language || language === 'mermaid' || commonLanguages.getLanguage(language)) return;
    let cancelled = false;
    void import('highlight.js')
      .then(({ default: allLanguages }) => {
        if (!cancelled) setHighlighter(allLanguages);
      })
      .catch(() => {
        /* Plain code remains readable if the extra grammars cannot load. */
      });
    return () => {
      cancelled = true;
    };
  }, [language]);
  const grammar = hljs.getLanguage(language);
  const html = useMemo(() => {
    if (!hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(source, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [source, language, hljs]);
  return (
    <div className="markdown-code" data-expanded={expanded}>
      <div className="markdown-code-header">
        <span className="markdown-code-language">
          <Icon name="code" size={15} />
          {grammar?.name || language || 'Plain text'}
        </span>
        <div className="markdown-code-actions">
          <button
            className="markdown-block-action"
            type="button"
            data-scroll-preserve
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse code' : 'Expand code'}
            title={expanded ? 'Collapse code' : 'Expand code'}
          >
            <Icon name={expanded ? 'minimize-2' : 'maximize-2'} size={15} />
          </button>
          <CopyCode source={source} />
        </div>
      </div>
      <ScrollArea
        className="markdown-code-scroll"
        role="region"
        aria-label={`${grammar?.name || language || 'Plain text'} code`}
        tabIndex={0}
        follow={!complete}
      >
        <pre>
          {html === null ? (
            <code>
              <StreamText text={source} ranges={ranges} />
            </code>
          ) : ranges.length ? (
            <code>{highlightedStream(html, ranges)}</code>
          ) : (
            <code dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </pre>
      </ScrollArea>
    </div>
  );
});
