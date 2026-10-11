/**
 * Hand-rolled argument parsing.
 *
 * Thirty lines instead of a dependency: a CLI that runs a dozen times a day
 * should not carry a parser to read `--flag value`. Handles `--flag value`,
 * `--flag=value`, bare `--flag`, and positional words after the command.
 */

export interface Parsed {
  command: string;
  /** True when no command word was given, so a bare invocation means "help". */
  bare: boolean;
  /** Positional words after the command, e.g. `keys create`. */
  words: string[];
  flags: Map<string, string>;
  booleans: Set<string>;
}

/**
 * @param defaultCommand Used when argv is empty. A bare CLI with nothing to do
 *   opens the wizard rather than printing usage nobody asked for.
 */
export function parseArgs(argv: string[], defaultCommand = ''): Parsed {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const words: string[] = [];
  const [command = defaultCommand, ...rest] = argv;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      booleans.add(name);
    }
  }
  return { command, bare: argv.length === 0, words, flags, booleans };
}

export function requireFlag(parsed: Parsed, name: string): string {
  const value = parsed.flags.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/**
 * Joins positional words and a flag into one value, so `--c "is docker up"`
 * and `is docker up` are the same request.
 */
export function questionFrom(parsed: Parsed): string | undefined {
  const flag = parsed.flags.get('c');
  if (flag) return flag;
  const joined = parsed.words.join(' ').trim();
  return joined.length > 0 ? joined : undefined;
}
