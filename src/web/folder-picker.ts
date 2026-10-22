import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectFolder } from '../projects/store.js';

const run = promisify(execFile);
let picking = false;

/** The folders belong to the machine running Ranite, including remote browsers. */
export async function pickProjectFolder(): Promise<string | null> {
  if (picking) throw new Error('A folder picker is already open.');
  picking = true;
  try {
    if (process.platform === 'win32') {
      const script = `Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
[System.Windows.Forms.Application]::EnableVisualStyles()
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Choose the project source folder'
$picker.ShowNewFolderButton = $false
try { if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picker.SelectedPath | ConvertTo-Json -Compress } else { 'null' } } finally { $picker.Dispose() }`;
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 180000, maxBuffer: 131072 },
      );
      const selected: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      return selected === null ? null : projectFolder(selected);
    }
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the project source folder")'], {
          timeout: 180000,
        });
        return projectFolder(stdout.trim());
      } catch (error) {
        if (String((error as { stderr?: string }).stderr).includes('(-128)')) return null;
        throw error;
      }
    }
    try {
      const { stdout } = await run('zenity', ['--file-selection', '--directory', '--title=Choose the project source folder'], {
        timeout: 180000,
      });
      return projectFolder(stdout.trim());
    } catch (error) {
      if ((error as { code?: number }).code === 1) return null;
      throw new Error('The folder picker could not open on this machine. Type the folder path instead.');
    }
  } finally {
    picking = false;
  }
}
