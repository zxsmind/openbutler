/**
 * How to launch this checkout's CLI with Node.
 *
 * A source entry (`.ts`/`.tsx`) runs through the tsx loader; a built bundle
 * (`.js`) runs directly. The daemon, the web child and the login-startup
 * launcher all use this one function so they never disagree about the runtime.
 */
export function cliRuntimeArgs(entry: string): string[] {
  return /\.tsx?$/i.test(entry) ? ['--import', import.meta.resolve('tsx')] : [];
}

/** Runtime arguments followed by the entry point and its command words. */
export function cliNodeArgs(entry: string, command: readonly string[]): string[] {
  return [...cliRuntimeArgs(entry), entry, ...command];
}
