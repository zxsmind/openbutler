#!/usr/bin/env node
/**
 * Builds a self-contained release archive for the current OS and CPU.
 *
 * The archive bundles the official Node.js runtime, the compiled app and its
 * production dependencies, so the installer never needs npm on the target
 * machine:
 *
 *   ranite/
 *     node/   official Node.js binary for this platform
 *     app/    package.json, LICENSE, README.md, dist/, node_modules/
 *     bin/    `ranite` (POSIX) and `ranite.cmd` (Windows) launchers
 *
 * Usage:
 *   node scripts/package-release.mjs [--out <dir>] [--node-major 22]
 *       [--node-version 22.14.0] [--keep-stage]
 *
 * Requirements: network access, `npm`, and a `tar` binary on PATH
 * (Windows 10+, macOS and Linux all ship one).
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const VERSION = manifest.version;
if (typeof VERSION !== 'string' || !/^\d+\.\d+\.\d+/.test(VERSION)) throw new Error('package.json carries no valid semver version.');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
  const value = process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : 'true';
  if (value !== 'true') index += 1;
  args.set(flag.slice(2), value);
}
const OUT_DIR = resolve(String(args.get('out') ?? join(repository, 'release')));
const NODE_MAJOR = String(args.get('node-major') ?? enginesNodeMajor());
const NODE_VERSION = args.get('node-version') === undefined ? null : String(args.get('node-version'));
const KEEP_STAGE = args.get('keep-stage') === 'true';

function enginesNodeMajor() {
  const range = manifest.engines?.node;
  const match = typeof range === 'string' ? range.match(/(\d+)/) : null;
  if (!match) throw new Error('package.json engines.node carries no major version.');
  return match[1];
}

function log(message) {
  process.stdout.write(`[package-release] ${message}\n`);
}

function run(command, parameters, options = {}) {
  execFileSync(command, parameters, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
}

function formatMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    total += info.isDirectory() ? directoryBytes(path) : info.size;
  }
  return total;
}

/**
 * Drops dead native weight from the staged tree: onnxruntime binaries for
 * other operating systems/CPUs, and GPU-only provider libraries. The native
 * binding links only its platform's CPU library (verified with ldd); CUDA and
 * TensorRT providers load solely on explicit GPU requests, which the app never
 * makes, so CPU inference is unaffected.
 */
function pruneNativeWeight(nodeModules) {
  const platforms = { win32: 'win32', darwin: 'darwin', linux: 'linux' };
  const ortBin = join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v6');
  if (!existsSync(ortBin)) return;
  for (const os of readdirSync(ortBin)) {
    const osDir = join(ortBin, os);
    if (!statSync(osDir).isDirectory()) continue;
    if (os !== platforms[process.platform]) {
      log(`Dropped onnxruntime natives for ${os} (${formatMB(directoryBytes(osDir))}).`);
      rmSync(osDir, { recursive: true, force: true });
      continue;
    }
    for (const arch of readdirSync(osDir)) {
      const archDir = join(osDir, arch);
      if (!statSync(archDir).isDirectory()) continue;
      if (arch !== process.arch) {
        log(`Dropped onnxruntime natives for ${os}/${arch} (${formatMB(directoryBytes(archDir))}).`);
        rmSync(archDir, { recursive: true, force: true });
        continue;
      }
      for (const file of readdirSync(archDir)) {
        if (/^libonnxruntime_providers_(cuda|tensorrt)\./.test(file)) {
          const path = join(archDir, file);
          log(`Dropped GPU-only ${file} (${formatMB(statSync(path).size)}).`);
          rmSync(path, { force: true });
        }
      }
    }
  }
}

function capture(command, parameters) {
  return execFileSync(command, parameters, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
}

function platformTarget() {
  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (!os) throw new Error(`Unsupported build OS: ${process.platform}`);
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) throw new Error(`Unsupported build CPU: ${process.arch}`);
  if (os === 'windows' && arch !== 'x64') throw new Error(`No official Node.js Windows binary for ${arch}.`);
  return { os, arch };
}

async function resolveNodeVersion(major) {
  if (NODE_VERSION) return NODE_VERSION.startsWith('v') ? NODE_VERSION.slice(1) : NODE_VERSION;
  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) throw new Error(`Could not list Node.js releases (HTTP ${response.status}).`);
  const releases = await response.json();
  const latest = releases.find((release) => release.version.startsWith(`v${major}.`));
  if (!latest) throw new Error(`No Node.js v${major} release found.`);
  return latest.version.slice(1);
}

function nodeAsset(os, arch, nodeVersion) {
  if (os === 'windows')
    return { file: `node-v${nodeVersion}-win-x64.zip`, inner: `node-v${nodeVersion}-win-x64/node.exe`, binary: 'node.exe' };
  if (os === 'darwin')
    return { file: `node-v${nodeVersion}-darwin-${arch}.tar.gz`, inner: `node-v${nodeVersion}-darwin-${arch}/bin/node`, binary: 'node' };
  return { file: `node-v${nodeVersion}-linux-${arch}.tar.xz`, inner: `node-v${nodeVersion}-linux-${arch}/bin/node`, binary: 'node' };
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, buffer);
  return buffer;
}

async function main() {
  const { os, arch } = platformTarget();
  const target = `${os}-${arch}`;
  log(`Target ${target}, app version ${VERSION}.`);
  try {
    capture('tar', ['--version']);
  } catch {
    throw new Error('A `tar` binary is required on PATH to build release archives.');
  }
  try {
    capture('npm', ['--version']);
  } catch {
    throw new Error('`npm` is required on PATH to build release archives.');
  }

  const nodeVersion = await resolveNodeVersion(NODE_MAJOR);
  log(`Bundled Node.js v${nodeVersion}.`);
  const asset = nodeAsset(os, arch, nodeVersion);
  const archiveName = `ranite-${VERSION}-${target}.${os === 'windows' ? 'zip' : 'tar.gz'}`;

  const stage = mkdtempSync(join(tmpdir(), 'ranite-release-'));
  log(`Staging in ${stage}.`);
  try {
    // 1. Copy build inputs (never the working tree's node_modules or dist).
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'README.md']) {
      const source = join(repository, name);
      if (!existsSync(source)) throw new Error(`Build input missing: ${name}`);
      cpSync(source, join(stage, name));
    }
    for (const name of ['src', 'skills', 'scripts']) cpSync(join(repository, name), join(stage, name), { recursive: true });

    // 2. Clean install, compile, then drop development dependencies.
    log('Installing dependencies (this downloads several hundred MB once).');
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: stage });
    log('Compiling.');
    run('npm', ['run', 'build'], { cwd: stage });
    log('Pruning development dependencies.');
    run('npm', ['prune', '--omit=dev'], { cwd: stage });
    log('Pruning unused native binaries.');
    pruneNativeWeight(join(stage, 'node_modules'));

    // 3. Fetch the official Node.js binary and verify its checksum.
    const downloadDir = join(stage, 'node-download');
    mkdirSync(downloadDir, { recursive: true });
    log(`Downloading ${asset.file}.`);
    await download(`https://nodejs.org/dist/v${nodeVersion}/${asset.file}`, join(downloadDir, asset.file));
    const sums = await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, join(downloadDir, 'SHASUMS256.txt'));
    const expected = sums
      .toString('utf8')
      .split('\n')
      .find((line) => line.endsWith(`  ${asset.file}`))
      ?.split(' ')[0];
    if (!expected) throw new Error(`No checksum for ${asset.file} in SHASUMS256.txt.`);
    const digest = createHash('sha256')
      .update(readFileSync(join(downloadDir, asset.file)))
      .digest('hex');
    if (digest !== expected) throw new Error(`Checksum mismatch for ${asset.file}.`);
    log('Checksum verified. Extracting Node.js binary.');
    run('tar', ['-xf', asset.file], { cwd: downloadDir });

    // 4. Assemble the portable tree.
    const root = join(stage, 'ranite');
    const nodeDir = join(root, 'node', 'bin');
    const appDir = join(root, 'app');
    const binDir = join(root, 'bin');
    mkdirSync(nodeDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    cpSync(join(downloadDir, asset.inner), join(nodeDir, asset.binary));
    if (os !== 'windows') chmodSync(join(nodeDir, asset.binary), 0o755);
    mkdirSync(appDir, { recursive: true });
    for (const name of ['package.json', 'LICENSE', 'README.md', 'dist', 'node_modules']) {
      cpSync(join(stage, name), join(appDir, name), { recursive: true });
    }
    writeFileSync(
      join(binDir, 'ranite'),
      `#!/bin/sh\n# Portable launcher: uses the Node.js runtime shipped next to the app.\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$ROOT/node/bin/node" "$ROOT/app/dist/cli.js" "$@"\n`,
    );
    if (os !== 'windows') chmodSync(join(binDir, 'ranite'), 0o755);
    writeFileSync(
      join(binDir, 'ranite.cmd'),
      `@echo off\r\nrem Portable launcher: uses the Node.js runtime shipped next to the app.\r\nset "ROOT=%~dp0.."\r\n"%ROOT%\\node\\bin\\node.exe" "%ROOT%\\app\\dist\\cli.js" %*\r\n`,
    );

    // 5. Compress.
    mkdirSync(OUT_DIR, { recursive: true });
    const archive = join(OUT_DIR, archiveName);
    if (existsSync(archive)) rmSync(archive);
    if (os === 'windows') run('tar', ['-a', '-c', '-f', archive, 'ranite'], { cwd: stage });
    else run('tar', ['-czf', archive, 'ranite'], { cwd: stage });
    const sizeMB = (statSync(archive).size / 1048576).toFixed(1);
    log(`Wrote ${archive} (${sizeMB} MB).`);
  } finally {
    if (KEEP_STAGE) log(`Keeping stage directory ${stage}.`);
    else rmSync(stage, { recursive: true, force: true });
  }
}

await main();
