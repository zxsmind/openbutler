import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { cliNodeArgs } from './cli-entry.js';
import { createDaemonHost } from './daemon-host.js';
import { createLogger, fileSink } from './logging.js';
import { DAEMON_PROTOCOL_VERSION, MAX_DAEMON_FRAME_BYTES, type DaemonStatus } from './daemon-protocol.js';
import { getDataDir, getDataPath } from './paths.js';
import { withDeadline } from './shutdown.js';

const DAEMON_START_TIMEOUT_MS = 20_000;
const DAEMON_START_LOCK_WAIT_MS = 30_000;
// A 45s heartbeat lease reclaims crashed hosts without platform-specific mutex code.
const DAEMON_START_LOCK_STALE_MS = 45_000;
const DAEMON_START_LOCK_HEARTBEAT_MS = 10_000;
const DAEMON_REQUEST_TIMEOUT_MS = 5_000;
/** The IPC listener closes within this long before the process stops caring about it. */
const IPC_CLOSE_TIMEOUT_MS = 2_000;
const PREVIOUS_DAEMON_PROTOCOL_VERSION = 1;
const execFileAsync = promisify(execFile);

type DaemonStartLock = {
  path: string;
  fd: number;
  token: string;
  startedAt: string;
  heartbeat: ReturnType<typeof setInterval>;
};

type BasicRequestAction = string;
type BasicResponse = {
  version: number;
  id: string;
  ok: boolean;
  result?: unknown;
  status?: unknown;
  stopping?: boolean;
  error?: string;
};

export { type DaemonStatus };

export function getDaemonEndpoint(): string {
  const directory = resolve(getDataDir());
  if (process.platform === 'win32') {
    const suffix = createHash('sha256').update(directory.toLocaleLowerCase('en-US')).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\openbutler-${suffix}`;
  }
  return join(directory, 'daemon.sock');
}

export async function getDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    const response = await requestDaemon('status');
    if (response.ok && isDaemonStatus(response.result)) return response.result;
    const status = legacyStatusFromResponse(response);
    if (status) return status;
  } catch {
    /* probe the previous protocol before assuming no host is running */
  }

  if (DAEMON_PROTOCOL_VERSION > PREVIOUS_DAEMON_PROTOCOL_VERSION) {
    try {
      const response = await requestDaemon('status', {}, DAEMON_REQUEST_TIMEOUT_MS, PREVIOUS_DAEMON_PROTOCOL_VERSION);
      if (response.ok && isDaemonStatus(response.result)) return { ...response.result, legacy: true };
      const status = legacyStatusFromResponse(response);
      if (status) return status;
    } catch {
      /* no compatible earlier host */
    }
  }
  const record = readDaemonPidRecord();
  if (record && processIsAlive(record.pid)) {
    return { pid: record.pid, startedAt: record.startedAt, workspaceCount: 0, connectedClients: 0, unresponsive: true };
  }
  return null;
}

/** The host entry decides its code vintage: a `.ts`/`.tsx` entry runs the source tree, anything else runs a built bundle. */
export function hostVintage(entry: string | undefined | null): 'source' | 'dist' | 'unknown' {
  if (!entry) return 'unknown';
  return /\.tsx?$/i.test(entry) ? 'source' : 'dist';
}

/**
 * A client and a host built from different code behave differently while looking
 * identical, so the skew is named once when a client attaches.
 */
export function hostVintageMismatchWarning(clientEntry: string | undefined | null, hostEntry: string | undefined | null): string | null {
  const client = hostVintage(clientEntry);
  const host = hostVintage(hostEntry);
  if (client === 'unknown' || host === 'unknown' || client === host) return null;
  const label = (kind: 'source' | 'dist') => (kind === 'source' ? 'source (tsx)' : 'a built bundle');
  return `Code vintage mismatch: this client runs ${label(client)} but the background host runs ${label(host)}. Run \`openbutler restart\` here to relaunch the host from this client.`;
}

/**
 * A client attaches to a running host; only the daemon commands may start one.
 * The friendly failure replaces the silent auto-start clients used to do, so the
 * boot verb stays visible and its code vintage stays deliberate.
 */
export async function requireBackgroundHost(): Promise<DaemonStatus> {
  const status = await getDaemonStatus();
  if (!status) throw new Error('The background host is not running. Start it with `openbutler daemon start`.');
  if (status.legacy)
    throw new Error('An older OpenButler host is still running. Stop it with `openbutler daemon stop`, then start OpenButler again.');
  if (status.unresponsive)
    throw new Error(`The background host process ${status.pid} does not answer IPC health checks. Recover it with \`openbutler restart\`.`);
  return status;
}

export async function requestHost(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const response = await requestDaemon(action, payload, 45_000);
  if (!response.ok) throw new Error(response.error ?? 'OpenButler host request failed.');
  return response.result;
}

export async function startDaemon(_legacyWorkspaceScope?: string): Promise<DaemonStatus> {
  const active = await getDaemonStatus();
  if (active?.legacy)
    throw new Error('An older OpenButler host is still running. Stop it with `openbutler daemon stop`, then start OpenButler again.');
  if (active?.unresponsive)
    throw new Error(
      `OpenButler host process ${active.pid} is alive but does not answer IPC health checks. Recover it with \`openbutler restart\`.`,
    );
  if (active) return active;

  const entry = process.argv[1];
  if (!entry) throw new Error('Could not locate the OpenButler CLI entry point.');
  const dataDirectory = getDataDir();
  const custodianDirectory = getDataPath('custodian');
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(custodianDirectory, { recursive: true });
  const logPath = getDataPath('daemon.log');
  const logFd = openSync(logPath, 'a', 0o600);
  const logOffset = fstatSync(logFd).size;
  const args = cliNodeArgs(entry, ['daemon', 'run']);
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: custodianDirectory,
      env: {
        ...process.env,
        OPENBUTLER_DAEMON_CHILD: '1',
      },
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }

  let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
  });

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('error', rejectSpawn);
    child.once('spawn', () => resolveSpawn());
  });
  child.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus();
    if (status && !status.unresponsive) return status;
    if (childExit) {
      const logTail = readDaemonLogSince(logPath, logOffset);
      const { code, signal } = childExit;
      throw new Error(
        `OpenButler host process exited before becoming ready${code === null ? ` (${signal ?? 'unknown signal'})` : ` (exit code ${code})`}.${logTail ? `\n${logTail}` : ''}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const logTail = readDaemonLogSince(logPath, logOffset);
  throw new Error(
    `OpenButler host did not become ready within ${DAEMON_START_TIMEOUT_MS / 1_000} seconds.${logTail ? `\n${logTail}` : ''}`,
  );
}

export async function stopDaemon(restarting = false): Promise<boolean> {
  const active = await getDaemonStatus();
  if (!active) return false;
  if (!active.unresponsive) {
    const protocolVersion = active.legacy ? PREVIOUS_DAEMON_PROTOCOL_VERSION : DAEMON_PROTOCOL_VERSION;
    try {
      const response = await requestDaemon('stop', restarting ? { restart: true } : {}, DAEMON_REQUEST_TIMEOUT_MS, protocolVersion);
      if (!response.ok) throw new Error(response.error ?? 'The OpenButler host could not stop.');
    } catch (error) {
      const status = await getDaemonStatus();
      if (status?.pid === active.pid && !status.unresponsive) throw error;
    }
  }

  // A reconnecting client may already have started the replacement host.
  if (await waitForProcessExit(active.pid, 30_000)) return true;
  const record = readDaemonPidRecord();
  const liveIdentity = await readProcessIdentity(active.pid);
  const liveCommand = await readProcessCommandLine(active.pid);
  const recordMatches =
    Boolean(record?.identity) && record?.pid === active.pid && record.startedAt === active.startedAt && liveIdentity === record?.identity;
  // A pid file can only describe one host, and a restart that raced a slow
  // shutdown leaves several alive. The process itself is the authority: a live
  // openbutler host is safe to terminate even when the file talks about its sibling.
  const isOpenButlerHost = Boolean(liveCommand && /daemon\s+run/.test(liveCommand) && /cli\.(?:js|ts)/.test(liveCommand));
  if (!recordMatches && !isOpenButlerHost) {
    throw new Error(
      `OpenButler host process ${active.pid} did not stop. Its process identity cannot be verified, so it was not terminated.`,
    );
  }
  console.error(
    `OpenButler host process ${active.pid} did not finish shutdown within 30 seconds; terminating the verified host. Only the last saved session state can be recovered. Per-step shutdown timings are in logs/openbutler.log, on lines starting with "[shutdown]".`,
  );
  try {
    process.kill(active.pid, 'SIGKILL');
  } catch (error) {
    if (processIsAlive(active.pid)) throw error;
  }
  if (await waitForProcessExit(active.pid, 5_000)) return true;
  throw new Error(`OpenButler host process ${active.pid} could not be terminated.`);
}

export type RestartOutcome = { status: DaemonStatus; web: WebPidRecord | null; webFailure: string | null };

/**
 * Restarts the background host and, when a tracked browser server is running,
 * that server too: both children share one code vintage, so recycling only the
 * host would leave the browser client serving the previous build. The host
 * result stays authoritative; a web child that fails to return is reported
 * instead of thrown, because the host is already running again.
 */
export async function restartDaemon(_legacyWorkspaceScope?: string): Promise<RestartOutcome> {
  const previousWeb = readWebPidRecord();
  await stopWebProcess();
  await stopDaemon(true);
  const status = await startDaemon();
  if (!previousWeb) return { status, web: null, webFailure: null };
  try {
    return {
      status,
      web: await startWebProcess(process.argv[1], previousWeb.port, previousWeb.host, previousWeb.dir ?? process.cwd()),
      webFailure: null,
    };
  } catch (error) {
    return { status, web: null, webFailure: error instanceof Error ? error.message : String(error) };
  }
}

/** The optional web server `openbutler daemon start --web` opens: its own pid record so stop reaches it. */
function webPidPath(): string {
  return getDataPath('web.pid');
}

export type WebPidRecord = { pid: number; startedAt: string; port: number; host: string; dir?: string };

function readWebPidRecord(): WebPidRecord | null {
  const path = webPidPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(raw) as Partial<WebPidRecord>;
    if (typeof record.pid !== 'number' || !processIsAlive(record.pid)) {
      // A dead process is stale state, not a running server.
      try {
        unlinkSync(path);
      } catch {
        /* another reader already removed it */
      }
      return null;
    }
    if (typeof record.startedAt !== 'string' || typeof record.port !== 'number' || typeof record.host !== 'string') return null;
    // Records written before the workspace root was tracked simply fall back to the caller's cwd.
    if (record.dir !== undefined && typeof record.dir !== 'string') return null;
    return record as WebPidRecord;
  } catch {
    return null;
  }
}

/**
 * Mirrors how the daemon itself is launched, so the web child runs the same code vintage as
 * this CLI. `--serve` marks the detached child: it runs the server in its own process instead
 * of spawning again, and `--hostname` keeps the binding the parent chose.
 */
export function webSpawnArgs(entry: string, port: number, host: string): string[] {
  return cliNodeArgs(entry, ['web', '--serve', '--port', String(port), '--hostname', host]);
}

/**
 * Starts the browser server as a detached service and waits until it answers.
 * An already-running tracked server is returned as-is: the boot command stays
 * idempotent the way `startDaemon` is.
 */
export async function startWebProcess(entry: string | undefined, port: number, host: string, dir: string): Promise<WebPidRecord> {
  const existing = readWebPidRecord();
  if (existing) return existing;
  if (!entry) throw new Error('Could not locate the OpenButler CLI entry point.');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid --port value "${port}". Use a number between 1 and 65535.`);
  const logPath = getDataPath('daemon.log');
  const logFd = openSync(logPath, 'a', 0o600);
  const logOffset = fstatSync(logFd).size;
  let child;
  try {
    child = spawn(process.execPath, webSpawnArgs(resolve(entry), port, host), {
      // The child resolves `--dir` from its own cwd, so the recorded workspace root is
      // what it serves even when this CLI was launched from somewhere else.
      cwd: dir,
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  const childExit: { value: { code: number | null; signal: NodeJS.Signals | null } | null } = { value: null };
  child.once('exit', (code, signal) => {
    childExit.value = { code, signal };
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('error', rejectSpawn);
    child.once('spawn', () => resolveSpawn());
  });
  child.unref();
  const record: WebPidRecord = { pid: child.pid!, startedAt: new Date().toISOString(), port, host, dir };
  writeFileSync(webPidPath(), JSON.stringify(record), { mode: 0o600 });
  const pollHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childExit.value) {
      const logTail = readDaemonLogSince(logPath, logOffset);
      const { code, signal } = childExit.value;
      throw new Error(
        `The web server exited before becoming ready${code === null ? ` (${signal ?? 'unknown signal'})` : ` (exit code ${code})`}.${logTail ? `\n${logTail}` : ''}`,
      );
    }
    try {
      const response = await fetch(`http://${pollHost}:${port}/`, { signal: AbortSignal.timeout(1_000), redirect: 'manual' });
      if (response.status < 500) return record;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`The web server did not become ready within ${DAEMON_START_TIMEOUT_MS / 1_000} seconds.`);
}

/** Stops the tracked web process; only a verified OpenButler web child is signalled. */
export async function stopWebProcess(): Promise<boolean> {
  const path = webPidPath();
  const record = readWebPidRecord();
  if (!record) return false;
  const liveCommand = await readProcessCommandLine(record.pid);
  const isOpenButlerWeb = Boolean(liveCommand && /\bweb\b/.test(liveCommand) && /cli\.(?:js|ts)/.test(liveCommand));
  if (!isOpenButlerWeb) return false;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  if (!(await waitForProcessExit(record.pid, 5_000))) {
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await waitForProcessExit(record.pid, 5_000);
  }
  try {
    unlinkSync(path);
  } catch {
    /* already removed */
  }
  return true;
}

/** The tracked web process, pruned when it is no longer alive. */
export function webProcessStatus(): WebPidRecord | null {
  return readWebPidRecord();
}

/** Registers the process serving the browser client so stop and restart reach it. */
export function trackWebProcess(record: WebPidRecord): void {
  writeFileSync(webPidPath(), JSON.stringify(record), { mode: 0o600 });
}

/** Drops the tracking record; only the recorded process may remove it. */
export function untrackWebProcess(pid: number): void {
  if (readWebPidRecord()?.pid !== pid) return;
  try {
    unlinkSync(webPidPath());
  } catch {
    /* already removed */
  }
}

/** Where a daemon-supervised web server should listen and which workspace it serves. */
export type WebStartOptions = { port: number; host: string; dir: string };

/** Internal child-process entry point for `openbutler daemon run`. */
export async function runDaemonProcess(web?: WebStartOptions): Promise<void> {
  const startLock = await acquireDaemonStartLock();
  try {
    const active = await getDaemonStatus();
    if (active?.legacy)
      throw new Error('An older OpenButler host is still running. Stop it with `openbutler daemon stop`, then start OpenButler again.');
    if (active) throw new Error(`An OpenButler host is already running (pid ${active.pid}).`);
    await runLockedDaemonProcess(startLock.startedAt, web);
  } finally {
    releaseDaemonStartLock(startLock);
  }
}

async function runLockedDaemonProcess(startedAt: string, web?: WebStartOptions): Promise<void> {
  let stopping = false;
  let shutdownReason: string | null = null;
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const logger = createLogger({ sink: fileSink(), context: { pid: process.pid, process: 'host' } });
  const host = createDaemonHost({
    startedAt,
    requestStop: (restarting = false) => {
      if (stopping) return;
      stopping = true;
      shutdownReason = restarting ? 'IPC restart request' : 'IPC stop request';
      resolveStop();
      void host.close().catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
    },
    // Structured records go to their own rotating file; the spawn redirect keeps
    // raw stderr for crashes and native noise.
    log: (message) => logger.info('host.log', { message }),
  });
  const server = createServer((socket) => host.handleConnection(socket));
  const endpoint = getDaemonEndpoint();
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    shutdownReason = signal;
    resolveStop();
    void host.close().catch((error: unknown) => console.error(String(error)));
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await listenDaemonServer(server, endpoint);
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600);
    await host.start();
    await writeDaemonPidFile(startedAt);
    console.log(`OpenButler host ready (${process.pid}); ${host.getStatus().workspaceCount} workspace loaded.`);
    if (web) {
      try {
        const record = await startWebProcess(process.argv[1], web.port, web.host, web.dir);
        logger.info('web.started', { pid: record.pid, host: record.host, port: record.port, dir: web.dir });
        console.log(`OpenButler web ready (${record.pid}) at http://${record.host}:${record.port}.`);
      } catch (error) {
        // A busy port or a deleted workspace must not take the host down with
        // it: the terminal and Telegram still work, and the next explicit
        // `openbutler web` can report the problem to the owner.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('web.start.failed', { host: web.host, port: web.port, dir: web.dir, error: message });
        console.error(`OpenButler web failed to start: ${message}`);
      }
    }
    await stopRequested;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    try {
      await host.close();
    } catch (error) {
      logger.info('host.log', { message: `[shutdown] host close failed — ${error instanceof Error ? error.message : String(error)}` });
    }
    await withDeadline(() => closeServer(server), IPC_CLOSE_TIMEOUT_MS, 'IPC server close').catch((error: unknown) => {
      logger.info('host.log', {
        message: `[shutdown] IPC server close abandoned — ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    if (process.platform !== 'win32') {
      try {
        unlinkSync(endpoint);
      } catch {
        /* socket already removed */
      }
    }
    removeDaemonPidFile();
    console.error(`OpenButler host stopped (${shutdownReason ?? 'startup failed'}).`);
    // A host that was asked to stop leaves on its own schedule: the loop may still hold
    // handles (child pipes, sockets, watchers) that no longer matter, and waiting for them
    // to drain by themselves is exactly what used to end in the CLI's force-kill.
    if (shutdownReason) process.exit(0);
  }
}

async function listenDaemonServer(server: Server, endpoint: string): Promise<void> {
  try {
    await listen(server, endpoint);
  } catch (error) {
    if (process.platform === 'win32' || !isAddressInUse(error)) {
      if (isAddressInUse(error)) {
        const active = await getDaemonStatus();
        if (active) throw new Error(`An OpenButler host is already running (pid ${active.pid}).`);
        const recordedPid = readDaemonPid();
        const holder = processIsAlive(recordedPid)
          ? `The recorded host process ${recordedPid} is still alive but did not answer IPC health checks.`
          : 'The endpoint is occupied by an incompatible or unresponsive process.';
        throw new Error(
          `${holder} Stop the verified host process before retrying; OpenButler will not remove an endpoint it cannot identify.`,
        );
      }
      throw error;
    }
    const active = await getDaemonStatus();
    if (active) throw new Error(`An OpenButler host is already running (pid ${active.pid}).`);
    const recordedPid = readDaemonPid();
    if (recordedPid === null || processIsAlive(recordedPid)) {
      throw new Error(
        recordedPid === null
          ? 'The daemon endpoint exists but its owner cannot be verified; refusing to remove it.'
          : `The daemon endpoint exists but recorded process ${recordedPid} is still alive and not responding.`,
      );
    }
    if (!lstatSync(endpoint).isSocket()) throw error;
    unlinkSync(endpoint);
    try {
      unlinkSync(getDaemonPidPath());
    } catch {
      /* stale pid file */
    }
    await listen(server, endpoint);
  }
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

function requestDaemon(
  action: BasicRequestAction,
  payload: Record<string, unknown> = {},
  timeoutMs = DAEMON_REQUEST_TIMEOUT_MS,
  protocolVersion = DAEMON_PROTOCOL_VERSION,
): Promise<BasicResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const id = randomUUID();
    const request = JSON.stringify({ ...payload, version: protocolVersion, id, action }) + '\n';
    const socket = createConnection(getDaemonEndpoint());
    let responseBuffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, response?: BasicResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(response!);
    };
    const timeout = setTimeout(() => finish(new Error('OpenButler host control request timed out.')), timeoutMs);
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      if (responseBuffer.byteLength > MAX_DAEMON_FRAME_BYTES) {
        finish(new Error('OpenButler host response exceeded the frame limit.'));
        return;
      }
      const newline = responseBuffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const value: unknown = JSON.parse(responseBuffer.subarray(0, newline).toString('utf8'));
        if (!isBasicResponse(value, protocolVersion) || value.id !== id) throw new Error('Invalid OpenButler host response.');
        finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('OpenButler host closed the control connection before replying.')));
  });
}

function getDaemonPidPath(): string {
  return getDataPath('daemon.pid');
}

function readDaemonPid(): number | null {
  return readDaemonPidRecord()?.pid ?? null;
}

function readDaemonPidRecord(): { pid: number; startedAt: string; identity?: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getDaemonPidPath(), 'utf8'));
    if (!isRecord(parsed) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1 || typeof parsed.startedAt !== 'string')
      return null;
    return {
      pid: Number(parsed.pid),
      startedAt: parsed.startedAt,
      ...(typeof parsed.identity === 'string' ? { identity: parsed.identity } : {}),
    };
  } catch {
    return null;
  }
}

async function acquireDaemonStartLock(): Promise<DaemonStartLock> {
  mkdirSync(getDataDir(), { recursive: true });
  const path = getDataPath('daemon.start.lock');
  const deadline = Date.now() + DAEMON_START_LOCK_WAIT_MS;
  while (true) {
    const token = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt, token }));
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          /* another process already removed it */
        }
        throw error;
      }
      const heartbeat = setInterval(() => {
        try {
          futimesSync(fd, new Date(), new Date());
        } catch {
          /* a stale-lock recovery replaced this file */
        }
      }, DAEMON_START_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return { path, fd, token, startedAt, heartbeat };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const active = await getDaemonStatus();
    if (active) throw new Error(`An OpenButler host is already running (pid ${active.pid}).`);
    const lockOwner = readDaemonStartLockRecord(path);
    const daemonRecord = readDaemonPidRecord();
    if (
      lockOwner &&
      daemonRecord &&
      lockOwner.pid === daemonRecord.pid &&
      lockOwner.startedAt === daemonRecord.startedAt &&
      processIsAlive(lockOwner.pid)
    ) {
      throw new Error(`OpenButler host process ${lockOwner.pid} is alive but does not answer IPC health checks.`);
    }
    if (removeStaleDaemonStartLock(path)) continue;
    if (Date.now() >= deadline) throw new Error('Another OpenButler host is still starting. Retry after its startup finishes.');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function readDaemonStartLockRecord(path: string): { pid: number; startedAt: string; token: string } | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) < 1 ||
      typeof value.startedAt !== 'string' ||
      typeof value.token !== 'string'
    )
      return null;
    return { pid: Number(value.pid), startedAt: value.startedAt, token: value.token };
  } catch {
    return null;
  }
}

function releaseDaemonStartLock(lock: DaemonStartLock): void {
  clearInterval(lock.heartbeat);
  try {
    closeSync(lock.fd);
  } catch {
    /* already closed */
  }
  try {
    const record: unknown = JSON.parse(readFileSync(lock.path, 'utf8'));
    if (isRecord(record) && record.token === lock.token) unlinkSync(lock.path);
  } catch {
    /* a newer startup owns the lock or the file is already gone */
  }
}

function removeStaleDaemonStartLock(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    let ownerPid: number | null = null;
    try {
      const record: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(record) && Number.isSafeInteger(record.pid) && Number(record.pid) > 0) {
        ownerPid = Number(record.pid);
      }
    } catch {
      /* an empty new lock is protected by its fresh modification time */
    }
    const stale = Date.now() - stat.mtimeMs >= DAEMON_START_LOCK_STALE_MS;
    if (!stale && (ownerPid === null || processIsAlive(ownerPid))) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT';
  }
}

function processIsAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return true;
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  try {
    const windows = process.platform === 'win32';
    const { stdout } = await execFileAsync(
      windows ? 'powershell.exe' : 'ps',
      windows
        ? [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$hostProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $hostProcess) { exit 1 }; @($hostProcess.CreationDate.ToUniversalTime().Ticks.ToString(), $hostProcess.ExecutablePath, $hostProcess.CommandLine) | ConvertTo-Json -Compress`,
          ]
        : ['-p', String(pid), '-o', 'lstart=', '-o', 'args='],
      {
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 16_384,
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    const identity = stdout.trim();
    return identity ? createHash('sha256').update(identity).digest('hex') : null;
  } catch {
    return null;
  }
}

/** The live command line of a pid, or null when the process is gone. */
async function readProcessCommandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'powershell.exe' : 'ps',
      process.platform === 'win32'
        ? [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$hostProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $hostProcess) { exit 1 }; $hostProcess.CommandLine`,
          ]
        : ['-p', String(pid), '-o', 'args='],
      { windowsHide: true, timeout: 3_000, maxBuffer: 16_384, env: { ...process.env, LC_ALL: 'C' } },
    );
    const line = stdout.trim();
    return line ? line : null;
  } catch {
    return null;
  }
}

async function writeDaemonPidFile(startedAt: string): Promise<void> {
  const path = getDaemonPidPath();
  const temporary = `${path}.${process.pid}.tmp`;
  const identity = await readProcessIdentity(process.pid);
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, startedAt, ...(identity ? { identity } : {}) }), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    unlinkSync(path);
  } catch {
    /* no previous daemon record */
  }
  renameSync(temporary, path);
}

function removeDaemonPidFile(): void {
  if (readDaemonPid() !== process.pid) return;
  try {
    unlinkSync(getDaemonPidPath());
  } catch {
    /* already removed */
  }
}

function readDaemonLogSince(path: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(offset, size - 4_000);
    const content = Buffer.alloc(size - start);
    readSync(fd, content, 0, content.byteLength, start);
    return content.toString('utf8').trim();
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

function isAddressInUse(error: unknown): boolean {
  return isRecord(error) && error.code === 'EADDRINUSE';
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
  return (
    isRecord(value) &&
    typeof value.pid === 'number' &&
    typeof value.startedAt === 'string' &&
    Number.isSafeInteger(value.workspaceCount) &&
    Number.isSafeInteger(value.connectedClients)
  );
}

function isBasicResponse(value: unknown, protocolVersion: number): value is BasicResponse {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    value.version === protocolVersion &&
    typeof value.id === 'string' &&
    typeof value.ok === 'boolean' &&
    (!value.ok || 'result' in value || 'status' in value || value.stopping === true) &&
    (value.ok || typeof value.error === 'string')
  );
}

function legacyStatusFromResponse(response: BasicResponse): DaemonStatus | null {
  if (response.ok && isDaemonStatus(response.result)) return { ...response.result, legacy: true };
  if (!isLegacyDaemonStatus(response.status)) return null;
  return {
    pid: response.status.pid,
    startedAt: response.status.startedAt,
    workspaceCount: 1,
    connectedClients: 0,
    legacy: true,
  };
}

function isLegacyDaemonStatus(value: unknown): value is { pid: number; startedAt: string } {
  return (
    isRecord(value) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    typeof value.startedAt === 'string' &&
    typeof value.workspaceRoot === 'string' &&
    typeof value.sessionId === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
