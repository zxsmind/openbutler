import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { AUTO_REVIEW_POLICY, reviewToolRequest, type AutoReviewResult } from '../src/auto-review.js';
import {
  AUTHORITY_BASES,
  AUTHORITY_DEFINITIONS,
  CONFIDENCES,
  EFFECT_FLAG_DEFINITIONS,
  RISKS,
  RISK_DEFINITIONS,
  TRUST_LABELS,
  VERDICTS,
  buildAutoReviewPolicy,
  buildDecisionSchema,
  deriveEffectFlags,
} from '../src/auto-review-policy.js';
import type { ToolCallRequest, ToolEffect } from '../src/tools/registry.js';

/**
 * The reviewer policy is a contract between three parties: the prompt the model reads, the payload
 * the host builds, and the validator that overrules the model. These tests keep the three in step.
 * They check structure and host-side enforcement; they cannot and do not claim to measure how a
 * particular model behaves under the prompt. That needs an eval against a real model.
 */

const usage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 12, text: 12, reasoning: 0 },
};

function decisionModel(json: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 'review-1',
            toolName: 'auto_review_decision',
            input: json,
          });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop' as const, raw: 'stop' as const },
            usage,
          });
          controller.close();
        },
      }),
    }),
  });
}

function decision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authority: 'explicit',
    risk: 'low',
    reason: 'Within the stated request.',
    confidence: 'high',
    verdict: 'allow',
    ...overrides,
  });
}

function request(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'req-policy',
    providerId: 'host',
    name: 'inspect',
    input: { path: './notes.txt' },
    effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
    ...overrides,
  };
}

const user = (content: string | unknown[]) => ({ role: 'user', content }) as unknown as ModelMessage;
const assistant = (content: string) => ({ role: 'assistant', content }) as unknown as ModelMessage;
const toolResult = (value: string, id = 'call') =>
  ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName: 'file_read', output: { type: 'text', value } }],
  }) as unknown as ModelMessage;

interface Review {
  result: AutoReviewResult;
  system: string;
  payload: Record<string, unknown>;
}

async function review(options: {
  messages?: ModelMessage[];
  modelJson?: string;
  request?: ToolCallRequest;
  userOverride?: boolean;
  task?: boolean;
}): Promise<Review> {
  const model = decisionModel(options.modelJson ?? decision());
  const result = await reviewToolRequest({
    model,
    request: options.request ?? request(),
    messages: options.messages ?? [user('Show me what is in notes.txt.')],
    workspaceRoot: '/work/space',
    ...(options.userOverride ? { userOverride: true } : {}),
    ...(options.task
      ? {
          authorizedBackgroundTask: {
            kind: 'background-task' as const,
            name: 'Nightly',
            instruction: 'Read notes.',
            triggerFacts: { a: 1 },
          },
        }
      : {}),
  });
  const call = model.doStreamCalls[0];
  let system = '';
  let payload: Record<string, unknown> = {};
  if (call) {
    for (const message of call.prompt) {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      if (message.role === 'system') system = text;
      else if (message.role === 'user') payload = JSON.parse(text) as Record<string, unknown>;
    }
  }
  return { result, system, payload };
}

const verdictOf = (review: Review) => (review.result.status === 'decision' ? review.result.decision.verdict : review.result.status);
const completenessOf = (review: Review) =>
  review.payload.transcriptCompleteness as {
    totalMessages: number;
    shownMessages: number;
    latestUserInstructionIntact: boolean;
    omittedMessages: { user: number; other: number };
    shortenedMessages: { user: number; other: number };
    mediaOmitted: { user: number; other: number };
  };
const conversationOf = (review: Review) =>
  review.payload.recentVisibleConversation as Array<{ seq: number; role: string; trust: string; content: string }>;

describe('policy and mechanism stay in step', () => {
  it('defines every trust label the payload can emit', async () => {
    const run = await review({
      task: true,
      messages: [user('First request.'), assistant('Looking.'), toolResult('listing'), user('Latest request.')],
    });
    const emitted = new Set(conversationOf(run).map((item) => item.trust));
    // All four labels are reachable: user, assistant, tool, and the task wrapper for the latest user message.
    expect(emitted).toEqual(new Set(Object.values(TRUST_LABELS)));
    for (const label of emitted) expect(run.system).toContain(`"${label}"`);
  });

  it('defines every field the host sends, at every level, with no exceptions', async () => {
    const run = await review({ task: true, userOverride: true });
    const levels = [
      Object.keys(run.payload),
      Object.keys(run.payload.currentAction as object),
      Object.keys(run.payload.transcriptCompleteness as object),
      Object.keys(conversationOf(run)[0]!),
    ];
    for (const key of levels.flat()) expect(run.system, `policy does not mention payload field "${key}"`).toContain(key);
  });

  it('defines every enum value the model may output, once, in its own definition line', () => {
    const policy = buildAutoReviewPolicy();
    const tables: Array<[readonly string[], Record<string, string>]> = [
      [AUTHORITY_BASES, AUTHORITY_DEFINITIONS],
      [RISKS, RISK_DEFINITIONS],
      [Object.keys(EFFECT_FLAG_DEFINITIONS), EFFECT_FLAG_DEFINITIONS],
    ];
    for (const [values, definitions] of tables) {
      expect(Object.keys(definitions).sort()).toEqual([...values].sort());
      for (const value of values) {
        // The full line (value plus its own definition) is unique even where two tables share a word such as low.
        expect(policy.split(`\n- ${value}: ${definitions[value]}`).length - 1, `definition line for ${value}`).toBe(1);
      }
    }
    for (const value of [...VERDICTS, ...CONFIDENCES]) expect(policy).toContain(value);
  });

  it('keeps the schema in step with the vocabulary and puts classification before the verdict', () => {
    const schema = buildDecisionSchema();
    const keys = Object.keys(schema.properties);
    expect(keys[0]).toBe('authority');
    expect(keys[keys.length - 1]).toBe('verdict');
    expect(schema.required).toEqual(keys);
    expect(schema.properties.authority.enum).toEqual([...AUTHORITY_BASES]);
    expect(schema.properties.risk.enum).toEqual([...RISKS]);
    expect(schema.properties.confidence.enum).toEqual([...CONFIDENCES]);
    expect(schema.properties.verdict.enum).toEqual([...VERDICTS]);
  });

  it('contains rules and definitions only: no worked examples, samples or quoted outputs', () => {
    expect(AUTO_REVIEW_POLICY).toBe(buildAutoReviewPolicy());
    expect(AUTO_REVIEW_POLICY).not.toMatch(/\be\.g\.|\bi\.e\.|\bfor example\b|\bfor instance\b|\bexample\b|\bsuch as\b|```|\{\s*"/i);
  });

  it('stays within a size budget, because the review runs on the cheapest model setting', () => {
    expect(AUTO_REVIEW_POLICY.length).toBeLessThan(9_000);
  });
});

describe('deriveEffectFlags', () => {
  const quiet = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' };

  it('reads a quiet declaration as quiet', () => {
    expect(deriveEffectFlags(quiet)).toEqual([]);
    expect(deriveEffectFlags({ ...quiet, outbound: 'none' })).toEqual([]);
  });

  it('flags data that reaches another party even when nothing local changes', () => {
    expect(deriveEffectFlags({ ...quiet, outbound: 'model-and-tool-server' })).toEqual(['data-reaches-other-party']);
  });

  it('flags state changes, and flags hard-to-undo only when something changed', () => {
    expect(deriveEffectFlags({ ...quiet, change: 'modify' })).toEqual(['changes-state']);
    expect(deriveEffectFlags({ ...quiet, change: 'delete', reversible: 'none' })).toEqual(['changes-state', 'hard-to-undo']);
    expect(deriveEffectFlags({ ...quiet, reversible: 'none' })).toEqual([]);
  });

  it('flags network use', () => {
    expect(deriveEffectFlags({ ...quiet, network: 'write' })).toEqual(['uses-network']);
  });

  it('fails closed: a value it has never seen, or a missing field, is not read as quiet', () => {
    expect(deriveEffectFlags({ ...quiet, change: 'some-future-kind' })).toContain('changes-state');
    expect(deriveEffectFlags({ ...quiet, outbound: 'some-future-target' })).toContain('data-reaches-other-party');
    expect(deriveEffectFlags(undefined)).toEqual(['changes-state', 'hard-to-undo', 'uses-network', 'data-reaches-other-party']);
    expect(deriveEffectFlags({ ...quiet, network: 3 })).toContain('uses-network');
  });

  it('puts the derived flags next to the raw declaration in the payload', async () => {
    const effect: ToolEffect = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model-and-tool-server' };
    const run = await review({ request: request({ effect }) });
    const action = run.payload.currentAction as { declaredEffects: unknown; hostDerivedEffectFlags: string[] };
    expect(action.declaredEffects).toEqual(effect);
    expect(action.hostDerivedEffectFlags).toEqual(['data-reaches-other-party']);
  });
});

describe('the host overrules a verdict its authority cannot support', () => {
  it('escalates an allow whose authority is not established or is contradicted', async () => {
    for (const authority of ['unestablished', 'contradicted']) {
      const run = await review({ modelJson: decision({ authority }) });
      expect(verdictOf(run), authority).toBe('escalate');
    }
  });

  it('says why, and keeps the reviewer reason', async () => {
    const run = await review({ modelJson: decision({ authority: 'unestablished', reason: 'Nothing covers this.' }) });
    expect(run.result.status === 'decision' && run.result.decision.reason).toMatch(/^Nothing covers this\. \(Host check: .*unestablished/);
  });

  it('does not let a deny rest on missing evidence', async () => {
    expect(verdictOf(await review({ modelJson: decision({ verdict: 'deny', authority: 'unestablished' }) }))).toBe('escalate');
    expect(verdictOf(await review({ modelJson: decision({ verdict: 'deny', authority: 'contradicted' }) }))).toBe('deny');
    expect(verdictOf(await review({ modelJson: decision({ verdict: 'deny', authority: 'explicit', risk: 'critical' }) }))).toBe('deny');
  });

  it('rejects a claimed saved task that the host never supplied, and accepts a real one', async () => {
    expect(verdictOf(await review({ modelJson: decision({ authority: 'saved-task' }) }))).toBe('escalate');
    expect(verdictOf(await review({ modelJson: decision({ authority: 'saved-task' }), task: true }))).toBe('allow');
  });

  it('rejects a claimed user retry that the host never marked, and accepts a real one', async () => {
    expect(verdictOf(await review({ modelJson: decision({ authority: 'user-retry' }) }))).toBe('escalate');
    expect(verdictOf(await review({ modelJson: decision({ authority: 'user-retry' }), userOverride: true }))).toBe('allow');
  });

  it('treats a missing or unknown authority as an invalid review, never as a decision', async () => {
    const { authority: _omitted, ...withoutAuthority } = JSON.parse(decision()) as Record<string, unknown>;
    expect(await review({ modelJson: JSON.stringify(withoutAuthority) }).then((run) => run.result)).toMatchObject({
      status: 'unavailable',
      code: 'invalid-output',
    });
    expect(await review({ modelJson: decision({ authority: 'because-i-said-so' }) }).then((run) => run.result)).toMatchObject({
      status: 'unavailable',
      code: 'invalid-output',
    });
  });

  it('never produces an allow the model did not give, and never one the rules forbid', async () => {
    const granting = new Set(['explicit', 'implied-step']);
    for (const verdict of VERDICTS)
      for (const confidence of CONFIDENCES)
        for (const risk of RISKS)
          for (const authority of AUTHORITY_BASES) {
            const run = await review({ modelJson: decision({ verdict, confidence, risk, authority }) });
            if (verdictOf(run) !== 'allow') continue;
            const label = JSON.stringify({ verdict, confidence, risk, authority });
            expect(verdict, label).toBe('allow');
            expect(confidence, label).toBe('high');
            expect(['low', 'moderate'], label).toContain(risk);
            expect(granting.has(authority), label).toBe(true);
          }
  });
});

describe('the reviewer always sees the newest user words', () => {
  it('keeps the latest user message when old tool output fills the budget', async () => {
    const messages = [user('Clean up the build folder.')];
    for (let index = 0; index < 6; index++) messages.push(toolResult('x'.repeat(2_300), `c${index}`));
    messages.push(user('STOP. Do not delete anything, I changed my mind.'));
    const run = await review({ messages });
    const shown = conversationOf(run);
    expect(shown[shown.length - 1]).toMatchObject({ role: 'user', content: 'STOP. Do not delete anything, I changed my mind.' });
    expect(completenessOf(run).latestUserInstructionIntact).toBe(true);
  });

  it('keeps the user instruction through a long agent loop instead of falling back to manual approval', async () => {
    const messages = [user('Open the report on my desktop.')];
    for (let index = 0; index < 12; index++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `c${index}`, toolName: 'x', input: { index } }],
      } as unknown as ModelMessage);
      messages.push(toolResult('ok', `c${index}`));
    }
    const run = await review({ messages });
    expect(run.result.status).toBe('decision');
    const shown = conversationOf(run);
    expect(shown[0]).toMatchObject({ seq: 0, role: 'user', content: 'Open the report on my desktop.' });
    expect(shown.length).toBeLessThanOrEqual(16);
    // The jump in seq and the counters both say that older assistant and tool messages were dropped.
    expect(shown[1]!.seq).toBeGreaterThan(1);
    expect(completenessOf(run)).toMatchObject({ totalMessages: 25, shownMessages: shown.length, omittedMessages: { user: 0 } });
    expect(completenessOf(run).omittedMessages.other).toBeGreaterThan(0);
  });

  it('presents messages in conversation order and drops the oldest context first', async () => {
    const messages = [user('Start.')];
    for (let index = 0; index < 20; index++) messages.push(assistant(`step ${index}`));
    const run = await review({ messages });
    const seqs = conversationOf(run).map((item) => item.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(conversationOf(run).some((item) => item.content === 'step 19')).toBe(true);
    expect(conversationOf(run).some((item) => item.content === 'step 0')).toBe(false);
  });

  it('keeps both ends of a very long user message, and says it was cut', async () => {
    const long = `HEAD-MARK ${'a'.repeat(9_000)} TAIL-MARK delete the cache`;
    const run = await review({ messages: [user(long)] });
    const text = conversationOf(run)[0]!.content;
    expect(text).toContain('HEAD-MARK');
    expect(text).toContain('TAIL-MARK delete the cache');
    expect(completenessOf(run)).toMatchObject({ latestUserInstructionIntact: false, shortenedMessages: { user: 1 } });
    expect(run.result.status).toBe('decision');
  });

  it('still builds a reviewable prompt in the worst case instead of giving up on size', async () => {
    const messages = [user('"'.repeat(20_000))];
    for (let index = 0; index < 20; index++) messages.push(toolResult('"'.repeat(5_000), `c${index}`));
    const run = await review({ messages });
    expect(run.result.status).toBe('decision');
  });
});

describe('incomplete context limits what can be allowed, without blocking routine work', () => {
  it('escalates an allow when the latest user instruction was cut or carries media', async () => {
    const cut = await review({ messages: [user(`${'a'.repeat(7_000)} now delete the cache`)] });
    expect(verdictOf(cut)).toBe('escalate');
    const media = await review({
      messages: [
        user([
          { type: 'text', text: 'Do what the screenshot says.' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
        ]),
      ],
    });
    expect(completenessOf(media).latestUserInstructionIntact).toBe(false);
    expect(completenessOf(media).mediaOmitted.user).toBe(1);
    expect(verdictOf(media)).toBe('escalate');
  });

  it('still lets a deny through when the latest instruction is cut', async () => {
    const run = await review({
      messages: [user(`${'a'.repeat(7_000)} now delete the cache`)],
      modelJson: decision({ verdict: 'deny', authority: 'contradicted', risk: 'high' }),
    });
    expect(verdictOf(run)).toBe('deny');
  });

  it('allows only low risk when earlier user messages were hidden', async () => {
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 20; index++) messages.push(user(`Earlier request ${index}.`));
    messages.push(user('Show me notes.txt.'));
    const low = await review({ messages, modelJson: decision({ risk: 'low' }) });
    expect(completenessOf(low).omittedMessages.user).toBeGreaterThan(0);
    expect(completenessOf(low).latestUserInstructionIntact).toBe(true);
    expect(verdictOf(low)).toBe('allow');
    expect(verdictOf(await review({ messages, modelJson: decision({ risk: 'moderate' }) }))).toBe('escalate');
  });

  it('does not penalize shortened tool output, which carries evidence and never authority', async () => {
    const messages = [user('Summarize the log.'), toolResult('y'.repeat(4_000))];
    const run = await review({ messages, modelJson: decision({ risk: 'moderate', authority: 'implied-step' }) });
    expect(completenessOf(run)).toMatchObject({ latestUserInstructionIntact: true, shortenedMessages: { user: 0, other: 1 } });
    expect(verdictOf(run)).toBe('allow');
  });

  it('does not let transcript gaps weaken authority that comes from the host', async () => {
    const long = `${'a'.repeat(7_000)} tail`;
    expect(verdictOf(await review({ messages: [user(long)], modelJson: decision({ authority: 'user-retry' }), userOverride: true }))).toBe(
      'allow',
    );
    expect(verdictOf(await review({ messages: [user(long)], modelJson: decision({ authority: 'saved-task' }), task: true }))).toBe('allow');
  });
});
