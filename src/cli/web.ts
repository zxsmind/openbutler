import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as ui from './ui.js';
import type { Parsed } from './args.js';
import { startDaemon } from '../daemon.js';
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, startWebServer, type WebServer } from '../web/server.js';

function readPort(parsed: Parsed): number {
  const raw = parsed.flags.get('port');
  if (!raw) return DEFAULT_WEB_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value "${raw}". Use a number between 1 and 65535.`);
  }
  return port;
}

/**
 * Serves the browser client from this machine. The server only reads static
 * files and pushes session snapshots; rendering happens in the browser, so the
 * host process stays where it is.
 */
export async function runWebCommand(parsed: Parsed): Promise<void> {
  const port = readPort(parsed);
  const host = parsed.flags.get('hostname') ?? DEFAULT_WEB_HOST;
  const workspaceRoot = resolve(parsed.flags.get('dir') ?? process.cwd());

  ui.section('Ranite web');
  ui.kv('Workspace', workspaceRoot);
  ui.kv('Address', `http://${host}:${port}`);
  if (host !== DEFAULT_WEB_HOST) {
    ui.warn('This server is reachable from the network. Keep the pairing link private.');
  }

  await startDaemon();
  let server: WebServer | null = null;
  try {
    server = await startWebServer({ workspaceRoot, port, host });
  } catch (error) {
    ui.failure(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
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

  const shutdown = () => {
    void (async () => {
      await server?.close();
      ui.line();
      ui.info('Web server stopped.');
      process.exit(0);
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => {});
}
