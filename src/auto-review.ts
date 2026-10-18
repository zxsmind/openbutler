import { createHash } from 'node:crypto';
import type { LanguageModel, ModelMessage } from 'ai';
import { classifySensitiveEntry, redactSensitive } from './sensitive-data.js';
import type { ToolCallRequest } from './tools/registry.js';
import type { ReasoningVariant } from './provider/registry.js';
import {
  AUTHORITY_BASES,
  CONFIDENCES,
  GRANTING_AUTHORITIES,
  RISKS,
  TRANSCRIPT_AUTHORITIES,
  TRUST_LABELS,
  VERDICTS,
  buildAutoReviewPolicy,
  buildDecisionSchema,
  deriveEffectFlags,
  hasUserContextGap,
  type AutoReviewAuthority,
  type TranscriptCompleteness,
} from './auto-review-policy.js';

export type AutoReviewVerdict = 'allow' | 'deny' | 'escalate';
export type AutoReviewConfidence = 'high' | 'medium' | 'low';
export type AutoReviewRisk = 'low' | 'moderate' | 'high' | 'critical' | 'unknown';

/**
 * Why a review could not produce a decision. The code is machine-readable so
 * the ledger summary can tell a slow provider (timeout) from a weak model
 * (invalid-output) without parsing prose, and so the two are never conflated.
 */
export type AutoReviewUnavailableCode =
  | 'sensitive-input'
  | 'oversized-input'
  | 'unserializable-input'
  | 'no-instruction'
  | 'sensitive-schedule-instruction'
  | 'oversized-trigger-facts'
  | 'oversized-context'
  | 'timeout'
  | 'invalid-output'
  | 'model-error'
  | 'changed-during-review'
  | 'circuit-open';

export interface AutoReviewDecision {
  verdict: AutoReviewVerdict;
  confidence: AutoReviewConfidence;
  risk: AutoReviewRisk;
  reason: string;
  /**
   * Where the reviewer says the permission comes from. Always present on a decision the reviewer
   * produced; optional in the type so callers that construct a decision by hand keep compiling.
   */
  authority?: AutoReviewAuthority;
}

export type AutoReviewResult =
  | { status: 'decision'; decision: AutoReviewDecision }
  | { status: 'unavailable'; reason: string; code: AutoReviewUnavailableCode }
  | { status: 'cancelled' };

export interface AutoReviewOptions {
  model: LanguageModel;
  request: ToolCallRequest;
  messages: readonly ModelMessage[];
  workspaceRoot: string;
  authorizedSchedule?: { kind: 'schedule'; name: string; instruction: string; triggerFacts: unknown };
  providerOptions?: ReasoningVariant['providerOptions'];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Set for a one-time user-approved retry of an exact denied action. */
  userOverride?: boolean;
  /** Why the registry escalated this call instead of deciding deterministically. */
  gateReason?: string;
}

/**
 * This policy runs in a separate model call with no tools. It only decides the
 * exact pending request supplied by the host; it cannot execute or persist an
 * approval. Keep this policy independent from the main agent prompt.
 */
export const AUTO_REVIEW_POLICY = buildAutoReviewPolicy();

const MAX_ACTION_INPUT_CHARS = 24_000;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 2_500;
/** User text may carry the instruction anywhere, so it gets a larger cap and keeps both ends. */
const MAX_USER_MESSAGE_CHARS = 6_000;
/** Budget held back for the assistant and tool context nearest the action. */
const CONTEXT_RESERVE_CHARS = 3_000;
const MIN_PARTIAL_CHARS = 200;
const MEDIA_MARKER = '[media or file content omitted from review context]';
const MAX_MESSAGES = 16;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Stable hash binds an override/denial record to one exact tool and input. */
export function autoReviewFingerprint(request: ToolCallRequest): string {
  const canonical = canonicalJson({
    providerId: request.providerId,
    name: request.name,
    input: request.input,
    effect: request.effect,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function reviewToolRequest(options: AutoReviewOptions): Promise<AutoReviewResult> {
  if (options.signal?.aborted) return { status: 'cancelled' };

  const preparedInput = prepareReviewValue(options.request.input);
  if (preparedInput.redacted) {
    return { status: 'unavailable', code: 'sensitive-input', reason: 'Sensitive or omitted action input requires direct user review.' };
  }
  if (preparedInput.truncated) {
    return { status: 'unavailable', code: 'oversized-input', reason: 'The action input is too large for a complete review.' };
  }
  let serializedInput: string;
  try {
    serializedInput = JSON.stringify(preparedInput.value);
  } catch {
    return { status: 'unavailable', code: 'unserializable-input', reason: 'The tool input could not be safely prepared for review.' };
  }
  if (!serializedInput || serializedInput.length > MAX_ACTION_INPUT_CHARS) {
    return { status: 'unavailable', code: 'oversized-input', reason: 'The tool input is too large for a complete review.' };
  }

  const transcript = prepareTranscript(options.messages, options.authorizedSchedule !== undefined);
  if (!transcript.messages.some((message) => message.role === 'user')) {
    return {
      status: 'unavailable',
      code: 'no-instruction',
      reason: 'No explicit user or schedule instruction is available to compare with this action.',
    };
  }

  let configuredSchedule: { name: string; instruction: string } | undefined;
  let untrustedTriggerFacts: unknown;
  if (options.authorizedSchedule) {
    const scheduleName = String(redactSensitive(options.authorizedSchedule.name));
    const scheduleInstruction = String(redactSensitive(options.authorizedSchedule.instruction));
    if (scheduleInstruction !== options.authorizedSchedule.instruction || scheduleInstruction.length > 16_000) {
      return {
        status: 'unavailable',
        code: 'sensitive-schedule-instruction',
        reason: 'The configured schedule instruction contains sensitive or omitted content.',
      };
    }
    const safeFacts = prepareReviewValue(options.authorizedSchedule.triggerFacts);
    if (safeFacts.truncated)
      return {
        status: 'unavailable',
        code: 'oversized-trigger-facts',
        reason: 'The observed trigger facts are too large for a complete review.',
      };
    configuredSchedule = { name: scheduleName, instruction: scheduleInstruction };
    untrustedTriggerFacts = safeFacts.value;
  }
  const payload = {
    workspaceRoot: options.workspaceRoot,
    ...(options.gateReason ? { gateReason: options.gateReason } : {}),
    ...(options.userOverride ? { userApprovedRetry: true } : {}),
    ...(configuredSchedule ? { configuredSchedule, untrustedTriggerFacts } : {}),
    currentAction: {
      requestId: options.request.requestId,
      providerId: options.request.providerId,
      tool: options.request.name,
      ...(options.request.timeoutSeconds === undefined ? {} : { executionTimeoutSeconds: options.request.timeoutSeconds }),
      input: JSON.parse(serializedInput) as unknown,
      declaredEffects: options.request.effect,
      hostDerivedEffectFlags: deriveEffectFlags(options.request.effect),
    },
    transcriptCompleteness: transcript.completeness,
    recentVisibleConversation: transcript.messages,
  };
  const prompt = JSON.stringify(payload);
  if (prompt.length > MAX_TRANSCRIPT_CHARS + MAX_ACTION_INPUT_CHARS + 8_000) {
    return { status: 'unavailable', code: 'oversized-context', reason: 'The review context is too large to send completely.' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Idle budget, not a wall clock: streaming progress resets the clock, so a
  // slow but working reviewer is never cut off mid-thought. Only a stall
  // trips it. A generous absolute cap backstops a pathological trickle that
  // streams forever without finishing.
  const maxMs = Math.max(120_000, timeoutMs * 6);
  const reviewController = new AbortController();
  const abortSignal = options.signal ? AbortSignal.any([options.signal, reviewController.signal]) : reviewController.signal;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut: 'idle' | 'total' | null = null;
  const disarm = () => {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };
  const rearmIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut ??= 'idle';
      reviewController.abort();
    }, timeoutMs);
  };

  let output: unknown;
  try {
    const { streamText, jsonSchema } = await import('ai');
    rearmIdle();
    totalTimer = setTimeout(() => {
      timedOut ??= 'total';
      reviewController.abort();
    }, maxMs);
    // The verdict travels as a forced tool call, not as JSON text. Some
    // gateways do not enforce responseFormat for every model, which lets the
    // model improvise field names or append stray tokens; a required tool
    // call is constrained by the provider's tool machinery instead.
    const result = streamText({
      model: options.model,
      system: AUTO_REVIEW_POLICY,
      prompt,
      tools: {
        auto_review_decision: {
          description: 'A conservative decision about the one exact pending tool request.',
          inputSchema: jsonSchema<AutoReviewDecision>(buildDecisionSchema()),
        },
      },
      toolChoice: 'required',
      // Retry and key rotation are owned by the rotating model; the SDK must not
      // retry underneath it or the two backoffs compound.
      maxRetries: 0,
      ...(Object.keys(options.providerOptions ?? {}).length > 0 ? { providerOptions: options.providerOptions } : {}),
      abortSignal,
    });
    for await (const _progress of result.fullStream) rearmIdle();
    const calls = await result.toolCalls;
    output = calls.find((call) => call.toolName === 'auto_review_decision')?.input;
  } catch (error) {
    disarm();
    if (options.signal?.aborted) return { status: 'cancelled' };
    if (timedOut === 'idle')
      return {
        status: 'unavailable',
        code: 'timeout',
        reason: `Auto-review timed out after ${timeoutMs / 1000} seconds without progress.`,
      };
    if (timedOut === 'total')
      return {
        status: 'unavailable',
        code: 'timeout',
        reason: `Auto-review exceeded ${maxMs / 1000} seconds without finishing.`,
      };
    if ((error as { name?: string } | null)?.name === 'NoObjectGeneratedError')
      return { status: 'unavailable', code: 'invalid-output', reason: 'The model returned an invalid structured review.' };
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = String(redactSensitive(message)).slice(0, 360);
    return { status: 'unavailable', code: 'model-error', reason: `Auto-review could not complete: ${safeMessage}` };
  }
  disarm();
  if (options.signal?.aborted) return { status: 'cancelled' };
  const decision = validateDecision(output, {
    userOverride: options.userOverride === true,
    hasConfiguredSchedule: configuredSchedule !== undefined,
    completeness: transcript.completeness,
  });
  return decision
    ? { status: 'decision', decision }
    : { status: 'unavailable', code: 'invalid-output', reason: 'The model returned an invalid structured review.' };
}

interface DecisionContext {
  /** The host marked this as a one-time user-approved retry. */
  userOverride: boolean;
  /** The host supplied a saved schedule instruction. */
  hasConfiguredSchedule: boolean;
  completeness: TranscriptCompleteness;
}

/**
 * Turns raw model output into a decision and applies every rule the host can verify without
 * trusting the model. The prompt asks for these behaviours; this function guarantees them, so a
 * reviewer that was talked out of the prompt still cannot allow what the host can prove it should
 * not. Every rule here only ever moves a verdict toward `escalate`, never toward `allow`.
 */
function validateDecision(value: unknown, context: DecisionContext): AutoReviewDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const decision = value as Record<string, unknown>;
  if (!(VERDICTS as readonly string[]).includes(String(decision.verdict))) return null;
  if (!(CONFIDENCES as readonly string[]).includes(String(decision.confidence))) return null;
  if (!(RISKS as readonly string[]).includes(String(decision.risk))) return null;
  if (!(AUTHORITY_BASES as readonly string[]).includes(String(decision.authority))) return null;
  if (typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > 1_000) return null;
  const safeReason = String(redactSensitive(decision.reason)).replace(/\s+/g, ' ').trim();
  const confidence = decision.confidence as AutoReviewConfidence;
  const risk = decision.risk as AutoReviewRisk;
  const authority = decision.authority as AutoReviewAuthority;

  let verdict = decision.verdict as AutoReviewVerdict;
  // Weak evidence never produces allow or deny, and an allow never covers high, critical or unknown risk.
  if (confidence !== 'high' && verdict !== 'escalate') verdict = 'escalate';
  if (verdict === 'allow' && ['high', 'critical', 'unknown'].includes(risk)) verdict = 'escalate';

  const notes: string[] = [];
  const escalateFor = (note: string) => {
    verdict = 'escalate';
    notes.push(note);
  };
  const authorityNote = checkAuthority(verdict, authority, context);
  if (authorityNote) escalateFor(authorityNote);
  if (verdict === 'allow' && TRANSCRIPT_AUTHORITIES.includes(authority)) {
    // Only transcript-derived authority is weakened by transcript gaps; saved-schedule and user-retry come from the host.
    if (!context.completeness.latestUserInstructionIntact) {
      escalateFor('The latest user instruction could not be shown completely.');
    } else if (hasUserContextGap(context.completeness) && risk !== 'low') {
      escalateFor('Earlier user messages were hidden from this review, so only low-risk actions can be allowed.');
    }
  }

  return {
    verdict,
    confidence,
    risk,
    authority,
    reason: notes.length > 0 ? `${safeReason} (Host check: ${notes.join(' ')})` : safeReason,
  };
}

/** Returns a note when the stated authority cannot support the verdict, from facts only the host knows. */
function checkAuthority(verdict: AutoReviewVerdict, authority: AutoReviewAuthority, context: DecisionContext): string | null {
  if (verdict === 'allow') {
    if (!GRANTING_AUTHORITIES.includes(authority)) return `An allow needs user authority, but the reviewer reported it as ${authority}.`;
    // The model cannot create these two; the host knows whether it supplied them.
    if (authority === 'saved-schedule' && !context.hasConfiguredSchedule) return 'No saved schedule authorizes this request.';
    if (authority === 'user-retry' && !context.userOverride) return 'The user did not approve a retry of this request.';
  }
  if (verdict === 'deny' && authority === 'unestablished') {
    return 'Missing evidence is not a ground to deny.';
  }
  return null;
}

interface PreparedMessage {
  seq: number;
  role: string;
  trust: string;
  content: string;
}

interface RenderedMessage extends PreparedMessage {
  shortened: boolean;
  media: boolean;
}

/**
 * Chooses what the reviewer sees of the conversation.
 *
 * Priorities, in order: the latest user message (it defines what is authorized, so it is pinned
 * and never dropped for age or budget), earlier user messages (they can carry restrictions), and
 * then the newest assistant and tool messages that still fit. The budget is therefore spent on
 * authority first and evidence second, and what is lost is always the oldest, least relevant
 * context, never the newest. Every message keeps its original `seq`, and everything that was
 * dropped or cut is counted in `completeness` so the reviewer and the host can both act on it.
 */
function prepareTranscript(
  messages: readonly ModelMessage[],
  hasConfiguredSchedule = false,
): { messages: PreparedMessage[]; completeness: TranscriptCompleteness } {
  const bucket = (role: string): 'user' | 'other' => (role === 'user' ? 'user' : 'other');
  const lastUser = messages.map((message) => message.role).lastIndexOf('user');
  const wrapperIndex = hasConfiguredSchedule ? lastUser : -1;

  const cache = new Map<number, RenderedMessage>();
  const render = (index: number): RenderedMessage => {
    const cached = cache.get(index);
    if (cached) return cached;
    const message = messages[index]!;
    const role = message.role;
    const isWrapper = index === wrapperIndex;
    const trust = isWrapper
      ? TRUST_LABELS.scheduleWrapper
      : role === 'user'
        ? TRUST_LABELS.user
        : role === 'tool'
          ? TRUST_LABELS.tool
          : TRUST_LABELS.assistant;
    const pieces = isWrapper ? [] : visibleTextParts(message, role);
    const media = pieces.some((piece) => piece.includes(MEDIA_MARKER));
    let content = isWrapper
      ? '[Configured schedule message omitted; see configuredSchedule and untrustedTriggerFacts.]'
      : pieces.join('\n').trim();
    let shortened = false;
    if (role === 'user' && !isWrapper) {
      if (content.length > MAX_USER_MESSAGE_CHARS) {
        // The instruction can sit at either end of a long pasted message, so keep both.
        const half = Math.floor(MAX_USER_MESSAGE_CHARS / 2);
        const omitted = content.length - half * 2;
        content = `${content.slice(0, half)} [${omitted} characters omitted] ${content.slice(-half)}`;
        shortened = true;
      }
    } else if (content.length > MAX_MESSAGE_CHARS) {
      content = `${content.slice(0, MAX_MESSAGE_CHARS)} [message shortened]`;
      shortened = true;
    }
    const rendered = { seq: index, role, trust, content, shortened, media };
    cache.set(index, rendered);
    return rendered;
  };

  // The latest user message that has anything visible; a configured schedule wrapper always counts.
  let pinned = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === 'user' && render(index).content) {
      pinned = index;
      break;
    }
  }

  const picked = new Map<number, RenderedMessage>();
  let used = 0;
  const take = (entry: RenderedMessage, content = entry.content) => {
    picked.set(entry.seq, { ...entry, content });
    used += content.length;
  };

  if (pinned >= 0) take(render(pinned));
  // Earlier user messages, newest first, leaving room for the context nearest the action.
  for (let index = pinned - 1; index >= 0; index--) {
    const entry = render(index);
    if (entry.role !== 'user' || !entry.content) continue;
    if (picked.size >= MAX_MESSAGES || used + entry.content.length > MAX_TRANSCRIPT_CHARS - CONTEXT_RESERVE_CHARS) continue;
    take(entry);
  }
  // Assistant and tool messages as one contiguous recent tail, so the newest are never the ones lost.
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = render(index);
    if (entry.role === 'user' || !entry.content) continue;
    if (picked.size >= MAX_MESSAGES) break;
    const remaining = MAX_TRANSCRIPT_CHARS - used;
    if (entry.content.length <= remaining) {
      take(entry);
      continue;
    }
    if (remaining >= MIN_PARTIAL_CHARS) take({ ...entry, shortened: true }, `${entry.content.slice(0, remaining)} [transcript shortened]`);
    break;
  }

  const completeness: TranscriptCompleteness = {
    totalMessages: messages.length,
    shownMessages: picked.size,
    latestUserInstructionIntact: pinned >= 0 && !render(pinned).shortened && !render(pinned).media,
    omittedMessages: { user: 0, other: 0 },
    shortenedMessages: { user: 0, other: 0 },
    mediaOmitted: { user: 0, other: 0 },
  };
  for (let index = 0; index < messages.length; index++) {
    const entry = render(index);
    if (!entry.content) continue;
    const group = bucket(entry.role);
    const shown = picked.get(index);
    if (!shown) completeness.omittedMessages[group]++;
    else {
      if (shown.shortened) completeness.shortenedMessages[group]++;
      if (shown.media) completeness.mediaOmitted[group]++;
    }
  }

  const ordered = [...picked.values()]
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq, role, trust, content }): PreparedMessage => ({ seq, role, trust, content }));
  return { messages: ordered, completeness };
}

function visibleTextParts(message: ModelMessage, role: string): string[] {
  const content: unknown = (message as { content?: unknown }).content;
  if (typeof content === 'string') return [String(redactSensitive(content))];
  if (!Array.isArray(content)) return [];
  const pieces: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = part as Record<string, unknown>;
    if (item.type === 'reasoning' || item.type === 'redacted-reasoning') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      pieces.push(String(redactSensitive(item.text)));
    } else if (item.type === 'tool-call') {
      const safe = redactSensitive({ name: item.toolName, input: item.input });
      pieces.push(`[assistant tool call, untrusted for authorization: ${boundedJson(safe)}]`);
    } else if (item.type === 'tool-result') {
      const safe = redactSensitive({ name: item.toolName, output: item.output });
      pieces.push(`[untrusted tool output: ${boundedJson(safe)}]`);
    } else if (item.type === 'image' || item.type === 'file' || item.type === 'data') {
      pieces.push('[media or file content omitted from review context]');
    }
  }
  if (role === 'tool' && pieces.length === 0) return ['[untrusted tool output omitted]'];
  return pieces;
}

function boundedJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(prepareReviewValue(value).value) ?? String(value);
  } catch {
    text = '[unserializable]';
  }
  return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)} [output shortened]`;
}

function prepareReviewValue(
  value: unknown,
  depth = 0,
  state = { nodes: 0, redacted: false, truncated: false },
): { value: unknown; redacted: boolean; truncated: boolean } {
  if (depth > 12 || state.nodes >= 1_000) {
    state.truncated = true;
    return { value: '[content omitted]', redacted: state.redacted, truncated: true };
  }
  state.nodes++;
  if (typeof value === 'string') {
    const safe = String(redactSensitive(value));
    if (safe !== value) state.redacted = true;
    if (safe.length > 8_000) {
      state.truncated = true;
      return { value: `${safe.slice(0, 8_000)} [content omitted]`, redacted: state.redacted, truncated: true };
    }
    return { value: safe, redacted: state.redacted, truncated: state.truncated };
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, 100).map((item) => prepareReviewValue(item, depth + 1, state).value);
    if (value.length > 100) state.truncated = true;
    return { value: result, redacted: state.redacted, truncated: state.truncated };
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) state.truncated = true;
    for (const [key, nested] of entries.slice(0, 100)) {
      const kind = classifySensitiveEntry(key, nested);
      if (kind === 'secret') {
        state.redacted = true;
        result[key] = '[redacted]';
      } else if (kind === 'media') {
        state.truncated = true;
        result[key] = '[media payload omitted]';
      } else {
        result[key] = prepareReviewValue(nested, depth + 1, state).value;
      }
    }
    return { value: result, redacted: state.redacted, truncated: state.truncated };
  }
  return { value, redacted: state.redacted, truncated: state.truncated };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, 'en-US'))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
