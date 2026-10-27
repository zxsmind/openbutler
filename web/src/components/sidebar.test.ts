import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project, SessionInfo } from '../types.js';
import { Sidebar } from './sidebar.js';

const noop = () => {};
const sessions: SessionInfo[] = [{ id: 'saved-1', title: 'Saved chat', preview: 'hello' }];

function render(current?: { id: string; title: string; hasUserMessage?: boolean }) {
  const props = {
    sessions,
    current,
    projects: [] as Project[],
    selectedProjectId: null,
    projectsLoading: false,
    projectsError: null,
    onSelectProject: noop,
    onCreateProject: noop,
    onRetryProjects: noop,
    loading: false,
    error: false,
    disabled: false,
    onSearch: noop,
    onRetry: noop,
    onNew: noop,
    onSelect: noop,
    onClose: noop,
    onSettings: noop,
  };
  return renderToStaticMarkup(createElement(Sidebar, props));
}

describe('sidebar recent list', () => {
  it('does not show the open chat until its first message has landed', () => {
    const draft = render({ id: 'new-chat', title: 'New session', hasUserMessage: false });
    expect(draft).not.toContain('New session');
    expect(draft).toContain('Saved chat');

    const started = render({ id: 'new-chat', title: 'New session', hasUserMessage: true });
    expect(started).toContain('New session');
    expect(started.indexOf('New session')).toBeLessThan(started.indexOf('Saved chat'));
  });

  it('shows a listed chat without duplicating it', () => {
    const html = render({ id: 'saved-1', title: 'Saved chat', hasUserMessage: true });
    expect(html.match(/Saved chat/g)).toHaveLength(1);
  });
});
