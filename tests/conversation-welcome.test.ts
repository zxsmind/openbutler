import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('empty conversation layout', () => {
  it('renders the welcome in the conversation body, independent of the composer', () => {
    const app = readFileSync('web/src/app.tsx', 'utf8');
    const composer = readFileSync('web/src/components/composer.tsx', 'utf8');
    const welcomeCss = readFileSync('web/src/components/conversation-welcome.css', 'utf8');
    const appCss = readFileSync('web/src/styles.css', 'utf8');

    expect(app).toContain('turns.length === 0 && connected ? <ConversationWelcome');
    expect(app.indexOf('<ConversationWelcome')).toBeLessThan(app.indexOf('<div className="action-dock">'));
    expect(composer).not.toContain('className="welcome"');
    expect(composer).not.toContain('props.empty');
    expect(composer).not.toContain('projectName');
    expect(welcomeCss).toMatch(/\.conversation-welcome\s*\{[^}]*flex: 1 1 auto;/s);
    expect(welcomeCss).toContain('justify-content: center;');
    expect(appCss).not.toContain('.welcome {');
    expect(welcomeCss).not.toContain('margin-bottom:');
  });
});
