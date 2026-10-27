import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = join(process.cwd(), 'web', 'src');
const settingsRoot = join(webRoot, 'components', 'settings');
const appStyles = readFileSync(join(webRoot, 'styles.css'), 'utf8');

function stylesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(dir, entry.name);
    return entry.isDirectory() ? stylesUnder(filename) : entry.name.endsWith('.css') ? [filename] : [];
  });
}

describe('Settings design isolation', () => {
  it('uses global tokens without modifying conversation sidebar selectors', () => {
    for (const token of [
      'font-body',
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
      'text',
      'muted',
      'line',
      'blue',
    ]) {
      expect(appStyles, token).toMatch(new RegExp(`^\\s*--${token}:\\s*.+;`, 'm'));
    }
    expect(appStyles).toContain('.sidebar {');
    expect(appStyles).not.toContain('.sidebar-panel {');
    expect(appStyles).not.toContain('.sidebar-quick-search {');
  });

  it('owns navigation styles and controls without changing chat components', () => {
    const view = readFileSync(join(settingsRoot, 'settings-page.tsx'), 'utf8');
    const css = readFileSync(join(settingsRoot, 'settings-page.css'), 'utf8');
    const chrome = readFileSync(join(settingsRoot, 'settings-chrome.tsx'), 'utf8');
    const app = readFileSync(join(webRoot, 'app.tsx'), 'utf8');
    for (const className of [
      'settings-nav__scroll',
      'settings-nav__group-title',
      'settings-nav__item',
      'settings-nav__footer',
      'settings-nav__return',
    ]) {
      expect(css, className).toContain(`.${className}`);
    }
    expect(view).toContain('<SettingsHeader');
    expect(view).toContain('<SettingsFooter');
    expect(chrome).toContain('Back to chat');
    expect(view).not.toMatch(/\b(?:SidebarHeader|SidebarPrimaryAction|SidebarSettingsFooter)\b/);
    expect(css).not.toMatch(/^\.(?:sidebar|session-item|section-label|sidebar-panel)\b/m);
    expect(css).toContain('padding: 63px 20px 90px;');
    expect(app).not.toContain('AppRail');
    expect(app).not.toContain('DesktopChrome');
  });

  it('keeps Settings typography derived from tokens instead of per-page values', () => {
    for (const filename of stylesUnder(settingsRoot)) {
      const css = readFileSync(filename, 'utf8');
      expect(css, filename).not.toMatch(/^\s*--settings-[\w-]+\s*:/m);
      expect(css, filename).not.toMatch(/font-size:\s*[\d.]+(?:px|rem);/);
    }
  });
});
