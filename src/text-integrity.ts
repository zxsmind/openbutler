/**
 * Post-write integrity checks for text files.
 *
 * A text replacement tool can only honour what it was asked to replace. When the
 * anchor is wrong the damage is structural, not syntactic: a line lands twice, a
 * declaration disappears while its references stay, a block is left unclosed, or
 * an encoding round-trip turns every non-ASCII character into mojibake. All of
 * those were observed in real sessions and none of them is caught until a full
 * typecheck runs, minutes later.
 *
 * These checks are deliberately cheap and syntactic, so they run on every write
 * and cannot block a legitimate edit. Anything that could be intentional is a
 * warning; only damage that is never intended refuses the write.
 */

export interface IntegrityReport {
  /** Damage that must not be written. */
  errors: string[];
  /** Suspicious shapes that are reported but written. */
  warnings: string[];
}

const DECLARATION =
  /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:function|class|interface|type|enum|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/g;

/** Names bound by `import { a, b as c }`. */
function importedNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/import[ \t]+(?:type[ \t]+)?\{([^}]*)\}[ \t]*from/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return names;
}

function declaredNames(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const record = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const match of text.matchAll(DECLARATION)) record(match[1]!);
  for (const name of importedNames(text)) record(name);
  return counts;
}

/** Lines that appear twice in a row, ignoring trailing whitespace. */
function adjacentDuplicates(text: string): Set<string> {
  const lines = text.split('\n');
  const duplicates = new Set<string>();
  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1]!.trimEnd();
    const current = lines[index]!.trimEnd();
    if (previous === current && previous.trim().length > 0) duplicates.add(previous);
  }
  return duplicates;
}

function balance(text: string): { braces: number; parens: number; brackets: number } {
  const count = (character: string) => text.split(character).length - 1;
  return { braces: count('{') - count('}'), parens: count('(') - count(')'), brackets: count('[') - count(']') };
}

/** Double-encoded UTF-8 shows up as these pairs and never in intended text. */
const MOJIBAKE = /\u00C2[\u0080-\u00BF\u00B7]|\u00C3[\u0080-\u00BF]|\u00E2\u20AC[\u0161\u009C\u009D]|\u00E2\u2020\u2019/g;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].length;
}

export function inspectTextIntegrity(input: { before: string | null; after: string; path: string }): IntegrityReport {
  const { before, after } = input;
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Encoding damage: a BOM or doubled encoding that the previous content did
  //    not have. This is the shell round-trip signature.
  const hadBom = before !== null && before.charCodeAt(0) === 0xfeff;
  const hasBom = after.charCodeAt(0) === 0xfeff;
  if (!hadBom && hasBom) errors.push('the new content starts with a UTF-8 BOM that the file did not have');

  const beforeMojibake = before === null ? 0 : countMatches(before, MOJIBAKE);
  const afterMojibake = countMatches(after, MOJIBAKE);
  if (afterMojibake > beforeMojibake) {
    errors.push(
      `the new content contains ${afterMojibake - beforeMojibake} doubled-encoded character sequence(s); a UTF-8 file was probably rewritten through a tool that read it as ANSI`,
    );
  }

  // 2. Structure: a file that balanced its brackets before must still balance
  //    them. Anything else means a block was opened or closed by accident.
  if (before !== null) {
    const previous = balance(before);
    const next = balance(after);
    const wasBalanced = previous.braces === 0 && previous.parens === 0 && previous.brackets === 0;
    const isBalanced = next.braces === 0 && next.parens === 0 && next.brackets === 0;
    if (wasBalanced && !isBalanced) {
      const parts = [
        next.braces === 0 ? null : `${next.braces > 0 ? 'unclosed' : 'extra'} brace(s) (${next.braces})`,
        next.parens === 0 ? null : `${next.parens > 0 ? 'unclosed' : 'extra'} parenthesis/parentheses (${next.parens})`,
        next.brackets === 0 ? null : `${next.brackets > 0 ? 'unclosed' : 'extra'} bracket(s) (${next.brackets})`,
      ].filter(Boolean);
      errors.push(`the edit leaves ${parts.join(', ')}`);
    }
  }

  // 3. A declaration that disappeared while its name still appears elsewhere is
  //    the signature of an anchor that swallowed the line.
  const beforeNames = before === null ? new Map<string, number>() : declaredNames(before);
  const afterNames = declaredNames(after);
  const removed: string[] = [];
  for (const name of beforeNames.keys()) {
    if (afterNames.has(name)) continue;
    const references = [...after.matchAll(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g'))].length;
    if (references > 0) removed.push(`${name} (${references} remaining reference(s))`);
  }
  if (removed.length > 0) {
    warnings.push(`no longer declared but still present: ${removed.slice(0, 5).join(', ')}`);
  }

  // 4. The same name declared twice, where the previous content did not do that.
  const doubled: string[] = [];
  for (const [name, count] of afterNames) {
    if (count < 2) continue;
    if ((beforeNames.get(name) ?? 0) >= 2) continue;
    doubled.push(name);
  }
  if (doubled.length > 0) warnings.push(`declared more than once: ${doubled.slice(0, 5).join(', ')}`);

  // 5. A line that now appears twice in a row: the duplicate-insert signature.
  const previousDuplicates = before === null ? new Set<string>() : adjacentDuplicates(before);
  const fresh = [...adjacentDuplicates(after)].filter((line) => !previousDuplicates.has(line));
  if (fresh.length > 0) {
    warnings.push(
      `a line now repeats immediately: ${fresh
        .slice(0, 3)
        .map((line) => JSON.stringify(line.trim().slice(0, 60)))
        .join(', ')}`,
    );
  }

  return { errors, warnings };
}
