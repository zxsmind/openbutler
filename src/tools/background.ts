import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ActivityLedger, ObservedEventInput } from '../activity-ledger.js';
import type { BackgroundTaskState } from '../settings.js';
import type { ToolDefinition, ToolEffect } from './registry.js';

export const backgroundCapabilities = [
  { adapter: 'manual', description: 'Run only on an explicit request; no automatic observations.', options: {} },
  { adapter: 'interval', description: 'Run a user task at a recurring interval.', options: { everySeconds: 'integer, 10-31536000' } },
  { adapter: 'at', description: 'Run once at an absolute date/time.', options: { at: 'ISO 8601 timestamp including timezone' } },
  {
    adapter: 'filesystem',
    description: 'Observe metadata changes in an explicitly selected file or directory; file content is not collected.',
    options: { path: 'absolute path', recursive: 'optional boolean, default true', debounceSeconds: 'optional integer, 1-60, default 5' },
  },
  {
    adapter: 'memory_pressure',
    description: 'Observe a sustained free-memory threshold only when this task is explicitly added.',
    options: {
      usedPercent: 'integer, 50-99',
      sampleSeconds: 'optional integer, 10-3600, default 30',
      durationSeconds: 'optional integer, 10-86400, default 60',
    },
  },
] as const;

export interface BackgroundTaskStatus {
  id: string;
  state: 'active' | 'disabled' | 'completed' | 'error';
  error?: string;
}

interface AdapterOutcome {
  stop: () => void;
  /** Initial status for the host; defaults to `active` when the adapter keeps running. */
  state?: BackgroundTaskStatus['state'];
}

type AdapterStart = (
  task: BackgroundTaskState,
  emit: (kind: string, facts: Record<string, unknown>, key: string) => Promise<void>,
) => AdapterOutcome;

/** Owns trigger lifetimes. Tasks, instructions, and model runs remain owned by the host. */
export class BackgroundTaskRunner {
  private readonly stops = new Map<string, () => void>();
  private readonly statuses = new Map<string, BackgroundTaskStatus>();
  private readonly adapters = new Map<string, AdapterStart>();
  private reloadChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(
    private readonly ledger: ActivityLedger,
    private readonly publish: (event: ObservedEventInput) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {
    this.adapters.set('manual', () => ({ stop: () => {} }));
    this.adapters.set('interval', (task, emit) => this.startInterval(task, emit));
    this.adapters.set('at', (task, emit) => this.startAt(task, emit));
    this.adapters.set('filesystem', (task, emit) => this.startFilesystem(task, emit));
    this.adapters.set('memory_pressure', (task, emit) => this.startMemoryPressure(task, emit));
  }

  reload(tasks: BackgroundTaskState[]): Promise<void> {
    const reload = this.reloadChain.then(() => {
      if (this.shuttingDown) return;
      this.close();
      for (const task of tasks) {
        if (!task.enabled) {
          this.statuses.set(task.id, { id: task.id, state: 'disabled' });
          continue;
        }
        try {
          validateBackgroundTrigger(task.trigger);
          const start = this.adapters.get(task.trigger.adapter)!;
          const outcome = start(task, async (kind, facts, key) => {
            await this.publish({
              source: `task:${task.trigger.adapter}`,
              kind,
              dedupeKey: `task:${task.id}:${key}`,
              workspaceRoot: task.workspaceRoot,
              payload: { taskId: task.id, facts },
            });
          });
          this.stops.set(task.id, outcome.stop);
          this.statuses.set(task.id, { id: task.id, state: outcome.state ?? 'active' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.statuses.set(task.id, { id: task.id, state: 'error', error: message });
          this.log(`Background task ${task.id}: ${message}`);
        }
      }
    });
    this.reloadChain = reload.catch(() => {});
    return reload;
  }

  listStatuses(): BackgroundTaskStatus[] {
    return [...this.statuses.values()];
  }

  close(): void {
    for (const stop of this.stops.values()) stop();
    this.stops.clear();
    this.statuses.clear();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.reloadChain;
    this.close();
  }

  private startInterval(task: BackgroundTaskState, emit: Parameters<AdapterStart>[1]): AdapterOutcome {
    const seconds = task.trigger.options.everySeconds as number;
    const stateKey = triggerStateKey(task, 'due');
    const stored = Number(this.ledger.getState(stateKey));
    let due = stored > 0 ? stored : Date.now() + seconds * 1000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (stopped) return;
      timer = setTimeout(
        () => {
          void fire();
        },
        Math.min(2_147_483_647, Math.max(0, due - Date.now())),
      );
      timer.unref?.();
    };
    const fire = async () => {
      if (stopped) return;
      if (due > Date.now()) {
        arm();
        return;
      }
      try {
        await emit('schedule.interval', { scheduledAt: new Date(due).toISOString() }, String(due));
        if (stopped) return;
        // Missed intervals coalesce into one wakeup after a host restart.
        due = Date.now() + seconds * 1000;
        this.ledger.setState(stateKey, String(due));
      } catch (error) {
        this.log(`Background task ${task.id}: ${String(error)}`);
        due = Date.now() + Math.min(seconds, 30) * 1000;
      }
      arm();
    };
    this.ledger.setState(stateKey, String(due));
    arm();
    return {
      stop: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  private startAt(task: BackgroundTaskState, emit: Parameters<AdapterStart>[1]): AdapterOutcome {
    const due = Date.parse(task.trigger.options.at as string);
    const stateKey = triggerStateKey(task, 'fired');
    if (this.ledger.getState(stateKey) === 'true') return { stop: () => {}, state: 'completed' };
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (stopped) return;
      timer = setTimeout(
        () => {
          void fire();
        },
        Math.min(2_147_483_647, Math.max(0, due - Date.now())),
      );
      timer.unref?.();
    };
    const fire = async () => {
      if (stopped) return;
      if (due > Date.now()) {
        arm();
        return;
      }
      try {
        await emit('schedule.at', { scheduledAt: new Date(due).toISOString() }, String(due));
        if (!stopped) this.ledger.setState(stateKey, 'true');
      } catch (error) {
        this.log(`Background task ${task.id}: ${String(error)}`);
        if (!stopped) {
          timer = setTimeout(() => {
            void fire();
          }, 30_000);
          timer.unref?.();
        }
      }
    };
    arm();
    return {
      stop: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  private startFilesystem(task: BackgroundTaskState, emit: Parameters<AdapterStart>[1]): AdapterOutcome {
    const path = realpathSync(task.trigger.options.path as string);
    const isDirectory = statSync(path).isDirectory();
    const recursive = isDirectory && task.trigger.options.recursive !== false;
    const debounceMs = ((task.trigger.options.debounceSeconds as number | undefined) ?? 5) * 1000;
    const changes = new Map<string, { event: string; path: string }>();
    let overflow = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const watcher: FSWatcher = watch(path, { recursive }, (event, filename) => {
      if (stopped) return;
      const changedPath = filename ? join(isDirectory ? path : dirname(path), filename.toString()) : path;
      if (changes.size < 100) changes.set(changedPath, { event, path: changedPath });
      else overflow = true;
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (stopped) return;
        const facts = { root: path, changes: [...changes.values()], overflow };
        changes.clear();
        overflow = false;
        void emit('filesystem.changed', facts, randomUUID()).catch((error: unknown) =>
          this.log(`Background task ${task.id}: ${String(error)}`),
        );
      }, debounceMs);
      timer.unref?.();
    });
    watcher.on('error', (error) => {
      this.statuses.set(task.id, { id: task.id, state: 'error', error: error.message });
      this.log(`Background task ${task.id}: ${error.message}`);
    });
    return {
      stop: () => {
        stopped = true;
        watcher.close();
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  private startMemoryPressure(task: BackgroundTaskState, emit: Parameters<AdapterStart>[1]): AdapterOutcome {
    const threshold = task.trigger.options.usedPercent as number;
    const sampleMs = ((task.trigger.options.sampleSeconds as number | undefined) ?? 30) * 1000;
    const durationMs = ((task.trigger.options.durationSeconds as number | undefined) ?? 60) * 1000;
    let exceededAt: number | null = null;
    let incidentId: string | null = null;
    const timer = setInterval(() => {
      const totalBytes = totalmem();
      const freeBytes = freemem();
      const usedPercent = totalBytes > 0 ? (1 - freeBytes / totalBytes) * 100 : 0;
      if (usedPercent >= threshold) {
        exceededAt ??= Date.now();
        if (incidentId === null && Date.now() - exceededAt >= durationMs) {
          incidentId = randomUUID();
          void emit('system.memory_pressure', { totalBytes, freeBytes, usedPercent, threshold }, incidentId).catch((error: unknown) =>
            this.log(String(error)),
          );
        }
      } else if (usedPercent < threshold - 5) {
        exceededAt = null;
        if (incidentId !== null) {
          const recoveredId = incidentId;
          incidentId = null;
          void emit('system.memory_recovered', { totalBytes, freeBytes, usedPercent, threshold }, `${recoveredId}:recovered`).catch(
            (error: unknown) => this.log(String(error)),
          );
        }
      }
    }, sampleMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }
}

export function validateBackgroundTrigger(trigger: BackgroundTaskState['trigger']): void {
  const options = trigger.options;
  const allowed: Record<string, string[]> = {
    manual: [],
    interval: ['everySeconds'],
    at: ['at'],
    filesystem: ['path', 'recursive', 'debounceSeconds'],
    memory_pressure: ['usedPercent', 'sampleSeconds', 'durationSeconds'],
  };
  const fields = allowed[trigger.adapter];
  if (!fields) throw new Error(`Unknown background trigger adapter: ${trigger.adapter}`);
  for (const key of Object.keys(options)) if (!fields.includes(key)) throw new Error(`${trigger.adapter}.${key} is not a trigger option.`);
  if (trigger.adapter === 'interval') requireInteger(options.everySeconds, 'everySeconds', 10, 31_536_000);
  if (trigger.adapter === 'at') {
    if (typeof options.at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(options.at) || !Number.isFinite(Date.parse(options.at)))
      throw new Error('at must be an ISO timestamp including a timezone.');
  }
  if (trigger.adapter === 'filesystem') {
    if (typeof options.path !== 'string' || !isAbsolute(options.path)) throw new Error('filesystem.path must be an absolute path.');
    if (options.recursive !== undefined && typeof options.recursive !== 'boolean')
      throw new Error('filesystem.recursive must be a boolean.');
    if (options.debounceSeconds !== undefined) requireInteger(options.debounceSeconds, 'debounceSeconds', 1, 60);
  }
  if (trigger.adapter === 'memory_pressure') {
    requireInteger(options.usedPercent, 'usedPercent', 50, 99);
    if (options.sampleSeconds !== undefined) requireInteger(options.sampleSeconds, 'sampleSeconds', 10, 3600);
    if (options.durationSeconds !== undefined) requireInteger(options.durationSeconds, 'durationSeconds', 10, 86400);
  }
}

export function createBackgroundManagementTool(
  workspaceRoot: string,
  execute: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>,
): ToolDefinition {
  const readEffect: ToolEffect = { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' };
  return {
    providerId: 'host',
    name: 'background_manage',
    maxInputChars: 32_000,
    description: `Manage user-requested durable background tasks. No tasks run by default. Actions: capabilities, list, add, update, remove, enable, disable, run. A task contains id, name, instruction, workspaceRoot, enabled, and trigger {adapter, options}. Available trigger adapters: ${JSON.stringify(backgroundCapabilities)}. Use add/update only for an explicit user request. Use send_message_to_owner to report a material finding from background work.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['capabilities', 'list', 'add', 'update', 'remove', 'enable', 'disable', 'run'] },
        taskId: { type: 'string' },
        task: { type: 'object' },
      },
    },
    effect: { ...readEffect, change: 'modify' },
    assess: (input) =>
      input.action === 'list' || input.action === 'capabilities'
        ? readEffect
        : { ...readEffect, change: input.action === 'remove' ? 'delete' : 'modify' },
    autoApprove: (input) => input.action === 'list' || input.action === 'capabilities',
    execute: (input) => execute(input, workspaceRoot),
  };
}

function triggerStateKey(task: BackgroundTaskState, suffix: string): string {
  return `task:${task.id}:${createHash('sha256').update(JSON.stringify(task.trigger)).digest('hex').slice(0, 16)}:${suffix}`;
}

function requireInteger(value: unknown, name: string, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
}
