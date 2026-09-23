/** Tiny, dependency-free argv parser: `--flag value`, `--flag=value`, booleans, `--` terminator. */

export type FlagType = 'string' | 'boolean';

export interface FlagSpec {
  type: FlagType;
  /** Value placeholder shown in help, e.g. "<sats>". */
  arg?: string;
  description: string;
  short?: string;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | undefined>;
}

/** Exit codes (documented in README and `scribbit --help`). */
export const EXIT = Object.freeze({
  OK: 0,
  /** Upstream / unexpected failure (fee source unreachable, internal error). */
  FAILURE: 1,
  /** Bad command line: unknown command/flag, missing or malformed value. */
  USAGE: 2,
  /** Input rejected: unreadable file, content too large for any lane, invalid PSBT. */
  INPUT: 3,
});

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usage = (message: string, details?: unknown) => new CliError(message, EXIT.USAGE, 'usage', details);
export const rejected = (code: string, message: string, details?: unknown) => new CliError(message, EXIT.INPUT, code, details);
export const failure = (code: string, message: string, details?: unknown) => new CliError(message, EXIT.FAILURE, code, details);

export function parseArgs(argv: readonly string[], spec: Record<string, FlagSpec>): ParsedArgs {
  const positionals: string[] = [];
  const flags: ParsedArgs['flags'] = {};
  const byShort = new Map(Object.entries(spec).flatMap(([name, s]) => (s.short ? [[s.short, name] as const] : [])));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) inline = a.slice(eq + 1);
    } else if (/^-[a-zA-Z]$/.test(a)) {
      name = byShort.get(a.slice(1));
      if (!name) throw usage(`unknown option ${a}`);
    } else {
      positionals.push(a);
      continue;
    }
    const s = spec[name];
    if (!s) throw usage(`unknown option --${name}${suggest(name, Object.keys(spec))}`);
    if (flags[name] !== undefined) throw usage(`--${name} given more than once`);
    if (s.type === 'boolean') {
      if (inline !== undefined) throw usage(`--${name} does not take a value`);
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--')))
      throw usage(`--${name} needs a value${s.arg ? ` ${s.arg}` : ''}`);
    flags[name] = value;
  }
  return { positionals, flags };
}

function suggest(name: string, known: string[]): string {
  const hit = known.find((k) => k.startsWith(name) || name.startsWith(k) || distance(k, name) <= 2);
  return hit ? ` (did you mean --${hit}?)` : '';
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

export function helpFor(command: string, summary: string, synopsis: string, spec: Record<string, FlagSpec>, extra = ''): string {
  const rows = Object.entries(spec).map(([name, s]) => [`${s.short ? `-${s.short}, ` : '    '}--${name}${s.arg ? ` ${s.arg}` : ''}`, s.description] as const);
  const w = Math.max(...rows.map(([l]) => l.length));
  return [
    `scribbit ${command}: ${summary}`,
    '',
    `Usage: ${synopsis}`,
    '',
    'Options:',
    ...rows.map(([l, d]) => `  ${l.padEnd(w)}  ${d}`),
    ...(extra ? ['', extra] : []),
    '',
  ].join('\n');
}
