import { createHash, randomUUID } from 'node:crypto';
import type { ToolSet } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { summarizeFileToolResult, summarizeImageToolResult } from '../image.js';
import { redactToolOutput } from '../sensitive-data.js';
import type { ToolActionState } from '../activity-ledger.js';
import type { ApprovalMode } from '../settings.js';
import type { WorkspaceScope } from '../workspace-scope.js';

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
  /** Only offered inside a worker tool set (`allowTools`); hidden from ordinary sessions. */
  workerOnly?: boolean;
  effect: ToolEffect;
  /**
   * Resolves the concrete execution target (typically a canonical filesystem path)
   * once, before the permission decision. The same value reaches `assess`,
   * `autoApprove`, `workspaceScope` and `execute`, so approval and execution act on
   * one resolution instead of each re-resolving the input.
   */
  resolveTarget?: (input: Record<string, unknown>) => string | null;
  assess?: (input: Record<string, unknown>, target?: string) => ToolEffect;
  autoApprove?: (input: Record<string, unknown>, target?: string) => boolean;
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
}

export interface ToolApprovalOutcome {
  approved: boolean;
  /** Reviewer rejections return to the model so it can choose a safer action. */
  source: 'auto-review';
  reason: string;
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

    const execute = async (definition: ToolDefinition, input: Record<string, unknown>, toolCallId?: string): Promise<unknown> => {
      if (options.signal?.aborted) return { status: 'cancelled', error: 'The run was stopped by the user.' };
      if (stopped) return { status: 'denied', error: 'A previous tool call was declined; this agent run has stopped.' };
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return { status: 'rejected', error: 'Tool input must be an object.' };
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
      const request = { requestId: randomUUID(), providerId: definition.providerId, name: definition.name, input, effect };
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
      let autoApproved: boolean;
      try {
        autoApproved =
          options.approvalMode === 'full-access' ||
          (options.allowToolAutoApproval !== false && definition.autoApprove?.(input, target) === true) ||
          ((options.approvalMode === 'workspace' || options.approvalMode === 'auto-review') && scope === 'workspace') ||
          options.autoApprove?.(request) === true;
      } catch (error) {
        return failClosed(`Tool approval policy failed; the tool was not run: ${error instanceof Error ? error.message : String(error)}`);
      }
      let approvalResponse: ToolApprovalResponse = autoApproved;
      try {
        if (!autoApproved) approvalResponse = await options.approve(request, options.signal);
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
        const autoReviewDenied = typeof approvalResponse !== 'boolean' && approvalResponse.source === 'auto-review';
        if (!autoReviewDenied) stopped = true;
        let result: Record<string, unknown> = autoReviewDenied
          ? {
              status: 'denied',
              error: `Auto-review denied this exact action: ${typeof approvalResponse === 'boolean' ? '' : approvalResponse.reason} Do not retry it, change its wording, or switch tools to bypass the decision. Only propose a materially safer alternative or ask the user.`,
            }
          : { status: 'denied', error: 'The user declined this tool call. It was not run.' };
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
      try {
        await options.onAction?.(request, 'approved');
        await options.onAction?.(request, 'started');
        options.onStart?.(request, toolCallId);
        executionStarted = true;
        const executed = await definition.execute(
          input,
          options.signal,
          target === undefined && options.ask === undefined && options.sessionId === undefined && options.guardWrite === undefined
            ? undefined
            : {
                ...(target === undefined ? {} : { target }),
                ...(options.ask === undefined ? {} : { ask: options.ask }),
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                ...(options.guardWrite === undefined ? {} : { guardWrite: options.guardWrite }),
              },
        );
        executionCompleted = true;
        // One scrubber for every exit: the model, the transcript, the ledger, and notifications
        // only ever see the redacted result. Media payloads pass through untouched.
        const result = redactToolOutput(executed);
        if (definition.restartAfterExecute?.(result) === true) restartRequested = true;
        const mediaSummary = summarizeImageToolResult(result) ?? summarizeFileToolResult(result);
        if (mediaSummary !== null) {
          await options.onAction?.(request, 'completed', { result: mediaSummary });
          resultRecorded = true;
          reportResult(mediaSummary);
          return result;
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
        return bounded;
      } catch (error) {
        if (resultRecorded) throw error;
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
      if (definition.workerOnly === true && !options.allowTools) continue;
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

      const toModelOutput = definition.toModelOutput;
      modelTools[modelName] = tool({
        description: `${definition.description}\nSource: ${definition.providerId}/${definition.name}. Declared effects: ${JSON.stringify(definition.effect)}.`,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
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
        ...(toModelOutput ? { toModelOutput: ({ output }: { output: unknown }) => toModelOutput(output) } : {}),
      });
    }

    return {
      tools: modelTools as unknown as ToolSet,
      shouldStop: () => stopped || restartRequested,
      shouldRestart: () => restartRequested,
    };
  }
}

function toolOutcome(result: unknown): ToolActionState {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (record.status === 'cancelled') return 'cancelled';
    if (record.status === 'failed' || record.status === 'error' || (typeof record.exitCode === 'number' && record.exitCode !== 0))
      return 'failed';
  }
  return 'completed';
}
