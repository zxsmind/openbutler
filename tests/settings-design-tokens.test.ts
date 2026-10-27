import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(process.cwd(), 'web', 'src');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function settingsCssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? settingsCssFiles(path) : entry.name.endsWith('.css') ? [path] : [];
  });
}

describe('shared sidebar design system', () => {
  it('uses the same width token for chat and Settings', () => {
    const globalCss = read('styles.css');
    const settingsCss = read('components/settings/settings-page.css');
    expect(globalCss).toMatch(/--ui-sidebar-width:\s*252px;/);
    expect(globalCss).toMatch(/--sidebar-width:\s*var\(--ui-sidebar-width\)/);
    expect(globalCss).toMatch(/\.sidebar\s*\{[^}]*width:\s*var\(--ui-sidebar-width\)/s);
    expect(settingsCss).toContain('grid-template-columns: var(--ui-sidebar-width)');
    expect(read('app.tsx')).not.toContain('AppRail');
  });

  it('keeps the visual primitives in one imported stylesheet', () => {
    const chrome = read('components/sidebar-chrome.tsx');
    const shared = read('components/sidebar.css');
    const globalCss = read('styles.css');
    const settingsCss = read('components/settings/settings-page.css');
    const chat = read('components/sidebar.tsx');
    const settings = read('components/settings/settings-page.tsx');

    expect(chrome).toContain("import './sidebar.css'");
    expect(chat).toContain("from './sidebar-chrome.js'");
    expect(settings).toContain("from '../sidebar-chrome.js'");
    expect(chat).toContain('className="sidebar sidebar-shell"');
    expect(settings).toContain('className="settings-nav sidebar-shell"');

    const selectors = [
      'sidebar-shell',
      'sidebar-heading',
      'sidebar-brand',
      'sidebar-footer',
      'sidebar-scroll',
      'section-label',
      'recent-label',
      'session-list',
      'session-item',
      'session-name',
    ];
    for (const className of selectors) {
      const rule = new RegExp(`^\\.${className}\\s*\\{`, 'm');
      expect(shared, className).toMatch(rule);
      expect(globalCss, className).not.toMatch(rule);
      expect(settingsCss, className).not.toMatch(rule);
    }
    expect(shared).toMatch(/\.sidebar-footer \.sidebar-settings\s*\{[^}]*justify-content:\s*flex-start;/s);
    expect(shared).toContain('.session-item > .icon {');
    expect(settingsCss).not.toContain('.settings-nav .session-item .icon');
  });

  it('reuses sidebar structure and limits Settings CSS to its own layout', () => {
    const chat = read('components/sidebar.tsx');
    const settings = read('components/settings/settings-page.tsx');
    const settingsCss = read('components/settings/settings-page.css');
    for (const cls of ['sidebar-scroll', 'section-label', 'session-list', 'session-item', 'session-name']) {
      expect(chat).toContain(cls);
      expect(settings).toContain(cls);
    }
    expect(chat).toContain('<SidebarHeader');
    expect(settings).toContain('<SidebarHeader');
    expect(chat).toContain('<SidebarFooter');
    expect(settings).toContain('<SidebarFooter');
    expect(settingsCss).toContain('padding: 63px 20px 90px;');
  });

  it('uses shared design tokens for Settings typography', () => {
    const globalCss = read('styles.css');
    for (const token of [
      'ui-caption-size',
      'ui-small-size',
      'ui-control-size',
      'ui-body-size',
      'ui-heading-size',
      'ui-control-height',
      'ui-control-radius',
      'ui-sidebar-width',
      'ui-surface',
      'ui-control-border',
    ]) {
      expect(globalCss).toMatch(new RegExp(`^\\s*--${token}:\\s*.+;`, 'm'));
    }
    const dir = join(root, 'components', 'settings');
    for (const file of settingsCssFiles(dir)) {
      const css = readFileSync(file, 'utf8');
      expect(css, file).not.toMatch(/^\s*--settings-[\w-]+\s*:/m);
      expect(css, file).not.toMatch(/font-size:\s*[\d.]+(?:px|rem);/);
    }
  });
});
