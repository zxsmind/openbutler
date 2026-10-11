import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Copies UTF-8 text to the system clipboard.
 *
 * OSC 52 goes to the terminal first, which covers remote and sandboxed
 * sessions. A platform tool is spawned as well, because some terminals ignore
 * OSC 52 and a local copy should still land on the clipboard.
 */
export function writeClipboardText(text: string): void {
  if (!text) return;
  process.stdout.write(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u001b\\`);
  try {
    const child = spawnClipboardWriter(text);
    child.on('error', () => {
      /* OSC 52 was already sent */
    });
    child.stdin?.on('error', () => {
      /* the reader closed early; the OSC 52 copy stands */
    });
  } catch {
    // OSC 52 was already sent.
  }
}

function spawnClipboardWriter(text: string): ChildProcess {
  if (process.platform === 'win32') {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
      ],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.stdin?.end(text, 'utf8');
    child.unref();
    return child;
  }
  if (process.platform === 'darwin') {
    const child = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin?.end(text, 'utf8');
    child.unref();
    return child;
  }
  const wayland = spawn('wl-copy', { stdio: ['pipe', 'ignore', 'ignore'] });
  wayland.on('error', () => {
    try {
      const x11 = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
      x11.on('error', () => {});
      x11.stdin?.on('error', () => {});
      x11.stdin?.end(text, 'utf8');
      x11.unref();
    } catch {
      // OSC 52 was already sent.
    }
  });
  wayland.stdin?.end(text, 'utf8');
  wayland.unref();
  return wayland;
}
