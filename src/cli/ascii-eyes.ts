/**
 * Animated ASCII eyes for the welcome screen.
 *
 * A tiny self-contained renderer: two almond eyes with gaze, blinks, and slow
 * emotional expressions. The output is pure ASCII art — no emoji, no words, no
 * language — so it renders in any terminal font and theme.
 */

interface EyeShape {
  l: number;
  r: number;
  smile: number;
}

interface Emotion {
  id: string;
  weight: number;
  l: number;
  r: number;
  smile: number;
  factor?: number;
  short?: number;
  center?: boolean;
  side?: boolean;
  cross?: boolean;
}

const EMOTIONS: readonly Emotion[] = [
  { id: 'neutral', weight: 26, l: 1, r: 1, smile: 0, factor: 1.1 },
  { id: 'smile', weight: 19, l: 0.48, r: 0.48, smile: 1, factor: 1.15 },
  { id: 'direct', weight: 15, l: 0.62, r: 0.62, smile: 0.22, center: true, factor: 1 },
  { id: 'sleepy', weight: 10, l: 0.39, r: 0.39, smile: 0, factor: 1.1 },
  { id: 'side', weight: 10, l: 0.75, r: 0.75, smile: 0.03, side: true, factor: 0.85 },
  { id: 'surprise', weight: 8, l: 1.22, r: 1.22, smile: 0, center: true, factor: 0.8 },
  { id: 'skeptic', weight: 9, l: 0.48, r: 0.85, smile: 0, factor: 1 },
  { id: 'wink', weight: 7, l: 0.035, r: 0.9, smile: 0.45, center: true, short: 1.05 },
  { id: 'closed', weight: 7, l: 0.025, r: 0.025, smile: 0.12, short: 1.7 },
  { id: 'cross', weight: 1, l: 0.97, r: 0.97, smile: 0, cross: true, short: 1.4 },
];

/** Gaze targets as (x, y) in [-1, 1]; the eyes pick a new one after each hold. */
const GAZE_TARGETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, -0.85],
  [-1, -0.85],
  [1, 0.85],
  [-1, 0.85],
];

/** Only these glyphs may appear in a frame; everything here is plain ASCII. */
const FRAME_GLYPHS = new Set([' ', 'o', 'O', '@', '*', '=', '~', '/', '\\', '_', '|', '-', '<', '>']);

export interface EyesState {
  gazeX: number;
  gazeY: number;
  gazeFromX: number;
  gazeFromY: number;
  gazeToX: number;
  gazeToY: number;
  gazeIndex: number;
  gazeElapsed: number;
  gazeMove: number;
  gazeHold: number;
  emotion: Emotion;
  emotionElapsed: number;
  emotionDuration: number;
  fromShape: EyeShape;
  transitionDuration: number;
  sideDirection: number;
  holdSeconds: number;
  clock: number;
  blinkAt: number;
  blinkStart: number;
  random: () => number;
}

export function createEyesState(random: () => number = Math.random): EyesState {
  const state: EyesState = {
    gazeX: 0,
    gazeY: 0,
    gazeFromX: 0,
    gazeFromY: 0,
    gazeToX: 0,
    gazeToY: 0,
    gazeIndex: 0,
    gazeElapsed: 0,
    gazeMove: 0.15,
    gazeHold: 1,
    emotion: EMOTIONS[0]!,
    emotionElapsed: 0,
    emotionDuration: 7,
    fromShape: { l: 1, r: 1, smile: 0 },
    transitionDuration: 0.65,
    sideDirection: 1,
    holdSeconds: 7,
    clock: 0,
    blinkAt: 2.5 + random() * 2.3,
    blinkStart: -1,
    random,
  };
  chooseGaze(state);
  return state;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function ease(t: number): number {
  const clamped = clamp(t, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function pickWeighted(state: EyesState): Emotion {
  const total = EMOTIONS.reduce((sum, emotion) => sum + emotion.weight, 0);
  let roll = state.random() * total;
  for (const emotion of EMOTIONS) {
    roll -= emotion.weight;
    if (roll <= 0) return emotion;
  }
  return EMOTIONS[0]!;
}

function currentShape(state: EyesState): EyeShape {
  const t = ease(state.emotionElapsed / state.transitionDuration);
  return {
    l: mix(state.fromShape.l, state.emotion.l, t),
    r: mix(state.fromShape.r, state.emotion.r, t),
    smile: mix(state.fromShape.smile, state.emotion.smile, t),
  };
}

function selectEmotion(state: EyesState, next: Emotion): void {
  state.fromShape = currentShape(state);
  state.emotion = { ...next };
  if (next.id === 'wink' && state.random() < 0.5) {
    state.emotion.l = 0.9;
    state.emotion.r = 0.035;
  }
  if (next.side) state.sideDirection = state.random() < 0.5 ? -1 : 1;
  state.emotionElapsed = 0;
  state.transitionDuration = next.short ? 0.26 : 0.65 + state.random() * 0.3;
  state.emotionDuration = next.short ?? (0.85 + state.random() * 0.45) * state.holdSeconds * (next.factor ?? 1);
}

function nextEmotion(state: EyesState): void {
  if (state.emotion.short) {
    selectEmotion(state, EMOTIONS[0]!);
    return;
  }
  let next = pickWeighted(state);
  let attempts = 0;
  while (next.id === state.emotion.id && attempts++ < 8) next = pickWeighted(state);
  selectEmotion(state, next);
}

function chooseGaze(state: EyesState): void {
  let next = state.gazeIndex;
  while (next === state.gazeIndex) next = Math.floor(state.random() * GAZE_TARGETS.length);
  state.gazeIndex = next;
  state.gazeFromX = state.gazeX;
  state.gazeFromY = state.gazeY;
  const target = GAZE_TARGETS[next]!;
  state.gazeToX = target[0];
  state.gazeToY = target[1];
  state.gazeElapsed = 0;
  state.gazeMove = 0.11 + state.random() * 0.13;
  state.gazeHold = 0.55 + state.random() * 1.85;
}

function blinkScale(state: EyesState): number {
  if (state.blinkStart < 0) return 1;
  return clamp(1 - 0.97 * Math.sin((Math.PI * (state.clock - state.blinkStart)) / 0.22), 0.03, 1);
}

/** Moves gaze, expressions, and blinks forward by dtSeconds. */
export function advanceEyes(state: EyesState, dtSeconds: number): void {
  const dt = Math.max(0, dtSeconds);
  state.clock += dt;
  state.gazeElapsed += dt;
  if (state.gazeElapsed < state.gazeMove) {
    const t = ease(state.gazeElapsed / state.gazeMove);
    state.gazeX = mix(state.gazeFromX, state.gazeToX, t);
    state.gazeY = mix(state.gazeFromY, state.gazeToY, t);
  } else {
    state.gazeX = state.gazeToX;
    state.gazeY = state.gazeToY;
    if (state.gazeElapsed >= state.gazeMove + state.gazeHold) chooseGaze(state);
  }
  state.emotionElapsed += dt;
  if (state.emotionElapsed >= state.emotionDuration) nextEmotion(state);
  if (state.blinkStart < 0 && state.clock >= state.blinkAt && state.emotion.id !== 'closed') state.blinkStart = state.clock;
  if (state.blinkStart >= 0 && state.clock - state.blinkStart >= 0.22) {
    state.blinkStart = -1;
    state.blinkAt = state.clock + 2.6 + state.random() * 3.2;
  }
}

function put(grid: string[], gridW: number, gridH: number, x: number, y: number, ch: string): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix >= 0 && ix < gridW && iy >= 0 && iy < gridH) grid[iy * gridW + ix] = ch;
}

function segment(grid: string[], gridW: number, gridH: number, x1: number, y1: number, x2: number, y2: number, ch: string): void {
  const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 4));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    put(grid, gridW, gridH, mix(x1, x2, t), mix(y1, y2, t), ch);
  }
}

function drawEye(
  grid: string[],
  gridW: number,
  gridH: number,
  k: number,
  cx: number,
  opening: number,
  smile: number,
  gx: number,
  gy: number,
): void {
  const cy = 12.2 * k;
  const r = 15.8 * k;
  const arc = (u: number): number => Math.pow(Math.max(0, 1 - u * u), 0.72);
  const top = (x: number): number => {
    const u = clamp((x - cx) / r, -1, 1);
    return cy - 4.55 * k * opening * arc(u) - 0.34 * k * smile * arc(u) + u * 0.25 * k;
  };
  const bottom = (x: number): number => {
    const u = clamp((x - cx) / r, -1, 1);
    return cy + 3.25 * k * opening * arc(u) - 0.53 * k * smile * arc(u) + u * 0.25 * k;
  };
  const ix = cx + gx * 4.45 * k;
  const iy = cy + gy * 1.7 * k;
  if (opening > 0.18) {
    for (let y = Math.floor(iy - 3.8 * k); y <= iy + 3.8 * k; y++) {
      for (let x = Math.floor(ix - 4.1 * k); x <= ix + 4.1 * k; x++) {
        const dx = (x - ix) / (3.7 * k);
        const dy = (y - iy) / (3.35 * k);
        const d = dx * dx + dy * dy;
        if (d > 1 || y < top(x) + 0.7 * k || y > bottom(x) - 0.6 * k) continue;
        let ch = d > 0.7 ? 'o' : d > 0.4 ? 'O' : '@';
        if (Math.abs(x - ix) < 1.45 * k && Math.abs(y - iy) < 1.6 * k) ch = '@';
        if (Math.abs(x - (ix - 1.1 * k)) < 0.6 * k && Math.abs(y - (iy - 1 * k)) < 0.7 * k) ch = '*';
        put(grid, gridW, gridH, x, y, ch);
      }
    }
  }
  for (let d = -r; d <= r; d += 0.2 * k) {
    const x = cx + d;
    const u = d / r;
    const upper = Math.abs(u) < 0.45 ? (smile > 0.6 ? '~' : '=') : u < 0 ? '/' : '\\';
    const lower = Math.abs(u) < 0.55 ? '_' : u < 0 ? '\\' : '/';
    put(grid, gridW, gridH, x, top(x), upper);
    put(grid, gridW, gridH, x, bottom(x), lower);
  }
  const lashes = [-0.92, -0.8, -0.67, -0.53, -0.36, -0.15, 0.08, 0.28, 0.5, 0.7, 0.85];
  for (const u of lashes) {
    const x = cx + u * r;
    const y = top(x);
    const dir = u < -0.1 ? -1 : u > 0.1 ? 1 : 0;
    const len = (1.2 + 1.5 * Math.abs(u)) * k * Math.max(0.25, opening);
    segment(grid, gridW, gridH, x, y - 0.2 * k, x + dir * (0.9 + Math.abs(u)) * k, y - len, dir < 0 ? '\\' : dir > 0 ? '/' : '|');
  }
  if (opening < 0.13) {
    for (let x = cx - r * 0.84; x <= cx + r * 0.84; x++) put(grid, gridW, gridH, x, cy, smile > 0.4 ? '~' : '-');
  }
  put(grid, gridW, gridH, cx - r, cy, '<');
  put(grid, gridW, gridH, cx + r, cy, '>');
}

/**
 * Renders one frame centered in `width` columns. Returns an empty array when
 * the terminal is too narrow for the eyes. Every line is exactly `width`
 * characters of plain ASCII.
 */
export function renderEyesFrame(state: EyesState, width: number): string[] {
  if (!Number.isFinite(width) || width < 40) return [];
  const gridW = Math.max(40, Math.min(88, Math.floor(width)));
  const k = gridW / 92;
  const gridH = Math.max(10, Math.round(24 * k));
  const grid = new Array<string>(gridW * gridH).fill(' ');
  const shape = currentShape(state);
  const blink = blinkScale(state);
  let gx = state.gazeX;
  let gy = state.gazeY;
  let leftExtra = 0;
  let rightExtra = 0;
  if (state.emotion.center) {
    gx = 0;
    gy = 0;
  }
  if (state.emotion.side) {
    gx = state.sideDirection;
    gy = 0;
  }
  if (state.emotion.cross) {
    gx = 0;
    gy = 0.1;
    leftExtra = 0.93;
    rightExtra = -0.93;
  }
  drawEye(grid, gridW, gridH, k, 24 * k, clamp(shape.l * blink, 0.015, 1.25), shape.smile, gx + leftExtra, gy);
  drawEye(grid, gridW, gridH, k, 68 * k, clamp(shape.r * blink, 0.015, 1.25), shape.smile, gx + rightExtra, gy);
  const lines: string[] = [];
  for (let y = 0; y < gridH; y++) lines.push(grid.slice(y * gridW, (y + 1) * gridW).join(''));
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  const pad = Math.max(0, Math.floor((width - gridW) / 2));
  const padding = ' '.repeat(pad);
  return lines.map((line) => (padding + line).padEnd(width, ' ').slice(0, width));
}

/** True when every character of every line is an allowed plain-ASCII glyph. */
export function isPlainAsciiFrame(lines: readonly string[]): boolean {
  for (const line of lines) for (const ch of line) if (!FRAME_GLYPHS.has(ch)) return false;
  return true;
}
