/**
 * Best-effort reader for tool-call arguments a provider streams in pieces.
 *
 * The AI SDK delivers each provider's partial tool input as raw JSON text through
 * `onInputDelta`. This scanner keeps only complete top-level fields, so a display
 * can show a command or path as soon as its value is actually readable, without
 * waiting for the whole call and without guessing at an incomplete string.
 *
 * It is intentionally tolerant: a value that is an object or array stops further
 * collection, because the preview exists for the first few flat fields a tool
 * schema declares (path, command, action), not for deep payloads.
 */
export interface ToolPreviewField {
  key: string;
  value: string;
  truncated: boolean;
}

const MAX_FIELD_CHARS = 200;
const MAX_FIELDS = 12;

type ScanState = 'start' | 'key' | 'key-string' | 'colon' | 'value' | 'string-value' | 'primitive' | 'after' | 'done';

export class ToolInputPreview {
  private readonly collected: ToolPreviewField[] = [];
  private state: ScanState = 'start';
  private key = '';
  private value = '';
  private escape = false;
  private truncated = false;

  get fields(): readonly ToolPreviewField[] {
    return this.collected;
  }

  push(delta: string): void {
    for (const character of delta) {
      this.consume(character);
      const state: ScanState = this.state;
      if (state === 'done') return;
    }
  }

  private consume(character: string): void {
    switch (this.state) {
      case 'start':
        if (character === '{') this.state = 'key';
        else if (!isWhitespace(character)) this.state = 'done';
        return;
      case 'key':
        if (isWhitespace(character) || character === ',') return;
        if (character === '}') {
          this.state = 'done';
          return;
        }
        if (character === '"') {
          this.state = 'key-string';
          this.key = '';
          this.escape = false;
          return;
        }
        this.state = 'done';
        return;
      case 'key-string':
        if (this.escape) {
          this.key += character;
          this.escape = false;
          return;
        }
        if (character === '\\') {
          this.key += character;
          this.escape = true;
          return;
        }
        if (character === '"') {
          this.state = 'colon';
          return;
        }
        this.key += character;
        return;
      case 'colon':
        if (isWhitespace(character)) return;
        if (character === ':') {
          this.state = 'value';
          return;
        }
        this.state = 'done';
        return;
      case 'value':
        if (isWhitespace(character)) return;
        if (character === '"') {
          this.state = 'string-value';
          this.value = '';
          this.escape = false;
          this.truncated = false;
          return;
        }
        if (character === '{' || character === '[' || character === '}' || character === ',') {
          this.state = 'done';
          return;
        }
        this.state = 'primitive';
        this.value = '';
        this.truncated = false;
        this.append(character);
        return;
      case 'string-value':
        if (this.escape) {
          this.append(character);
          this.escape = false;
          return;
        }
        if (character === '\\') {
          this.append(character);
          this.escape = true;
          return;
        }
        if (character === '"') {
          this.state = this.completeField() ? 'done' : 'after';
          return;
        }
        this.append(character);
        return;
      case 'primitive':
        if (character === ',') {
          this.state = this.completeField() ? 'done' : 'key';
          return;
        }
        if (character === '}') {
          this.completeField();
          this.state = 'done';
          return;
        }
        this.append(character);
        return;
      case 'after':
        if (isWhitespace(character)) return;
        if (character === ',') {
          this.state = 'key';
          return;
        }
        this.state = 'done';
        return;
      case 'done':
        return;
    }
  }

  private append(character: string): void {
    if (this.value.length >= MAX_FIELD_CHARS) {
      this.truncated = true;
      return;
    }
    this.value += character;
  }

  private completeField(): boolean {
    const key = this.key.trim();
    const value = collapseWhitespace(decodeJsonString(this.value));
    if (key && value) this.collected.push({ key, value, truncated: this.truncated });
    return this.collected.length >= MAX_FIELDS;
  }
}

function decodeJsonString(raw: string): string {
  try {
    const decoded: unknown = JSON.parse(`"${raw}"`);
    return typeof decoded === 'string' ? decoded : raw;
  } catch {
    return raw;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\n' || character === '\t' || character === '\r';
}
