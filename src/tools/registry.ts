import { createHash, randomUUID } from 'node:crypto';
import type { ToolSet } from 'ai';
import type { JSONValue } from '@ai-sdk/provider';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { isForbiddenHostPath } from '../host-owned-paths.js';
import { summarizeFileToolResult, summarizeImageToolResult, summarizeOwnerInboxToolResult } from '../image.js';
import { redactToolOutput } from '../sensitive-data.js';
import type { ToolActionState } from '../activity-ledger.js';
import type { ApprovalMode } from '../settings.js';
import type { WorkspaceScope } from '../workspace-scope.js';
import { runWithToolTimeout, toolTimeoutSeconds, ToolTimeoutError, TOOL_TIMEOUT_FIELD, withToolTimeoutSchema } from './timeout.js';

const MAX_INPUT_CHARS = 50_000;
export const MAX_TOOL_RESULT_CHARS = 80_000;
export const MAX_TOOL_INPUT_CHARS = 8_000_000;

export interface ToolEffect {
  change: 'none' | 'create' | 'modify' | 'delete' | 'execute' | 'unknown';
  data: 'public' | 'local' | 'sensitive' | 'secret' | 'unknown';
  network: 'none' | 'possible' | 'used' | 'unknown';
  reversible: 'full' | 'compensating' | 'none' | 'unknown';
  outbound: 'none' | 'model' | 'tool-server' | 'model-and-tool-server' | 'unknown';
}

export interface ToolExecutionContext {
  /** Host-selected operation budget, separate from tool/server arguments. */
  timeoutSeconds?: number;
  /** The target resolved once before the permission decision, when the definition declared one. */
  target?: string;
  /**
   * Interactive question channel for the current run, when one is attached.
   * Resolves to the user's answer or null when the question was dismissed or
   * the run was stopped.
   */
  ask?: (question: ToolUserQuestion, signal?: AbortSignal) => Promise<string | null>;
  /** The id of the session this run belongs to, so host tools can act on the caller's behalf. */
  sessionId?: string;
  /**
   * Worker write lease check, supplied only for subagent sessions. Receives the
   * resolved absolute path; returns a refusal message when another running
   * worker holds it, or null after claiming it for this session.
   */
  guardWrite?: (absolutePath: string) => string | null;
}

export interface ToolUserQuestion {
  text: string;
  options?: readonly string[];
}

export interface ToolDefinition {
  providerId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  maxInputChars?: number;
  effect: ToolEffect;
  /**
   * Resolves the concrete execution target (typically a canonical filesystem path)
   * once, before the permission decision. The same value reaches `assess`,
   * `autoApprove`, `hostPreAuthorized`, `workspaceScope` and `execute`, so
   * approval and execution act on one resolution instead of each re-resolving
   * the input.
   */
  resolveTarget?: (input: Record<string, unknown>) => string | null;
  assess?: (input: Record<string, unknown>, target?: string) => ToolEffect;
  autoApprove?: (input: Record<string, unknown>, target?: string) => boolean;
  /**
   * Host authority: true when this call touches only Ranite-owned paths
   * (scratch, memory, settings — see host-owned-paths.ts). Unlike
   * `autoApprove`, which is the tool's own judgment and is switched off in
   * unattended runs, this is a host fact and stays on in background sessions.
   */
  hostPreAuthorized?: (input: Record<string, unknown>, target?: string) => boolean;
  /** Classifies filesystem/command effects relative to the active workspace. */
  workspaceScope?: (input: Record<string, unknown>, target?: string) => WorkspaceScope;
  /** Stop this model stream after a successful call so its caller can rebuild available tools. */
  restartAfterExecute?: (result: unknown) => boolean;
  toModelOutput?: (output: unknown) => ToolResultOutput | PromiseLike<ToolResultOutput>;
  execute: (input: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolCallRequest {
  requestId: string;
  providerId: string;
  name: string;
  input: Record<string, unknown>;
  effect: ToolEffect;
  timeoutSeconds?: number;
  /**
   * Why this call needs a human or reviewer decision. Set by the registry when
   * deterministic gates pass it to approve(); reviewers use it as context.
   */
  gateReason?: string;
}

export interface ToolApprovalOutcome {
  approved: boolean;
  /**
   * Who decided: the auto-reviewer, or the approval clock when nobody
   * answered in time. Timeouts never stop the run; the model works around
   * them like a reviewer denial, not like a human refusal.
   */
  source: 'auto-review' | 'approval-timeout';
  reason: string;
  /** Risk the reviewer reported on allow; surfaced to the model with the result. */
  risk?: string;
  /** Seconds the approver had before an approval-timeout fired. */
  timeoutSeconds?: number;
}

export type ToolApprovalResponse = boolean | ToolApprovalOutcome;

/** Registry is the single path from native/MCP tool providers to model calls and policy. */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(definition.providerId)) {
      throw new Error(`Invalid tool provider id: ${definition.providerId}`);
    }
    if (
      !definition.name.trim() ||
      definition.name.length > 256 ||
      !definition.description.trim() ||
      definition.description.length > 8_000
    ) {
      throw new Error('Tools need a name (up to 256 characters) and description.');
    }
    if (!definition.inputSchema || typeof definition.inputSchema !== 'object' || Array.isArray(definition.inputSchema)) {
      throw new Error(`Tool ${definition.providerId}/${definition.name} has no object input schema.`);
    }
    if (
      definition.maxInputChars !== undefined &&
      (!Number.isSafeInteger(definition.maxInputChars) || definition.maxInputChars < 1 || definition.maxInputChars > MAX_TOOL_INPUT_CHARS)
    ) {
      throw new Error(`Tool ${definition.providerId}/${definition.name} has an invalid input size limit.`);
    }
    const schema = JSON.stringify(definition.inputSchema);
    if (!schema || schema.length > 50_000) {
      throw new Error(`Tool schema is too large: ${definition.providerId}/${definition.name}`);
    }
    withToolTimeoutSchema(definition.inputSchema);
    const id = `${definition.providerId}:${definition.name}`;
    if (this.definitions.has(id)) throw new Error(`Tool already registered: ${id}`);
    this.definitions.set(id, definition);
  }

  async createModelTools(options: {
    approve: (request: ToolCallRequest, signal?: AbortSignal) => Promise<ToolApprovalResponse>;
    approvalMode?: ApprovalMode;
    autoApprove?: (request: ToolCallRequest) => boolean;
    allowToolAutoApproval?: boolean;
    /** Interactive user-question channel passed to every tool; absent in unattended runs. */
    ask?: (question: ToolUserQuestion, signal?: AbortSignal) => Promise<string | null>;
    /** The run's session id, passed through to tools that act on the caller's behalf. */
    sessionId?: string;
    /** Worker write lease check, passed through to tools that write files. */
    guardWrite?: (absolutePath: string) => string | null;
    /** When set, only these tool names are offered to the model for this run (worker tool sets). */
    allowTools?: readonly string[];
    onStart?: (request: ToolCallRequest, toolCallId?: string) => void;
    onResult: (request: ToolCallRequest, result: unknown, toolCallId?: string) => void;
    onAction?: (request: ToolCallRequest, state: ToolActionState, detail?: { result?: unknown; error?: string }) => void | Promise<void>;
    signal?: AbortSignal;
    /**
     * Live tool-call input as the provider streams it. Providers that stream
     * arguments call these before execution; the session uses them to show the
     * call while it is still being written. Callbacks are advisory only.
     */
    preview?: {
      onStart?: (info: { toolCallId: string; providerId: string; name: string }) => void;
      onDelta?: (info: { toolCallId: string; inputTextDelta: string }) => void;
      onAvailable?: (info: { toolCallId: string; input: Record<string, unknown> }) => void;
    };
  }) {
    const { jsonSchema, tool } = await import('ai');
    const modelTools: Record<string, unknown> = {};
    const usedNames = new Set<string>();
    let queue: Promise<void> = Promise.resolve();
    let stopped = false;
    let restartRequested = false;
    /**
     * Per-call review notes, keyed by the exact result object `execute`
     * returns. The model wrapper appends them as trailing text; the ledger,
     * transcript, and notifications keep the untagged value.
     */
    const reviewNotes = new WeakMap<object, string>();

    const execute = async (definition: ToolDefinition, input: Record<string, unknown>, toolCallId?: string): Promise<unknown> => {
      if (options.signal?.aborted) return { status: 'cancelled', error: 'The run was stopped by the user.' };
      if (stopped) return { status: 'denied', error: 'A previous tool call was declined; this agent run has stopped.' };
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return { status: 'rejected', error: 'Tool input must be an object.' };
      let timeoutSeconds: number;
      try {
        timeoutSeconds = toolTimeoutSeconds(input[TOOL_TIMEOUT_FIELD]);
      } catch (error) {
        return { status: 'invalid', error: error instanceof Error ? error.message : String(error) };
      }
      const { [TOOL_TIMEOUT_FIELD]: _timeout, ...argumentsOnly } = input;
      input = argumentsOnly;
      let serializedInput: string;
      try {
        serializedInput = JSON.stringify(input);
      } catch {
        return { status: 'rejected', error: 'Tool input could not be serialized.' };
      }
      if (serializedInput.length > (definition.maxInputChars ?? MAX_INPUT_CHARS))
        return { status: 'rejected', error: 'Tool input exceeded the size limit.' };
      let target: string | undefined;
      try {
        target = definition.resolveTarget?.(input) ?? undefined;
      } catch {
        target = undefined;
      }
      let effect: ToolEffect;
      try {
        effect = definition.assess?.(input, target) ?? definition.effect;
      } catch (error) {
        return { status: 'rejected', error: `Could not assess tool effects: ${error instanceof Error ? error.message : String(error)}` };
      }
      const request: ToolCallRequest = {
        requestId: randomUUID(),
        providerId: definition.providerId,
        name: definition.name,
        input,
        effect,
        timeoutSeconds,
      };
      const reportResult = (result: unknown) => {
        try {
          options.onResult(request, result, toolCallId);
        } catch (error) {
          console.error(
            `Could not publish ${request.providerId}/${request.name} result: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      const failClosed = async (message: string): Promise<unknown> => {
        stopped = true;
        const result = { status: 'error', error: message };
        try {
          await options.onAction?.(request, 'failed', { result, error: message });
        } catch {
          /* keep the failed tool exchange paired */
        }
        reportResult(result);
        return result;
      };
      if (restartRequested) {
        const deferred = { status: 'deferred', error: 'The available tool catalog changed; this call was not executed.' };
        reportResult(deferred);
        return deferred;
      }
      try {
        await options.onAction?.(request, 'proposed');
      } catch (error) {
        return failClosed(
          `The tool was not run because its proposal could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let scope: WorkspaceScope = 'unknown';
      if (options.approvalMode === 'workspace' || options.approvalMode === 'auto-review') {
        try {
          scope = definition.workspaceScope?.(input, target) ?? 'unknown';
        } catch {
          scope = 'unknown';
        }
      }
      if (target !== undefined && isForbiddenHostPath(target)) {
        // The secret store is never visible to the agent: no read, write,
        // edit, or search, under no approval mode and no whitelist. This is a
        // hard denial, not an approval question, and it does not stop the run:
        // the agent is told where keys actually come from and moves on.
        const result = {
          status: 'denied',
          error:
            "Ranite's secret store is not visible to the agent: it cannot be read, written, edited, or searched. Provider keys are configured with `ranite setup` or environment variables, never through this session. Name the provider you need; do not retry this path.",
        };
        try {
          await options.onAction?.(request, 'denied', { result });
        } catch {
          /* keep the denied tool exchange paired */
        }
        reportResult(result);
        return result;
      }
      let autoApproved: boolean;
      try {
        autoApproved =
          options.approvalMode === 'full-access' ||
          definition.hostPreAuthorized?.(input, target) === true ||
          (options.allowToolAutoApproval !== false && definition.autoApprove?.(input, target) === true) ||
          ((options.approvalMode === 'workspace' || options.approvalMode === 'auto-review') && scope === 'workspace') ||
          options.autoApprove?.(request) === true;
      } catch (error) {
        return failClosed(`Tool approval policy failed; the tool was not run: ${error instanceof Error ? error.message : String(error)}`);
      }
      let approvalResponse: ToolApprovalResponse = autoApproved;
      try {
        if (!autoApproved) {
          request.gateReason = scope === 'outside' ? 'outside-workspace' : scope === 'unknown' ? 'unknown-scope' : 'manual-review';
          approvalResponse = await options.approve(request, options.signal);
        }
      } catch (error) {
        return failClosed(`Tool approval failed; the tool was not run: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (options.signal?.aborted) {
        let result: Record<string, unknown> = { status: 'cancelled', error: 'The run was stopped by the user.' };
        try {
          await options.onAction?.(request, 'cancelled', { result });
        } catch (error) {
          result = {
            status: 'cancelled',
            error: `The run was stopped; cancellation could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        reportResult(result);
        return result;
      }
      const approved = typeof approvalResponse === 'boolean' ? approvalResponse : approvalResponse.approved;
      if (!approved) {
        const outcome = typeof approvalResponse === 'boolean' ? undefined : approvalResponse;
        const autoReviewDenied = outcome?.source === 'auto-review';
        const approvalTimedOut = outcome?.source === 'approval-timeout';
        if (!autoReviewDenied && !approvalTimedOut) stopped = true;
        let result: Record<string, unknown>;
        if (autoReviewDenied) {
          result = {
            status: 'denied',
            error: `Auto-review denied this exact action: ${outcome?.reason ?? ''} Do not retry it, change its wording, or switch tools to bypass the decision. Only propose a materially safer alternative or ask the user.`,
          };
        } else if (approvalTimedOut) {
          const seconds = outcome?.timeoutSeconds ?? 60;
          result = {
            status: 'denied',
            error: `No approval decision within ${seconds} seconds: nobody approved or declined, so the action was not run. This is not a refusal on the merits. Work around it: propose a materially safer alternative that needs no approval, defer the action, or ask the user about it in chat.`,
          };
        } else {
          result = { status: 'denied', error: 'The user declined this tool call. It was not run.' };
        }
        try {
          await options.onAction?.(request, 'denied', { result });
        } catch (error) {
          stopped = true;
          result = {
            status: 'error',
            error: `${String(result.error)} The denial could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        reportResult(result);
        return result;
      }

      let resultRecorded = false;
      let executionStarted = false;
      let executionCompleted = false;
      // The model sees that a review ran and passed; the note stays out of
      // the stored result so tool data is never polluted by it.
      const reviewNote =
        typeof approvalResponse !== 'boolean' && approvalResponse.source === 'auto-review' && approvalResponse.approved
          ? `Auto-review checked and allowed this action${approvalResponse.risk ? ` (${approvalResponse.risk} risk)` : ''}.`
          : undefined;
      const tagReviewed = <T>(value: T): T => {
        if (reviewNote !== undefined && typeof value === 'object' && value !== null) reviewNotes.set(value, reviewNote);
        return value;
      };
      try {
        await options.onAction?.(request, 'approved');
        await options.onAction?.(request, 'started');
        options.onStart?.(request, toolCallId);
        executionStarted = true;
        const executed = await runWithToolTimeout(timeoutSeconds, options.signal, (signal) =>
          definition.execute(input, signal, {
            timeoutSeconds,
            ...(target === undefined ? {} : { target }),
            ...(options.ask === undefined ? {} : { ask: options.ask }),
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            ...(options.guardWrite === undefined ? {} : { guardWrite: options.guardWrite }),
          }),
        );
        executionCompleted = true;
        // One scrubber for every exit: the model, the transcript, the ledger, and notifications
        // only ever see the redacted result. Media payloads pass through untouched.
        const result = redactToolOutput(executed);
        if (definition.restartAfterExecute?.(result) === true) restartRequested = true;
        const mediaSummary = summarizeImageToolResult(result) ?? summarizeFileToolResult(result) ?? summarizeOwnerInboxToolResult(result);
        if (mediaSummary !== null) {
          await options.onAction?.(request, 'completed', { result: mediaSummary });
          resultRecorded = true;
          reportResult(mediaSummary);
          return tagReviewed(result);
        }
        const serialized = JSON.stringify(result);
        if (serialized === undefined) {
          await options.onAction?.(request, 'completed', { result: null });
          resultRecorded = true;
          reportResult(null);
          return null;
        }
        const bounded =
          serialized.length <= MAX_TOOL_RESULT_CHARS
            ? result
            : { status: 'truncated', resultPreview: serialized.slice(0, MAX_TOOL_RESULT_CHARS), originalChars: serialized.length };
        await options.onAction?.(request, toolOutcome(result), { result: bounded });
        resultRecorded = true;
        reportResult(bounded);
        return tagReviewed(bounded);
      } catch (error) {
        if (resultRecorded) throw error;
        if (error instanceof ToolTimeoutError) {
          const result = { status: 'timed_out', timeoutSeconds, error: error.message };
          try {
            await options.onAction?.(request, 'failed', { result, error: error.message });
          } catch {
            /* Preserve the paired timeout result. */
          }
          reportResult(result);
          return result;
        }
        if (options.signal?.aborted) {
          let cancelled: Record<string, unknown> = { status: 'cancelled', error: 'Execution was stopped by the user.' };
          try {
            await options.onAction?.(request, 'cancelled', { result: cancelled });
          } catch (recordError) {
            cancelled = {
              status: 'cancelled',
              error: `Execution was stopped; cancellation could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
            };
          }
          reportResult(cancelled);
          return cancelled;
        }
        const outcome = executionCompleted
          ? 'The tool ran, but its final result could not be recorded. Inspect the target before retrying.'
          : executionStarted
            ? 'The tool may have partially run. Inspect the target before retrying.'
            : 'The tool was not run.';
        const result = { status: 'error', error: `${outcome} ${error instanceof Error ? error.message : String(error)}` };
        try {
          await options.onAction?.(request, 'failed', { result, error: result.error });
        } catch {
          /* keep the failed tool exchange paired */
        }
        reportResult(result);
        return result;
      }
    };

    for (const definition of this.definitions.values()) {
      if (options.allowTools && !options.allowTools.includes(definition.name)) continue;
      const identity = `${definition.providerId}:${definition.name}`;
      const isMcpTool = definition.providerId.startsWith('mcp-');
      const rawName =
        definition.providerId === 'host'
          ? definition.name
          : isMcpTool
            ? `mcp_${definition.providerId.slice(4)}_${definition.name}`
            : `${definition.providerId}__${definition.name}`;
      const readableName = rawName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      let modelName = readableName;
      if (usedNames.has(modelName) || rawName.length > 64) {
        const prefix = isMcpTool ? 'mcp_' : 'tool_';
        modelName = `${prefix}${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
      }
      if (usedNames.has(modelName)) throw new Error(`Model tool name collision for ${identity}`);
      usedNames.add(modelName);

      const definitionModelOutput = definition.toModelOutput;
      /**
       * Every tool carries a model-output wrapper so a review note can ride
       * along as trailing text. Without a note it reproduces the SDK default
       * exactly (`{type:'json'}` keeps the raw object by reference), so
       * untagged results cost nothing extra; only a reviewed allow becomes
       * text with the note appended.
       */
      const toModelOutput = async ({ output }: { output: unknown }): Promise<ToolResultOutput> => {
        const base = definitionModelOutput ? await definitionModelOutput(output) : undefined;
        const note = typeof output === 'object' && output !== null ? reviewNotes.get(output) : undefined;
        if (base !== undefined) {
          if (note !== undefined && isTextOutput(base)) return { type: 'text', value: `${base.value}\n\n${note}` };
          return base;
        }
        if (isTextOutput(output)) return note !== undefined ? { type: 'text', value: `${output.value}\n\n${note}` } : output;
        if (note === undefined) return { type: 'json', value: (output === undefined ? null : output) as JSONValue };
        const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? String(output));
        return { type: 'text', value: `${text}\n\n${note}` };
      };
      modelTools[modelName] = tool({
        description: `${definition.description}\nSource: ${definition.providerId}/${definition.name}. Declared effects: ${JSON.stringify(definition.effect)}.`,
        inputSchema: jsonSchema<Record<string, unknown>>(withToolTimeoutSchema(definition.inputSchema) as Parameters<typeof jsonSchema>[0]),
        onInputStart: ({ toolCallId }) => {
          try {
            options.preview?.onStart?.({ toolCallId, providerId: definition.providerId, name: definition.name });
          } catch {
            /* previews never affect execution */
          }
        },
        onInputDelta: ({ toolCallId, inputTextDelta }) => {
          try {
            options.preview?.onDelta?.({ toolCallId, inputTextDelta });
          } catch {
            /* previews never affect execution */
          }
        },
        onInputAvailable: ({ toolCallId, input }) => {
          try {
            options.preview?.onAvailable?.({ toolCallId, input: (input ?? {}) as Record<string, unknown> });
          } catch {
            /* previews never affect execution */
          }
        },
        execute: (input, execOptions) => {
          const current = queue.then(() => execute(definition, input, execOptions?.toolCallId));
          queue = current.then(
            () => undefined,
            () => undefined,
          );
          return current;
        },
        toModelOutput,
      });
    }

    return {
      tools: modelTools as unknown as ToolSet,
      shouldStop: () => stopped || restartRequested,
      shouldRestart: () => restartRequested,
    };
  }
}

function isTextOutput(value: unknown): value is { type: 'text'; value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).type === 'text' &&
    typeof (value as Record<string, unknown>).value === 'string'
  );
}

function toolOutcome(result: unknown): ToolActionState {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (record.status === 'cancelled') return 'cancelled';
    if (
      record.status === 'timed_out' ||
      record.status === 'failed' ||
      record.status === 'error' ||
      (typeof record.exitCode === 'number' && record.exitCode !== 0)
    )
      return 'failed';
  }
  return 'completed';
}
