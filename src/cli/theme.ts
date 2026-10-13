export type UiTheme = 'Dark' | 'Light' | 'System';
export type ResolvedTheme = 'dark' | 'light';

/**
 * The TUI's single source of visual identity. Components must never hardcode
 * colors, glyphs or spacing: everything comes from here so the whole screen can
 * be restyled in one place.
 */
export interface UiTokens {
  /** The single interactive accent: prompt, selection, running activity. */
  accent: string;
  /** Text on top of the accent selection bar. */
  onAccent: string;
  /** Flat opaque surface for floating panels. */
  surface: string;
  /** Semantic state colors; used only where meaning requires them. */
  warning: string;
  error: string;
  diffAdd: string;
  diffDel: string;
}

const ACCENTS: Record<ResolvedTheme, string> = {
  dark: '#7AA2F7',
  light: '#3B6FE0',
};

const ON_ACCENT: Record<ResolvedTheme, string> = {
  dark: '#000000',
  light: '#FFFFFF',
};

const SURFACES: Record<ResolvedTheme, string> = {
  dark: '#1E1E1E',
  light: '#E9E9E9',
};

/** Maps the stored choice to a concrete appearance; System follows the detected terminal background. */
export function resolveTheme(theme: UiTheme, system: ResolvedTheme = 'dark'): ResolvedTheme {
  if (theme === 'System') return system;
  return theme === 'Light' ? 'light' : 'dark';
}

export function uiTokens(theme: UiTheme, system: ResolvedTheme = 'dark'): UiTokens {
  const mode = resolveTheme(theme, system);
  return {
    accent: ACCENTS[mode],
    onAccent: ON_ACCENT[mode],
    surface: SURFACES[mode],
    warning: 'yellow',
    error: 'red',
    diffAdd: 'green',
    diffDel: 'red',
  };
}

/**
 * Font-safe markers: no Nerd Font, no emoji. Everything here renders in default
 * Windows Terminal, macOS and Linux terminal fonts.
 */
export const glyphs = {
  prompt: '›',
  bullet: '●',
  result: '└',
  dot: '·',
  rule: '─',
  warn: '!',
  error: '✗',
  spinner: ['✻', '✽', '✼', '✶'],
} as const;

/** Spacing scale: screen padding, block gap, continuation indent. */
export const layout = {
  padX: 2,
  padY: 1,
  gap: 1,
  indent: 2,
} as const;
