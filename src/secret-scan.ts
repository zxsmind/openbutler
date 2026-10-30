import { rules as presetRules } from '@secretlint/secretlint-rule-preset-recommend';
import type { SecretLintRuleContext, SecretLintRuleCreator, SecretLintSourceCode } from '@secretlint/types';

/**
 * One text-level secret scrubber for the whole product: every surface that would otherwise carry
 * credentials into the model, the transcript, notifications, or a tool result runs through here.
 *
 * Detection is not invented locally. The rule set is the MIT-licensed
 * `@secretlint/secretlint-rule-preset-recommend` (provider-specific formats: AWS, GitHub, GitLab,
 * npm, OpenAI, Anthropic, private keys, connection strings, and more), driven by a small
 * synchronous runner instead of secretlint's own async core so that every call site - including
 * the synchronous system-prompt assembly and transcript display - uses the exact same engine.
 *
 * Deliberate additions on top of the preset:
 * - The AWS rule's ID scan is enabled, but its AWSAccountID message is dropped: `AKIA…` access
 *   key IDs are worth masking, while bare 12-digit account numbers are not.
 * - The previous conservative local patterns (Bearer tokens and `key: value` assignments for
 *   api key/token/secret/password/authorization) stay as an extra net, because the preset has no
 *   generic assignment rule by design.
 *
 * Async-only checks are skipped: the preset's PKCS#12 verification returns a promise for `.p12`
 * input, and scanned content is always treated as text (`openbutler-input.json`), so PEM-format keys,
 * including GCP service-account JSON, are covered while binary PKCS#12 blobs are not.
 */

const REDACTED = '[redacted]';
const SCAN_PATH = 'openbutler-input.json';

/** Options applied per rule id; everything else keeps the preset defaults. */
const RULE_OPTIONS: Record<string, Record<string, unknown>> = {
  '@secretlint/secretlint-rule-aws': { enableIDScanRule: true },
};

/** Detected but not worth masking; bare AWS account numbers are the canonical example. */
const IGNORED_MESSAGE_IDS = new Set(['AWSAccountID']);

const scannerRules = (presetRules as SecretLintRuleCreator[]).filter((rule) => rule.meta.type === 'scanner');

/**
 * The conservative generic net: Bearer tokens, and `key: value` assignments for
 * api key/token/secret/password/authorization. The preset has no generic assignment rule by
 * design, so this stays as a labelled-value matcher with one guard: values that read like code
 * references (`process.env.…`, `${VAR}`, `localStorage.getItem(…)`) are not credentials.
 */
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const ASSIGNMENT_PATTERN = /((?:api[-_ ]?key|token|secret|password|authorization)\s*[:=]\s*)(?!Bearer\b)([^\s,;]+)/gi;

export interface SecretMatch {
  start: number;
  end: number;
  ruleId: string;
  messageId: string;
}

/**
 * Finds every secret span in one text, sorted by position with overlapping spans merged into the
 * widest one, so masking never leaves a fragment of a longer detected value behind.
 */
export function scanSecrets(text: string): SecretMatch[] {
  if (!text) return [];
  const matches: SecretMatch[] = [];
  const source = createSource(text);
  for (const rule of scannerRules) {
    const reports: Array<{ range: readonly [number, number]; messageId: string }> = [];
    const context = createRuleContext((report) => {
      if (IGNORED_MESSAGE_IDS.has(report.messageId)) return;
      reports.push({ range: repairReportSpan(text, report.range, report.data), messageId: report.messageId });
    });
    let handler: ReturnType<SecretLintRuleCreator['create']>;
    try {
      handler = rule.create(context, RULE_OPTIONS[rule.meta.id] ?? {});
    } catch {
      // A rule that cannot be constructed must not disable every other rule.
      continue;
    }
    let returned: unknown;
    try {
      returned = handler.file?.(source);
    } catch {
      continue;
    }
    if (returned && typeof (returned as PromiseLike<void>).then === 'function') {
      // Async-only check (the .p12 verifier); its synchronous reports are kept above.
      void Promise.resolve(returned as PromiseLike<void>).catch(() => {});
    }
    for (const report of reports) {
      const [start, end] = report.range;
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length) {
        matches.push({ start, end, ruleId: rule.meta.id, messageId: report.messageId });
      }
    }
  }
  matches.push(...findLocalMatches(text));
  return mergeMatches(matches, text.length);
}

function findLocalMatches(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const match of text.matchAll(BEARER_PATTERN)) {
    const label = match[1] ?? '';
    const start = (match.index ?? 0) + label.length;
    const end = (match.index ?? 0) + match[0].length;
    if (end > start) matches.push({ start, end, ruleId: 'openbutler', messageId: 'LocalBearer' });
  }
  for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
    const label = match[1] ?? '';
    const token = match[2] ?? '';
    if (token.length === 0 || isCodeReference(token)) continue;
    const start = (match.index ?? 0) + label.length;
    matches.push({ start, end: start + token.length, ruleId: 'openbutler', messageId: 'LocalAssignment' });
  }
  return matches;
}

function isCodeReference(token: string): boolean {
  const inner = token.replace(/^["']+/, '').replace(/["']+$/, '');
  if (/^(?:\$|%|\{\{|<)/.test(inner)) return true;
  if (/^(?:process\.env|import\.meta|os\.environ|system\.getenv)\b/i.test(inner)) return true;
  return /[()<>${}]/.test(inner);
}

/**
 * A few preset rules report the start of the whole match but the length of their capture group
 * (AWS secret access keys and npmrc `_authToken` values), which would leave a fragment of the
 * value behind. The report carries the matched value as translated-message data, so when the
 * reported span does not actually contain that value, the span is recomputed from the value
 * itself. Correct ranges are never touched.
 */
function repairReportSpan(text: string, range: readonly [number, number], data: unknown): readonly [number, number] {
  const value = longestStringValue(data);
  if (value === null || value.length < 8) return range;
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) return range;
  if (text.slice(start, end).includes(value)) return range;
  let index = text.indexOf(value);
  if (index < 0) return range;
  let best = index;
  let bestDistance = Math.abs(index - start);
  let searches = 0;
  while (searches < 50) {
    index = text.indexOf(value, index + 1);
    if (index < 0) break;
    const distance = Math.abs(index - start);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    searches++;
  }
  return [best, best + value.length];
}

function longestStringValue(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  let longest: string | null = null;
  for (const nested of Object.values(data)) {
    if (typeof nested !== 'string') continue;
    if (longest === null || nested.length > longest.length) longest = nested;
  }
  return longest;
}

/** Replaces every detected secret span with `[redacted]`; idempotent by construction. */
export function redactSecrets(text: string): string {
  const matches = scanSecrets(text);
  if (matches.length === 0) return text;
  let output = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    output += text.slice(cursor, match.start) + REDACTED;
    cursor = match.end;
  }
  return output + text.slice(cursor);
}

function mergeMatches(matches: SecretMatch[], textLength: number): SecretMatch[] {
  if (matches.length < 2) return matches;
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: SecretMatch[] = [];
  for (const match of matches) {
    const previous = merged[merged.length - 1];
    if (previous && match.start < previous.end) {
      if (match.end > previous.end) previous.end = Math.min(match.end, textLength);
      continue;
    }
    merged.push({ ...match });
  }
  return merged;
}

type RuleReport = { range: readonly [number, number]; messageId: string; data: unknown };

function createRuleContext(onReport: (report: RuleReport) => void): SecretLintRuleContext {
  return {
    sharedOptions: {},
    createTranslator: ((messages: Record<string, Record<string, (props?: Record<string, unknown>) => string>>) => {
      return (messageId: string, props?: Record<string, unknown>) => {
        const locales = messages[messageId] ?? {};
        const handler = locales.en ?? Object.values(locales)[0];
        return { message: handler ? handler(props) : '', messageId, data: props };
      };
    }) as SecretLintRuleContext['createTranslator'],
    report: (descriptor) => {
      onReport({
        range: descriptor.range,
        messageId: String(descriptor.message.messageId),
        data: descriptor.message.data,
      });
    },
    ignore: () => {},
  };
}

function createSource(content: string): SecretLintSourceCode {
  const lineStarts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') lineStarts.push(index + 1);
  }
  const indexToPosition = (index: number): { line: number; column: number } => {
    let line = lineStarts.length;
    for (let position = 0; position < lineStarts.length; position++) {
      if (lineStarts[position]! > index) {
        line = position;
        break;
      }
    }
    return { line, column: index - (lineStarts[line - 1] ?? 0) };
  };
  const positionToIndex = (position: { line: number; column: number }): number => {
    const start = lineStarts[Math.max(0, Math.min(position.line - 1, lineStarts.length - 1))] ?? 0;
    return Math.max(0, Math.min(start + position.column, content.length));
  };
  return {
    hasBOM: false,
    content,
    filePath: SCAN_PATH,
    physicalFilePath: undefined,
    contentType: 'text',
    ext: '.json',
    getFilePath: () => SCAN_PATH,
    getPhysicalFilePath: () => undefined,
    indexToPosition,
    positionToIndex,
    rangeToLocation: (range) => ({ start: indexToPosition(range[0]), end: indexToPosition(range[1]) }),
    locationToRange: (location) => [positionToIndex(location.start), positionToIndex(location.end)],
  };
}
