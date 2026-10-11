import { spawnSync } from 'node:child_process';

const MAX_CLIPBOARD_BYTES = 5 * 1024 * 1024;

/** Reads a PNG from the system clipboard, using OS tools when a native build is unavailable. */
export async function readClipboardImageBase64(allowSystemFallback = true): Promise<string | null> {
  try {
    const clipboard = await import('@crosscopy/clipboard');
    if (clipboard.hasImage()) return clipboard.getImageBase64();
    if (!allowSystemFallback) return null;
  } catch {
    if (!allowSystemFallback) return null;
    // The native package may not ship a binary for this CPU/libc combination.
  }

  if (process.platform === 'linux') return readLinuxClipboardImage();
  if (process.platform === 'win32') return readWindowsClipboardImage();
  return null;
}

function readLinuxClipboardImage(): string | null {
  const wayland = spawnSync('wl-paste', ['--no-newline', '--type', 'image/png'], {
    encoding: 'buffer',
    maxBuffer: MAX_CLIPBOARD_BYTES,
    timeout: 2_000,
  });
  if (wayland.status === 0 && wayland.stdout.length > 0) return wayland.stdout.toString('base64');

  const x11 = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
    encoding: 'buffer',
    maxBuffer: MAX_CLIPBOARD_BYTES,
    timeout: 2_000,
  });
  return x11.status === 0 && x11.stdout.length > 0 ? x11.stdout.toString('base64') : null;
}

function readWindowsClipboardImage(): string | null {
  const script = String.raw`Add-Type -AssemblyName System.Windows.Forms; $image = [Windows.Forms.Clipboard]::GetImage(); if ($null -ne $image) { $stream = New-Object System.IO.MemoryStream; $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray())) }`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: Math.ceil((MAX_CLIPBOARD_BYTES * 4) / 3) + 1024,
    timeout: 3_000,
    windowsHide: true,
  });
  const base64 = result.status === 0 ? result.stdout.trim() : '';
  return base64 || null;
}
