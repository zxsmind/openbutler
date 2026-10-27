import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsFooter, SettingsHeader } from './settings-chrome.js';

describe('settings navigation chrome', () => {
  it('matches the conversation sidebar header and search-button structure', () => {
    const html = renderToStaticMarkup(createElement(SettingsHeader, { onSearch() {} }));
    expect(html).toContain('class="sidebar-heading"');
    expect(html).toContain('class="sidebar-brand"');
    expect(html).toContain('Ranite');
    expect(html).toContain('class="spacer"');
    expect(html).toContain('class="button button-ghost icon-button');
    expect(html).toContain('aria-label="Search settings"');
    expect(html).toContain('lucide-search');
    expect(html).not.toContain('settings-nav__search');
  });

  it('places Back to chat in the settings footer', () => {
    const html = renderToStaticMarkup(createElement(SettingsFooter, { onReturn() {} }));
    expect(html).toContain('settings-nav__footer');
    expect(html).toContain('settings-nav__return');
    expect(html).toContain('Back to chat');
    expect(html).toContain('type="button"');
  });
});
