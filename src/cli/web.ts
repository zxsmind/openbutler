import { writeFileSync } from 'node:fs';
import * as ui from './ui.js';
import type { Parsed } from './args.js';
import {
  hostVintageMismatchWarning,
  requireBackgroundHost,
  startWebProcess,
  stopWebProcess,
  trackWebProcess,
  untrackWebProcess,
  webProcessStatus,
} from '../daemon.js';
import { resolveServerScope } from '../workspace-origin.js';
import { browserWebAddress, DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, startWebServer, type WebServer } from '../web/server.js';

export function readPort(parsed: Parsed): number {
  const raw = parsed.flags.get('port');
  if (!raw) return DEFAULT_WEB_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value "${raw}". Use a number between 1 and 65535.`);
  }
  return port;
}

const PAIR_HINT = 'Pair another device with `ranite web --pair`; paired browsers reconnect on their own.';
const LOCAL_ONLY_HINT = 'Local only on this computer. For phone or LAN access, run `ranite web --hostname 0.0.0.0`.';
const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === '::1';

/**
 * Serves the browser client from this machine. The server only reads static
 * files and pushes session snapshots; rendering happens in the browser, so the
 * host process stays where it is.
 *
 * Plain `ranite web` starts the server as a tracked background service and
 * returns. `--pair` is the explicit pairing session: it runs the server in
 * this terminal with a one-time link. `--serve` is the detached child's own
 * marker (see `webSpawnArgs`) and never prints a link, so no credential lands
 * in the host log.
 */
export async function runWebCommand(parsed: Parsed): Promise<void> {
  const port = readPort(parsed);
  const host = parsed.flags.get('hostname') ?? DEFAULT_WEB_HOST;
  const scope = resolveServerScope({ explicitDir: parsed.flags.get('dir'), cwd: process.cwd() });
  const workspaceRoot = scope.root;
  const wantsPair = parsed.booleans.has('pair') || parsed.flags.get('pair') === 'true';
  const serving = parsed.booleans.has('serve') || parsed.flags.get('serve') === 'true';

  if (!wantsPair && !serving) {
    const running = webProcessStatus();
    if (running) {
      ui.success(`Web server already running (pid ${running.pid}) at ${browserWebAddress(running.host, running.port)}.`);
      if (isLoopback(running.host)) ui.info(LOCAL_ONLY_HINT);
      ui.info(PAIR_HINT);
      return;
    }
    ui.section('Ranite web');
    ui.kv('Workspace', `${workspaceRoot} (from ${scope.source})`);
    try {
      // The browser server attaches to a running host; only daemon verbs start one.
      // Verifying here keeps the friendly message and the vintage warning on this
      // terminal instead of losing both in the detached child's log.
      const hostStatus = await requireBackgroundHost();
      const vintageWarning = hostVintageMismatchWarning(process.argv[1], hostStatus.entry);
      if (vintageWarning) ui.warn(vintageWarning);
      const child = await startWebProcess(process.argv[1], port, host, workspaceRoot);
      ui.success(`Web server running in the background (pid ${child.pid}).`);
      ui.kv('Address', browserWebAddress(child.host, child.port));
      if (isLoopback(child.host)) ui.info(LOCAL_ONLY_HINT);
      ui.info(PAIR_HINT);
    } catch (error) {
      ui.failure(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  // A pairing session has to bind this terminal's process to the port, so hand the
  // tracked server over instead of failing against a busy port. The session cookie
  // lives in the data directory, so already-paired browsers reconnect afterwards.
  if (wantsPair) {
    const running = webProcessStatus();
    if (running) {
      ui.info(`Stopping the tracked web server (pid ${running.pid}) for a pairing session…`);
      await stopWebProcess();
    }
  }

  ui.section('Ranite web');
  ui.kv('Workspace', `${workspaceRoot} (from ${scope.source})`);
  if (host !== DEFAULT_WEB_HOST) {
    ui.warn('This server is reachable from the network. Keep the pairing link private.');
  }

  const hostStatus = await requireBackgroundHost();
  const vintageWarning = hostVintageMismatchWarning(process.argv[1], hostStatus.entry);
  if (vintageWarning) ui.warn(vintageWarning);
  let server: WebServer | null = null;
  try {
    server = await startWebServer({ workspaceRoot, port, host });
  } catch (error) {
    ui.failure(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // This process now owns the port; register it so `ranite stop` and
  // `ranite restart` reach a pairing session the same way they reach the
  // detached background server.
  trackWebProcess({ pid: process.pid, startedAt: new Date().toISOString(), port, host, dir: workspaceRoot });

  ui.kv('Address', server.url);
  if (host === '0.0.0.0' || host === '::') {
    ui.info("For another device on your network, replace 127.0.0.1 in the link with this computer's LAN IP.");
  } else if (isLoopback(host)) {
    ui.info(LOCAL_ONLY_HINT);
  }

  const pairUrl = server.pairUrl;
  const pairFile = process.env.RANITE_WEB_PAIR_FILE;
  if (pairFile) {
    // Automation hook: a supervisor or a test can read the one-time link without
    // scraping the terminal output.
    try {
      writeFileSync(pairFile, `${pairUrl}\n`, { mode: 0o600 });
    } catch {
      // A missing file is not a reason to refuse serving the browser client.
    }
  }

  if (wantsPair) {
    ui.line();
    ui.success('Open this one-time link to pair your browser:');
    ui.line(`  ${pairUrl}`);
    ui.line();
    ui.info('The link works once and expires in 5 minutes. Press Enter for a fresh link, Ctrl+C to stop.');

    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', () => {
        ui.line();
        ui.success('Fresh pairing link:');
        ui.line(`  ${server?.newPairUrl() ?? ''}`);
      });
      process.stdin.resume();
    }
  } else {
    ui.info(`Serving the browser client. ${PAIR_HINT}`);
  }

  const shutdown = () => {
    void (async () => {
      await server?.close();
      untrackWebProcess(process.pid);
      ui.line();
      ui.info('Web server stopped.');
      process.exit(0);
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => {});
}
