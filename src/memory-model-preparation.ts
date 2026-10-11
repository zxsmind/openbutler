import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProgressCallback, ProgressInfo } from '@huggingface/transformers';
import { prepareMemoryEmbeddingModel } from './memory-index.js';

type WorkerMessage = { type: 'progress'; progress: ProgressInfo } | { type: 'done' } | { type: 'error'; message: string };

export interface MemoryModelPreparationOptions {
  onProgress?: ProgressCallback;
  /** A failed attempt is only retried after this cooldown, so tools never hammer a broken download. */
  retryCooldownMs?: number;
}

export interface MemoryModelPreparationStatus {
  state: 'preparing' | 'failed' | 'idle';
  error?: string;
}

const DEFAULT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

let activePreparation: Promise<void> | undefined;
let lastFailure: string | undefined;
let lastAttemptAt = 0;

/** In-process preparation state; readiness itself stays a filesystem check in memory-index. */
export function memoryModelPreparationStatus(): MemoryModelPreparationStatus {
  if (activePreparation) return { state: 'preparing' };
  if (lastFailure) return { state: 'failed', error: lastFailure };
  return { state: 'idle' };
}

/**
 * Starts the background preparation once per process and retries a failed
 * attempt only after the cooldown. Returns immediately so callers can report
 * `model_preparing` instead of waiting for a first-time download.
 */
export function ensureMemoryModelPreparation(options: MemoryModelPreparationOptions = {}): MemoryModelPreparationStatus {
  if (activePreparation) return { state: 'preparing' };
  const cooldown = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
  if (lastFailure && Date.now() - lastAttemptAt < cooldown) return { state: 'failed', error: lastFailure };
  lastAttemptAt = Date.now();
  activePreparation = prepareMemoryEmbeddingModelInChild(options.onProgress)
    .then(
      () => {
        lastFailure = undefined;
      },
      (error: unknown) => {
        lastFailure = error instanceof Error ? error.message : String(error);
      },
    )
    .finally(() => {
      activePreparation = undefined;
    });
  return { state: 'preparing' };
}

/** Keep setup's ONNX libraries and allocation pages out of a subsequent TUI. */
export function prepareMemoryEmbeddingModelInChild(onProgress?: ProgressCallback): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--memory-model-worker'], { silent: true, windowsHide: true });
    let done = false;
    let errorMessage = '';
    let stderr = '';
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      child.kill();
    };
    process.once('SIGINT', interrupt);
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_192);
    });
    child.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') onProgress?.(message.progress);
      else if (message.type === 'done') done = true;
      else if (message.type === 'error') errorMessage = message.message;
    });
    child.once('error', (error) => {
      process.removeListener('SIGINT', interrupt);
      reject(error);
    });
    child.once('exit', (code) => {
      process.removeListener('SIGINT', interrupt);
      if (interrupted) {
        const error = new Error('Local memory model preparation was cancelled.');
        error.name = 'AbortPromptError';
        reject(error);
      } else if (done && code === 0) {
        resolve();
      } else {
        reject(new Error(errorMessage || stderr.trim() || `Memory model preparation exited with code ${code}.`));
      }
    });
  });
}

if (process.send && process.argv[2] === '--memory-model-worker') {
  const send = (message: WorkerMessage): Promise<void> =>
    new Promise((resolve) => {
      process.send!(message, () => resolve());
    });
  let exitCode = 0;
  try {
    await prepareMemoryEmbeddingModel({ onProgress: (progress) => void send({ type: 'progress', progress }) });
    await send({ type: 'done' });
  } catch (error) {
    exitCode = 1;
    await send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    process.disconnect();
    // The ONNX runtime keeps native threads alive after the work is done. Exit explicitly once the
    // final message is delivered so the parent's 'exit' handler always runs.
    process.exit(exitCode);
  }
}
