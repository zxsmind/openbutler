import { memo, useEffect, useId, useState } from 'react';
import type { Mermaid } from 'mermaid';
import { Icon } from './components/icon.js';
import { CodeBlock, CopyCode } from './markdown-code.js';

let engine: Promise<Mermaid> | undefined;
function loadMermaid() {
  return (engine ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      look: 'classic',
      fontFamily: 'SF Pro, system-ui, sans-serif',
      themeVariables: {
        fontFamily: 'SF Pro, system-ui, sans-serif',
        fontSize: '14px',
        primaryColor: '#e5f2ff',
        primaryTextColor: '#07558c',
        primaryBorderColor: '#d4dee7',
        secondaryColor: '#f3f8ff',
        tertiaryColor: '#ffffff',
        lineColor: '#a0a4aa',
        actorBkg: '#e4edfb',
        actorBorder: '#85adff',
        actorTextColor: '#292a2e',
        signalColor: '#73777d',
        signalTextColor: '#292a2e',
      },
    });
    return mermaid;
  }));
}

export default memo(function MarkdownDiagram({ source, complete }: { source: string; complete: boolean }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [result, setResult] = useState<{ source: string; svg: string | null } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!complete) return;
    let cancelled = false;
    void loadMermaid()
      .then(async (mermaid) => {
        await document.fonts.ready;
        if (cancelled) return null;
        if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
        const { svg } = await mermaid.render(id, source);
        return svg;
      })
      .then((svg) => {
        if (!cancelled) setResult({ source, svg });
      })
      .catch(() => {
        if (!cancelled) setResult({ source, svg: null });
      });
    return () => {
      cancelled = true;
    };
  }, [source, complete, id]);

  if (!complete) return <CodeBlock source={source} language="mermaid" complete={false} />;
  if (showSource)
    return (
      <div className="markdown-diagram-source">
        <button className="markdown-diagram-back" type="button" data-scroll-preserve onClick={() => setShowSource(false)}>
          <Icon name="panels-top-left" size={14} />
          Show diagram
        </button>
        <CodeBlock source={source} language="mermaid" />
      </div>
    );
  if (result?.source !== source)
    return (
      <div className="markdown-diagram-pending" role="status">
        Rendering diagram…
      </div>
    );
  if (!result.svg)
    return (
      <div className="markdown-diagram-fallback">
        <p>Diagram preview is unavailable. The source is preserved.</p>
        <CodeBlock source={source} language="mermaid" />
      </div>
    );
  return (
    <div className="markdown-diagram" data-expanded={expanded}>
      <div className="markdown-diagram-actions">
        <button
          className="markdown-block-action"
          type="button"
          data-scroll-preserve
          onClick={() => setShowSource(true)}
          aria-label="View Mermaid source"
          title="View source"
        >
          <Icon name="code" size={15} />
        </button>
        <button
          className="markdown-block-action"
          type="button"
          data-scroll-preserve
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? 'Fit diagram' : 'Expand diagram'}
          title={expanded ? 'Fit diagram' : 'Expand diagram'}
        >
          <Icon name={expanded ? 'minimize-2' : 'maximize-2'} size={15} />
        </button>
        <CopyCode source={source} />
      </div>
      <div className="markdown-diagram-scroll" data-scroll-viewport tabIndex={0} role="region" aria-label="Mermaid diagram">
        <div className="markdown-diagram-canvas" dangerouslySetInnerHTML={{ __html: result.svg }} />
      </div>
    </div>
  );
});
