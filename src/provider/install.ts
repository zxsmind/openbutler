import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDataPath } from '../paths.js';

/**
 * On-demand installation of provider runtime packages.
 *
 * Ranite bundles a handful of AI SDK provider packages (see `SUPPORTED_PACKAGES`
 * in registry.ts). Any other provider in the models.dev catalog is installed
 * the first time it is used, into Ranite's own data directory, and imported
 * from there. This is what lets a provider the code has never heard of work
 * without a release: the catalog carries its npm package, and this file fetches
 * it.
 *
 * Each package gets its own directory. npm removes packages it does not find in
 * a manifest, and with `--no-save` a sibling install would look extraneous and
 * be pruned; separate directories keep installs from touching each other.
 *
 * The version matters. The AI SDK publishes a dist-tag `ai-v<N>` (for example
 * `ai-v6`) on every provider package for the version built against `ai@<N>`.
 * Ranite runs one AI SDK line, so it asks for that line's tag. Installing
 * `latest` would pull a package built for a newer model spec version than the
 * runtime understands, which fails at the first call.
 *
 * A catalog `npm` may name a subpath export rather than a package of its own —
 * `@ai-sdk/google-vertex/anthropic` is one package with several entries, not a
 * package named `anthropic`. The installable name is therefore resolved by
 * asking the registry which prefix actually exists, and the remainder is
 * imported out of that package's `exports` map.
 *
 * Nothing here names a provider. The package name comes from the catalog.
 */

const PACKAGES_DIR = getDataPath('packages');
const REGISTRY = 'https://registry.npmjs.org';
const INSTALL_TIMEOUT_MS = 180_000;
const META_TIMEOUT_MS = 8_000;

const require = createRequire(import.meta.url);

/** The AI SDK major version Ranite is built against, e.g. `6` for `ai@6`. */
function aiMajor(): number {
  try {
    return Number((require('ai/package.json') as { version: string }).version.split('.')[0]) || 6;
  } catch {
    return 6;
  }
}

/** The AI SDK provider-spec major Ranite's adapters target, e.g. `3`.
 *
 * Read from what `ai` itself declares, because `ai` is a dependency of this
 * package while `@ai-sdk/provider` is only a transitive one: relying on the
 * transitive copy would resolve by accident of hoisting rather than by contract.
 */
function providerMajor(): number {
  try {
    const declared = (require('ai/package.json') as { dependencies?: Record<string, string> }).dependencies?.['@ai-sdk/provider'];
    const digits = /\d+/.exec(declared ?? '');
    if (digits) return Number(digits[0]);
  } catch {
    // Fall through to the installed copy.
  }
  try {
    return Number((require('@ai-sdk/provider/package.json') as { version: string }).version.split('.')[0]) || 3;
  } catch {
    return 3;
  }
}

/**
 * A package name, or a subpath of one, as the catalog writes it.
 *
 * Checked before anything is installed or fetched. The catalog is external data,
 * so a name arriving in `npm` is not trusted to be a name at all: it could carry
 * a path, a registry URL, or shell syntax. Rejecting it here means the install
 * step never has to be clever about it.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SUBPATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertInstallable(npm: string): void {
  const segments = npm.split('/');
  const first = npm.startsWith('@') ? 2 : 1;
  if (!PACKAGE_NAME.test(segments.slice(0, first).join('/'))) {
    throw new Error(`"${npm}" is not a valid npm package name`);
  }
  for (const segment of segments.slice(first)) {
    if (!SUBPATH_SEGMENT.test(segment)) {
      throw new Error(`"${npm}" has an invalid subpath segment "${segment}"`);
    }
  }
}

/** An installable package name plus the subpath export to import from it. */
interface PackageRef {
  /** The npm package to install, e.g. `@ai-sdk/google-vertex`. */
  name: string;
  /** The export to import, `.` for the package root. */
  subpath: string;
}

/**
 * The candidate package names inside a catalog `npm`, longest first.
 *
 * `@ai-sdk/google-vertex/anthropic` can only be the package
 * `@ai-sdk/google-vertex` with subpath `./anthropic`, or a package named
 * `@ai-sdk/google-vertex/anthropic` itself. Both are tried, longest first, so a
 * real package of that name still wins.
 */
function nameCandidates(npm: string): string[] {
  const segments = npm.split('/');
  const first = npm.startsWith('@') ? 2 : 1;
  const candidates: string[] = [];
  for (let take = segments.length; take >= first; take -= 1) candidates.push(segments.slice(0, take).join('/'));
  return candidates;
}

async function registryExists(name: string): Promise<boolean> {
  try {
    const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

const refCache = new Map<string, PackageRef>();

/** Splits a catalog `npm` into the package to install and the export to import. */
export async function resolvePackageRef(npm: string): Promise<PackageRef> {
  assertInstallable(npm);
  const cached = refCache.get(npm);
  if (cached) return cached;
  const candidates = nameCandidates(npm);
  // A bare package name needs no probe: there is no subpath to discover.
  if (candidates.length === 1) return cache(npm, { name: candidates[0], subpath: '.' });
  for (const name of candidates) {
    if (await registryExists(name)) {
      const subpath = name === npm ? '.' : `./${npm.slice(name.length + 1)}`;
      return cache(npm, { name, subpath });
    }
  }
  // The registry is unreachable or the package is unpublished. Install the
  // longest name and let npm report the real failure, which says more than a
  // local guess would.
  return cache(npm, { name: candidates[0], subpath: '.' });
}

function cache(npm: string, ref: PackageRef): PackageRef {
  refCache.set(npm, ref);
  return ref;
}

/** The install directory for one package, safe as a single path segment. */
function installRoot(name: string): string {
  return join(PACKAGES_DIR, name.replace(/[^a-zA-Z0-9._-]+/g, '__'));
}

/** Where a package lands once installed: `<root>/node_modules/<name>`. */
function packageDir(name: string): string {
  return join(installRoot(name), 'node_modules', ...name.split('/'));
}

function ensureInstallRoot(name: string): string {
  const root = installRoot(name);
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, 'package.json');
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({ name: 'ranite-provider-package', private: true, version: '0.0.0' }, null, 2), 'utf8');
  }
  return root;
}

/** Collects the file candidates of one `exports` value, in loader order. */
function exportFiles(value: unknown): string[] {
  const files: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') files.push(node);
    else if (Array.isArray(node)) for (const item of node) visit(item);
    else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      for (const condition of ['node', 'import', 'module-sync', 'default', 'require']) {
        if (condition in record) visit(record[condition]);
      }
      for (const key of Object.keys(record)) {
        if (!['node', 'import', 'module-sync', 'default', 'require', 'types'].includes(key)) visit(record[key]);
      }
    }
  };
  visit(value);
  return files;
}

interface PackageManifest {
  exports?: unknown;
  module?: unknown;
  main?: unknown;
}

/**
 * The import entry file of an installed package export, resolved from the
 * package's own `exports` map in the order the ESM loader prefers. Null when
 * the package is absent or exposes nothing importable.
 */
export function installedEntry(npm: string): string | null {
  const segments = npm.split('/');
  // Try every package/subpath split, longest package name first, so the caller
  // needs no registry round-trip for a package that is already on disk.
  const first = npm.startsWith('@') ? 2 : 1;
  for (let take = segments.length; take >= first; take -= 1) {
    const name = segments.slice(0, take).join('/');
    const subpath = take === segments.length ? '.' : `./${segments.slice(take).join('/')}`;
    const dir = packageDir(name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
    } catch {
      continue;
    }
    const exportsMap = manifest.exports as Record<string, unknown> | undefined;
    const declared =
      subpath === '.' ? (exportsMap?.['.'] ?? exportsMap) : (exportsMap?.[subpath] ?? (subpath === '.' ? exportsMap : undefined));
    const candidates =
      declared !== undefined
        ? exportFiles(declared)
        : subpath === '.'
          ? [
              ...(typeof manifest.module === 'string' ? [manifest.module] : []),
              ...(typeof manifest.main === 'string' ? [manifest.main] : []),
              'index.js',
            ]
          : [`${subpath.slice(2)}/index.mjs`, `${subpath.slice(2)}/index.js`, `${subpath.slice(2)}.mjs`, `${subpath.slice(2)}.js`];
    for (const relative of candidates) {
      const absolute = join(dir, relative);
      if (existsSync(absolute)) return absolute;
    }
  }
  return null;
}

/**
 * The npm spec to install for a package on Ranite's AI SDK line.
 *
 * Prefers the line dist-tag (`ai-v6`). A third-party package may not publish
 * that tag, so it falls back to the newest version whose `@ai-sdk/provider`
 * dependency matches Ranite's spec major. When the registry is unreachable it
 * returns the line tag and lets npm report the failure.
 */
async function installSpec(name: string): Promise<string> {
  const lineTag = `ai-v${aiMajor()}`;
  try {
    const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    if (response.ok) {
      const meta = (await response.json()) as {
        'dist-tags'?: Record<string, string>;
        versions?: Record<string, { dependencies?: Record<string, string> }>;
      };
      const tag = meta['dist-tags']?.[lineTag];
      if (tag) return `${name}@${tag}`;
      const wanted = `${providerMajor()}.`;
      const compatible = Object.keys(meta.versions ?? {}).filter(
        (version) => !version.includes('-') && (meta.versions?.[version]?.dependencies?.['@ai-sdk/provider'] ?? '').includes(wanted),
      );
      if (compatible.length > 0) return `${name}@${compatible[compatible.length - 1]}`;
    }
  } catch {
    // Offline, or the registry rejected the lookup: fall through to the tag.
  }
  return `${name}@${lineTag}`;
}

/**
 * npm's JavaScript CLI entry, when it can be found.
 *
 * Spawning `npm.cmd` is the obvious route and the one Node refuses: since
 * CVE-2024-27980 a `.cmd` or `.bat` file cannot be spawned without a shell, and
 * a shell is exactly what would make a catalog-supplied package name dangerous.
 * Running npm's own CLI script with this same Node binary needs no shell on any
 * platform.
 *
 * npm keeps its code at `<npm-bin-dir>/node_modules/npm/bin/npm-cli.js`, whether
 * it arrived with Node or was installed into a user prefix, so both homes of the
 * `npm` executable are probed for that layout.
 */
function npmCliPath(): string | null {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && fromEnv.toLowerCase().endsWith('.js') && existsSync(fromEnv)) return fromEnv;
  const binDirs = [dirname(process.execPath)];
  const shim = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const entry of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (entry && existsSync(join(entry, shim))) binDirs.push(entry);
  }
  for (const dir of binDirs) {
    const candidate = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The `npm install` arguments for one package into one directory. */
function installArgs(root: string, spec: string): string[] {
  return ['install', '--prefix', root, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error', spec];
}

/**
 * Runs `npm install` into a package's own directory, with a hard timeout.
 *
 * Arguments are passed as a list rather than a command string, so nothing that
 * arrived from the catalog is interpreted by a shell. `assertInstallable` has
 * already rejected anything malformed before this point, which is what makes the
 * one fallback — a shell, when npm's CLI script cannot be located — acceptable
 * rather than merely convenient.
 */
function runNpmInstall(root: string, spec: string, onProgress?: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = npmCliPath();
    const args = installArgs(root, spec);
    const child = cli
      ? spawn(process.execPath, [cli, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`installing ${spec} timed out after ${INSTALL_TIMEOUT_MS / 1000}s`));
    }, INSTALL_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) onProgress?.(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install ${spec} failed (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/** Ensures a provider package is installed and returns its import entry file. */
export async function ensureProviderPackage(npm: string, onProgress?: (message: string) => void): Promise<string> {
  assertInstallable(npm);
  const existing = installedEntry(npm);
  if (existing) return existing;
  const { name } = await resolvePackageRef(npm);
  const root = ensureInstallRoot(name);
  const spec = await installSpec(name);
  onProgress?.(`Installing ${spec}`);
  await runNpmInstall(root, spec, onProgress);
  const entry = installedEntry(npm);
  if (!entry) throw new Error(`installed ${spec} but it exposes no import entry point for "${npm}"`);
  return entry;
}

const selfEnvCache = new Map<string, boolean>();

/**
 * True when a package reads its own credential from the environment.
 *
 * The AI SDK does this through one helper, so the variable names are literally
 * in the built file: `environmentVariableName: "GROQ_API_KEY"`. Reading them
 * out of the package answers the question Ranite would otherwise have to guess
 * — "should I pass an API key, or will this package find its own?" — from the
 * only authority on the matter, the package itself.
 *
 * `@ai-sdk/openai-compatible` declares none, which is why the gateway providers
 * that use it need Ranite to hand them a key; `@ai-sdk/amazon-bedrock` declares
 * `AWS_BEARER_TOKEN_BEDROCK` and signs requests itself, so a key from Ranite
 * would be an intrusion.
 *
 * False when the package is not installed yet, or cannot be read. The caller
 * treats that as "unknown" and keeps its own behaviour rather than silently
 * dropping a credential.
 */
export function packageReadsOwnEnv(npm: string): boolean {
  const cached = selfEnvCache.get(npm);
  if (cached !== undefined) return cached;
  const entry = installedEntry(npm);
  if (!entry) return false;
  let reads = false;
  try {
    reads = /environmentVariableName:\s*["'][A-Z0-9_]+["']/.test(readFileSync(entry, 'utf8'));
  } catch {
    reads = false;
  }
  selfEnvCache.set(npm, reads);
  return reads;
}

/**
 * Imports a provider package and returns its `create*` factory.
 *
 * Every AI SDK provider package follows one convention: a single exported
 * `create<Name>` function whose result exposes `languageModel(id)`. This is the
 * same convention the bundled adapters use, so a package Ranite has never seen
 * is driven exactly like a bundled one.
 */
export async function importProviderFactory(
  npm: string,
  onProgress?: (message: string) => void,
): Promise<(options: Record<string, unknown>) => unknown> {
  const entry = await ensureProviderPackage(npm, onProgress);
  const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const key = Object.keys(module).find((name) => /^create[A-Z]/.test(name));
  if (!key || typeof module[key] !== 'function') {
    throw new Error(`package "${npm}" exposes no create* provider factory`);
  }
  return module[key] as (options: Record<string, unknown>) => unknown;
}
