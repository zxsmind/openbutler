import { describe, expect, it } from 'vitest';
import { terminalThemeFromColorFgBg, terminalThemeFromRgbResponse } from '../../src/cli/terminal-detect.js';
import { resolveTheme, uiTokens } from '../../src/cli/theme.js';

describe('ui theme tokens', () => {
  it('resolves System against the detected terminal background', () => {
    expect(resolveTheme('System', 'light')).toBe('light');
    expect(resolveTheme('System', 'dark')).toBe('dark');
    expect(resolveTheme('Light', 'dark')).toBe('light');
    expect(resolveTheme('Dark', 'light')).toBe('dark');
  });

  it('switches the accent between dark and light backgrounds', () => {
    expect(uiTokens('Dark').accent).not.toBe(uiTokens('Light').accent);
    expect(uiTokens('System', 'light').accent).toBe(uiTokens('Light').accent);
    expect(uiTokens('System', 'dark').accent).toBe(uiTokens('Dark').accent);
  });
});

describe('terminal background detection', () => {
  it('reads the background palette index from COLORFGBG', () => {
    expect(terminalThemeFromColorFgBg('15;0')).toBe('dark');
    expect(terminalThemeFromColorFgBg('0;15')).toBe('light');
    expect(terminalThemeFromColorFgBg('')).toBeNull();
    expect(terminalThemeFromColorFgBg('x;y')).toBeNull();
    expect(terminalThemeFromColorFgBg(undefined)).toBeNull();
  });

  it('parses an OSC 11 background response by luminance', () => {
    expect(terminalThemeFromRgbResponse('\u001b]11;rgb:0000/0000/0000\u0007')).toBe('dark');
    expect(terminalThemeFromRgbResponse('\u001b]11;rgb:ffff/ffff/ffff\u0007')).toBe('light');
    expect(terminalThemeFromRgbResponse('no response here')).toBeNull();
  });
});
