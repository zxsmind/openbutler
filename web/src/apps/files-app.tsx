import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { fetchWorkspaceFiles, fetchWorkspaceFileTree } from '../api.js';
import { Icon, IconButton } from '../components/ui.js';
import { Feedback } from '../components/feedback.js';
import type { WorkspaceFiles, WorkspaceFileTree } from '../../../src/web/files-protocol.js';
import { buildFileTree, type FileTreeNode } from './file-tree.js';
import './files-app.css';

function FileBadge({ name }: { name: string }) {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  const badges: Record<string, string> = { ts: 'TS', tsx: 'TS', js: 'JS', mjs: 'JS', jsx: 'JS', md: 'M↓', json: '{}', css: '#' };
  const badge = badges[extension];
  return badge ? <span className={`files-type files-type-${extension}`}>{badge}</span> : <Icon name="file" size={13} />;
}

function TreeGroup({
  label,
  initialOpen = false,
  children,
  changed = false,
}: {
  label: string;
  initialOpen?: boolean;
  children: ReactNode;
  changed?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details className="files-tree-folder" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name="chevron-right" size={12} />
        <span>{label}</span>
        {changed ? <i className="files-change-dot" /> : null}
      </summary>
      {children}
    </details>
  );
}

function TreeNode({
  node,
  depth,
  expanded,
  selected,
  onOpen,
  onExpand,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  selected: string | null;
  onOpen: (node: FileTreeNode) => void;
  onExpand: (path: string) => void;
}) {
  const [open, setOpen] = useState(expanded);
  const folder = node.children !== null;
  const visible = open;
  return (
    <div className="files-tree-node">
      <button
        type="button"
        className={`files-tree-row${selected === node.path ? ' is-selected' : ''}${node.change ? ` is-${node.change}` : ''}`}
        style={{ paddingLeft: 12 + depth * 9 }}
        title={node.path}
        aria-expanded={folder ? visible : undefined}
        aria-current={!folder && selected === node.path ? 'true' : undefined}
        onClick={() => {
          if (folder) {
            setOpen(!visible);
            if (!visible) onExpand(node.path);
          } else onOpen(node);
        }}
      >
        {folder ? <Icon name={visible ? 'chevron-down' : 'chevron-right'} size={12} /> : <FileBadge name={node.name} />}
        <span className="files-tree-name">{node.name}</span>
        {folder && node.changed ? <i className="files-change-dot" /> : null}
        {!folder && node.change ? (
          <span className="files-file-status" title={node.change} aria-label={node.change}>
            <Icon
              name={
                node.change === 'deleted'
                  ? 'square-minus'
                  : node.change === 'modified'
                    ? 'square-pen'
                    : node.change === 'renamed'
                      ? 'arrow-right'
                      : 'square-plus'
              }
              size={14}
            />
          </span>
        ) : null}
      </button>
      {folder && visible
        ? node.children!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selected={selected}
              onOpen={onOpen}
              onExpand={onExpand}
            />
          ))
        : null}
    </div>
  );
}

export function FilesApp({ sessionId }: { sessionId: string }) {
  const [index, setIndex] = useState<WorkspaceFileTree | null>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<FileTreeNode | null>(null);
  const [page, setPage] = useState<Extract<WorkspaceFiles, { kind: 'file' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [treeVisible, setTreeVisible] = useState(true);
  const workbench = useRef<HTMLDivElement>(null);
  const explorerId = useId();
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [treeWidth, setTreeWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointer: number; start: number; width: number } | null>(null);
  // Both panes retain usable space when the outer panel or viewport gets smaller.
  const treeMaximum = Math.max(0, workbenchWidth - Math.min(160, workbenchWidth / 2) - 1);
  const treeMinimum = Math.min(180, treeMaximum);
  const clampTree = (width: number) => Math.max(treeMinimum, Math.min(treeMaximum, width));
  const visibleTreeWidth = clampTree(treeWidth ?? Math.min(310, workbenchWidth / 2));
  useLayoutEffect(() => {
    const element = workbench.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setWorkbenchWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, start: event.clientX, width: visibleTreeWidth };
    setResizing(true);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointer === event.pointerId) setTreeWidth(clampTree(current.width + current.start - event.clientX));
  };
  const finishResize = () => {
    drag.current = null;
    setResizing(false);
  };
  const filter = useRef<HTMLInputElement>(null);
  const loaded = useRef(new Set<string>());
  const generation = useRef(0);
  useEffect(() => {
    let cancelled = false;
    generation.current++;
    loaded.current.clear();
    setTreeError(null);
    fetchWorkspaceFileTree(sessionId)
      .then((result) => {
        if (!cancelled) setIndex(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setTreeError(reason instanceof Error ? reason.message : 'Could not load files.');
      });
    return () => {
      cancelled = true;
      generation.current++;
    };
  }, [sessionId, revision]);
  const expand = (path: string) => {
    if (!index || index.indexed || loaded.current.has(path)) return;
    loaded.current.add(path);
    const current = generation.current;
    fetchWorkspaceFiles(sessionId, path)
      .then((result) => {
        if (current !== generation.current || result.kind !== 'directory') return;
        setIndex((previous) =>
          previous
            ? {
                ...previous,
                entries: [
                  ...previous.entries,
                  ...result.entries.map((entry) => ({
                    path: `${path}/${entry.name}`,
                    change: null,
                    directory: entry.kind === 'directory',
                  })),
                ],
              }
            : previous,
        );
      })
      .catch((reason: unknown) => {
        if (current !== generation.current) return;
        loaded.current.delete(path);
        setTreeError(reason instanceof Error ? reason.message : 'Could not open this folder.');
      });
  };
  useEffect(() => {
    if (!selected) {
      setPage(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setPage(null);
    setError(null);
    setLoading(true);
    if (selected.change === 'deleted') {
      setError('This file has been deleted from the workspace.');
      setLoading(false);
      return;
    }
    fetchWorkspaceFiles(sessionId, selected.path)
      .then((result) => {
        if (cancelled) return;
        if (result.kind === 'file') setPage(result);
        else setError('This path is a folder. Select a file from the workspace tree.');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not open this file.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selected, revision]);
  const changes = useMemo(() => index?.entries.filter((entry) => entry.change !== null) ?? [], [index]);
  const changedTree = useMemo(() => buildFileTree(changes, query), [changes, query]);
  const workspaceTree = useMemo(() => buildFileTree(index?.entries ?? [], query), [index, query]);
  const unavailable = !index && !!treeError;
  const renderNodes = (nodes: FileTreeNode[], expanded: boolean) =>
    nodes.map((node) => (
      <TreeNode
        key={`${node.path}:${!!query}`}
        node={node}
        depth={1}
        expanded={expanded}
        selected={selected?.path ?? null}
        onOpen={setSelected}
        onExpand={expand}
      />
    ));
  return (
    <section className={`files-app${treeVisible && !unavailable ? '' : ' is-tree-hidden'}`} aria-label="Workspace files">
      <div className="files-toolbar">
        <button
          type="button"
          className="files-root-chip"
          title={index?.name ?? 'Workspace'}
          onClick={() => {
            setSelected(null);
            if (unavailable) setRevision((value) => value + 1);
          }}
        >
          {index?.rootLabel ?? <Icon name="folder" size={15} />}
        </button>
        <span className="files-current-path" title={selected?.path}>
          {selected?.path}
        </span>
        <IconButton
          icon="file-search"
          label="Find files"
          disabled={!index}
          onClick={() => {
            setTreeVisible(true);
            requestAnimationFrame(() => filter.current?.focus());
          }}
        />
        <IconButton
          icon="folder-open"
          label={treeVisible ? 'Hide file tree' : 'Show file tree'}
          aria-pressed={treeVisible && !unavailable}
          disabled={!index}
          onClick={() => setTreeVisible((value) => !value)}
        />
      </div>
      <div
        className={`files-workbench${resizing ? ' is-resizing' : ''}`}
        ref={workbench}
        style={{ '--files-tree-width': `${visibleTreeWidth}px` } as CSSProperties}
      >
        <div className="files-editor" aria-busy={loading}>
          {!index && treeError ? (
            <Feedback
              layout="state"
              tone="error"
              title="Files unavailable"
              action={{ label: 'Try again', onClick: () => setRevision((value) => value + 1) }}
            >
              {treeError}
            </Feedback>
          ) : !selected ? (
            <div className="files-empty">
              <Icon name="folder-open" size={30} />
              <h2>Open file</h2>
              <p>Select a file from the workspace tree</p>
            </div>
          ) : loading ? (
            <Feedback layout="state" tone="loading" title="Opening file">
              {selected.name}
            </Feedback>
          ) : error ? (
            <Feedback
              layout="state"
              tone="error"
              title="Couldn't open this file"
              action={
                selected.change === 'deleted'
                  ? { label: 'Back to files', onClick: () => setSelected(null) }
                  : { label: 'Try again', onClick: () => setRevision((value) => value + 1) }
              }
            >
              {error}
            </Feedback>
          ) : page?.content !== null && page ? (
            <pre className="files-preview" key={page.path} tabIndex={0} aria-label={`Preview of ${page.name}`}>
              <code>{page.content || '(Empty file)'}</code>
            </pre>
          ) : (
            <Feedback layout="state" title="Preview unavailable">
              {page?.notice}
            </Feedback>
          )}
        </div>
        <div
          className="files-divider"
          role="separator"
          tabIndex={0}
          aria-label="Resize file tree"
          aria-orientation="vertical"
          aria-controls={explorerId}
          aria-valuemin={Math.round(treeMinimum)}
          aria-valuemax={Math.round(treeMaximum)}
          aria-valuenow={Math.round(visibleTreeWidth)}
          aria-valuetext={`${Math.round(visibleTreeWidth)} pixels`}
          hidden={!treeVisible || unavailable}
          title="Drag to resize file tree. Double-click to reset."
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onDoubleClick={() => setTreeWidth(null)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            setTreeWidth(
              clampTree(
                event.key === 'Home'
                  ? treeMinimum
                  : event.key === 'End'
                    ? treeMaximum
                    : visibleTreeWidth + (event.key === 'ArrowLeft' ? 24 : -24),
              ),
            );
          }}
        />
        <aside id={explorerId} className="files-explorer" aria-label="File explorer" hidden={!treeVisible || unavailable}>
          <label className="files-filter">
            <Icon name="search" size={13} />
            <input
              ref={filter}
              aria-label="Filter files"
              placeholder="Filter files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? <IconButton icon="x" label="Clear file filter" onClick={() => setQuery('')} /> : null}
          </label>
          <div className={`files-tree-scroll${index && query && !workspaceTree.length && !treeError ? ' is-empty' : ''}`}>
            {treeError && index ? (
              <Feedback tone="error" layout="compact" action={{ label: 'Try again', onClick: () => setRevision((value) => value + 1) }}>
                {treeError}
              </Feedback>
            ) : null}
            {!index && !treeError ? (
              <Feedback layout="compact" tone="loading">
                Loading files…
              </Feedback>
            ) : null}
            {index && query && !workspaceTree.length && !treeError ? (
              <p className="files-tree-empty" role="status">
                No matching files.
              </p>
            ) : index ? (
              <>
                {changes.length && (!query || changedTree.length) ? (
                  <TreeGroup label="Changed files" initialOpen changed>
                    {renderNodes(changedTree, true)}
                  </TreeGroup>
                ) : null}
                <TreeGroup key={`${index.name}:${!!query}`} label={index.name} initialOpen={!changes.length || !!query}>
                  {renderNodes(workspaceTree, !!query)}
                  {!workspaceTree.length ? <Feedback layout="compact">This folder is empty.</Feedback> : null}
                </TreeGroup>
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
}
