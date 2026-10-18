import type { ToolDefinition } from './registry.js';

export const SUBAGENT_MODES = ['explorer', 'executor'] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

const subagentEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

const MAX_TASK_CHARS = 8_000;
const MAX_NOTE_CHARS = 20_000;
const MAX_CONTEXT_PATHS = 50;

export interface SubagentRequest {
  task: string;
  mode: SubagentMode;
  /** false = the parent waits and receives the report here; true = the worker keeps running and reports back when done. */
  background: boolean;
  context: { paths: string[]; notes?: string };
}

/**
 * The subagent tool: the parent session starts one worker, either waiting for
 * its final message (foreground) or returning at once while the worker keeps
 * running in the background and reports back when it finishes. The rules —
 * depth limit, mode tool sets, MCP exclusion — are enforced by the host; this
 * module validates input and passes the caller's session id through.
 */
export function createSubagentTool(
  spawn: (request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'subagent',
    description: `Run one bounded task in a separate worker session. The worker sees only what you pass here — the task and optional context paths/notes — never this conversation, so write the task for a stranger. For background workers, specify meaningful milestones, dependencies, and when to report progress or a blocker with parent_message. You must choose the worker type: mode "explorer" gets read-only tools (file_read, glob, grep, memory_search, session_list/search/read) and can never change the machine; mode "executor" gets the normal core tools (also file_write, file_edit, execute_command). You must also choose the run shape: background: false waits here and returns the worker's last assistant message as the report; background: true returns immediately with the worker's session id — the worker keeps running, may leave interim notes for you with parent_message, and its final message is available through inbox when it finishes. Completion or failure adds an inbox notification and emits a short host notice that resumes this parent when idle or reaches it at a safe step boundary while busy. Explicit owner stops are respected. Use inbox to retrieve the report or read the notificationId returned by this call to check quiet progress; the report is not injected automatically. Polling earlier is allowed and suppresses an obsolete signal after the result is saved. Workers cannot ask the user directly, cannot approve anything, and cannot use MCP tools; a background worker can raise a material question to its parent with parent_message, while a foreground worker must include blockers in its report. Worker sessions are saved and readable with session_read. Worker runs have no separate step or time budget; foreground waits still obey the host tool-call deadline. Keep tasks focused; an executor worker may start its own child workers (one extra layer), an explorer may not. Running workers are capped (8 per parent session, 2 per worker parent, 10 per machine) and only one running worker may write a given file at a time; a call over a cap returns busy — read inbox or stop a running worker first.`,
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: `Bounded objective, relevant context, constraints, ownership, expected result, and verification for a worker who cannot see this conversation. Delegation does not expand user authorization. At most ${MAX_TASK_CHARS} characters.`,
        },
        mode: {
          type: 'string',
          enum: [...SUBAGENT_MODES],
          description:
            '"explorer" = read-only worker (research only, cannot write or run commands); "executor" = worker with the normal core file and command tools. Required: choose one every time.',
        },
        background: {
          type: 'boolean',
          description:
            'Required. false = wait here and receive the report as this call’s result; true = start the worker and return at once, it keeps running and reports back when it finishes.',
        },
        context: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: `Files or directories the worker should read first (at most ${MAX_CONTEXT_PATHS}).`,
            },
            notes: { type: 'string', description: 'Decisions, constraints, or definitions the worker cannot infer.' },
          },
          additionalProperties: false,
        },
      },
      required: ['task', 'mode', 'background'],
      additionalProperties: false,
    },
    effect: subagentEffect,
    autoApprove: () => true,
    execute: async (input, signal, context) => {
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (!task || task.length > MAX_TASK_CHARS) {
        return { status: 'invalid', error: `task must be non-empty and at most ${MAX_TASK_CHARS} characters.` };
      }
      const mode: SubagentMode | null = input.mode === 'explorer' ? 'explorer' : input.mode === 'executor' ? 'executor' : null;
      if (mode === null) return { status: 'invalid', error: 'mode must be "explorer" or "executor"; there is no default.' };
      if (typeof input.background !== 'boolean') {
        return { status: 'invalid', error: 'background must be true or false; there is no default.' };
      }
      const rawContext = input.context;
      const paths: string[] = [];
      let notes: string | undefined;
      if (rawContext !== undefined) {
        if (rawContext === null || typeof rawContext !== 'object' || Array.isArray(rawContext)) {
          return { status: 'invalid', error: 'context must be an object with optional paths and notes.' };
        }
        const record = rawContext as Record<string, unknown>;
        if (record.paths !== undefined) {
          if (
            !Array.isArray(record.paths) ||
            record.paths.length > MAX_CONTEXT_PATHS ||
            record.paths.some((path) => typeof path !== 'string')
          ) {
            return { status: 'invalid', error: `context.paths must be an array of at most ${MAX_CONTEXT_PATHS} strings.` };
          }
          paths.push(...(record.paths as string[]));
        }
        if (record.notes !== undefined) {
          if (typeof record.notes !== 'string' || record.notes.length > MAX_NOTE_CHARS) {
            return { status: 'invalid', error: `context.notes must be a string of at most ${MAX_NOTE_CHARS} characters.` };
          }
          notes = record.notes;
        }
      }
      try {
        return await spawn(
          { task, mode, background: input.background === true, context: { paths, ...(notes === undefined ? {} : { notes }) } },
          context?.sessionId,
          signal,
        );
      } catch (error) {
        return {
          status: 'error',
          error: `The subagent could not run: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
