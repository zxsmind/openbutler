import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FolderPicker } from './types.js';

const run = promisify(execFile);

/**
 * `SIGDN_FILESYSPATH`, the only `IShellItem::GetDisplayName` flag that returns a
 * full filesystem path. The other flags answer with a display name (`Desktop`,
 * a folder's last path segment) that no caller can treat as a path — that wrong flag
 * is what made every pick fail with "Choose an absolute folder path."
 */
const SIGDN_FILESYSPATH = 0x8001c000;

/**
 * The modern Common Item dialog (the folder-pick window with breadcrumbs) born
 * in this background child. Windows refuses to foreground a background process's
 * window while the reader's browser owns the foreground, so the dialog used to
 * open behind the browser and the request waited out its timeout. Attaching the
 * dialog thread to that foreground thread for the duration of Show shares its
 * input state — the documented SetForegroundWindow condition — and the finally
 * detaches so a cancel never leaves the threads bridged.
 * GUID pair for this machine's shell: CLSID_FileOpenDialog DC1C5A9C (registry
 * name "File Open Dialog") and IFileOpenDialog D57C7288; the same
 * behind-the-browser bug and AttachThreadInput fix are documented for an
 * identical web-GUI picker.
 */
const script = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FolderPick {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFOD {
    [PreserveSig] int Show(IntPtr h);
    [PreserveSig] int SetFileTypes(uint c, IntPtr p);
    [PreserveSig] int SetFileTypeIndex(uint i);
    [PreserveSig] int GetFileTypeIndex(out uint i);
    [PreserveSig] int Advise(IntPtr p, out uint c);
    [PreserveSig] int Unadvise(uint c);
    [PreserveSig] int SetOptions(uint fos);
    [PreserveSig] int GetOptions(out uint fos);
    [PreserveSig] int SetDefaultFolder(IntPtr p);
    [PreserveSig] int SetFolder(IntPtr p);
    [PreserveSig] int GetFolder(out IntPtr p);
    [PreserveSig] int GetCurrentSelection(out IntPtr p);
    [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] StringBuilder s);
    [PreserveSig] int GetTitle([MarshalAs(UnmanagedType.LPWStr)] StringBuilder s);
    [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int GetResult(out IntPtr p);
    [PreserveSig] int AddPlace(IntPtr p, int a);
    [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int Close(int hr);
    [PreserveSig] int SetClientGuid([MarshalAs(UnmanagedType.LPStruct)] Guid g);
    [PreserveSig] int ClearClientData();
    [PreserveSig] int SetFilter(IntPtr f);
    [PreserveSig] int GetResults(out IntPtr p);
    [PreserveSig] int GetSelectedItems(out IntPtr p);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetParent(out IShellItem ppsi);
    [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr ppszName);
    [PreserveSig] int GetAttributes(uint mask, out uint attribs);
    [PreserveSig] int Compare(IShellItem psi, uint hint, out int order);
  }
  public static string Run() {
    object dialog;
    try { dialog = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"))); }
    catch (Exception ex) { return "CREATE_FAIL:" + ex.Message; }
    IFOD d;
    try { d = (IFOD)dialog; } catch (Exception ex) { Marshal.ReleaseComObject(dialog); return "QI_FAIL:" + ex.Message; }
    IntPtr fg = GetForegroundWindow();
    uint my = GetCurrentThreadId();
    int foregroundPid;
    int foregroundThread = GetWindowThreadProcessId(fg, out foregroundPid);
    bool attached = fg != IntPtr.Zero && foregroundThread != 0 && (uint)foregroundThread != my && AttachThreadInput(my, (uint)foregroundThread, true);
    try {
      d.SetOptions(0x20 | 0x40 | 0x800);
      int hr = d.Show(IntPtr.Zero);
      if (hr == unchecked((int)0x800704C7)) return "cancel";
      if (hr != 0) return "SHOW_HR=0x" + hr.ToString("X8");
      IntPtr psi;
      d.GetResult(out psi);
      object shellObject = Marshal.GetObjectForIUnknown(psi);
      try {
        var item = (IShellItem)shellObject;
        IntPtr pth;
        item.GetDisplayName(0x${SIGDN_FILESYSPATH.toString(16)}, out pth);
        string path = Marshal.PtrToStringUni(pth);
        Marshal.FreeCoTaskMem(pth);
        return "path:" + path;
      } finally { Marshal.Release(psi); Marshal.ReleaseComObject(shellObject); }
    } catch (Exception ex) {
      return "RUN_FAIL:" + ex.GetType().Name + ":" + ex.Message;
    } finally {
      if (attached) AttachThreadInput(my, (uint)foregroundThread, false);
      Marshal.ReleaseComObject(dialog);
    }
  }
}
'@
$result = [FolderPick]::Run()
if ($result -like 'path:*') { $result.Substring(5) | ConvertTo-Json -Compress }
elseif ($result -eq 'cancel') { 'null' }
else { throw $result }`;

/** The dialog answers with a JSON string, JSON `null` on cancel, or an error. */
export const windowsFolderPicker: FolderPicker = async () => {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 180_000, maxBuffer: 131_072 },
  );
  const selected: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (selected === null) return null;
  if (typeof selected !== 'string' || selected.length === 0)
    throw new Error('The folder picker returned no folder path. Type the folder path instead.');
  return selected;
};
