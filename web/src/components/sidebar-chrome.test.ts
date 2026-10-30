import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SidebarFooter, SidebarHeader } from './sidebar-chrome.js';

describe('shared sidebar chrome', () => {
  it('uses identical header markup in chat and Settings', () => {
    const chat = renderToStaticMarkup(createElement(SidebarHeader, { onSearch() {}, searchLabel: 'Search chats' }));
    const settings = renderToStaticMarkup(createElement(SidebarHeader, { onSearch() {}, searchLabel: 'Search settings' }));
    expect(chat.replaceAll('Search chats', 'Search settings')).toBe(settings);
    expect(settings).toContain('class="sidebar-heading"');
    expect(settings).toContain('class="sidebar-brand"');
    expect(settings).toContain('class="brand-symbol"');
    expect(settings).toContain('aria-label="OpenButler"');
    expect(settings).toContain('icon-button');
  });

  it('only offers the mobile close control to chat', () => {
    const chat = renderToStaticMarkup(
      createElement(SidebarHeader, {
        onSearch() {},
        searchLabel: 'Search chats',
        onClose() {},
      }),
    );
    const settings = renderToStaticMarkup(createElement(SidebarHeader, { onSearch() {}, searchLabel: 'Search settings' }));
    expect(chat).toContain('Close sidebar');
    expect(settings).not.toContain('Close sidebar');
  });

  it('renders the same footer structure for chat and Settings', () => {
    const chat = renderToStaticMarkup(createElement(SidebarFooter, { icon: 'settings', label: 'Settings', onClick() {} }));
    const settings = renderToStaticMarkup(createElement(SidebarFooter, { icon: 'arrow-left', label: 'Back to chat', onClick() {} }));
    for (const html of [chat, settings]) {
      expect(html).toContain('class="sidebar-footer"');
      expect(html).toContain('sidebar-settings');
      expect(html).toContain('type="button"');
    }
    expect(settings).toContain('Back to chat');
  });
});
