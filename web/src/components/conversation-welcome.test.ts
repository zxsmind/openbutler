import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationWelcome } from './conversation-welcome.js';

describe('conversation welcome', () => {
  it('shows the default greeting', () => {
    const html = renderToStaticMarkup(createElement(ConversationWelcome));
    expect(html).toContain('class="conversation-welcome"');
    expect(html).toContain('aria-label="New conversation"');
    expect(html).toContain('What do you want to do?');
    expect(html).toContain('brand-symbol large');
    expect(html).toContain('aria-label="Ranite"');
  });

  it('shows project-aware greeting', () => {
    const html = renderToStaticMarkup(createElement(ConversationWelcome, { projectName: 'Alpha' }));
    expect(html).toContain('<span>Alpha</span> project: what should we build?');
    expect(html).not.toContain('What do you want to do?');
  });
});
