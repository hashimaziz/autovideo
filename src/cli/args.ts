/**
 * CLI argument parsing.
 *
 * Hand-rolled rather than a dependency. The surface is small, and a renderer that ships with a
 * command-line parser drags that parser's breaking changes into every release.
 *
 * Kept separate from the command implementations so it can be unit-tested without spawning a
 * browser.
 */

/** A parsed command line. */
export interface ParsedArgs {
  /** Positional arguments, in order. */
  positionals: string[];
  /** `--name value` and `--name=value`. */
  options: Record<string, string>;
  /** `--flag` with no value. */
  flags: Set<string>;
}

/** Parse `argv` into positionals, options and flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;

    // `-o` is a single-dash short option. Treated the same as `--name`, because the usage text
    // advertises `-o, --output` and a parser that silently ignored one of them would be worse
    // than not offering it.
    //
    // A single-dash token only counts as an option when its body starts with a letter, so a
    // negative number stays a positional instead of becoming an option named "5".
    const isShortOption = /^-[A-Za-z][\w-]*$/.test(token);
    const isOption = token.startsWith('--') || isShortOption;

    if (!isOption) {
      positionals.push(token);
      continue;
    }

    const body = token.replace(/^--?/, '');
    const equals = body.indexOf('=');

    if (equals !== -1) {
      options[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }

    // `--name value`, unless the next token is another flag or the list has ended.
    const next = argv[index + 1];
    if (next !== undefined && !(next.startsWith('-') && next !== '-')) {
      options[body] = next;
      index++;
      continue;
    }

    flags.add(body);
  }

  return { positionals, options, flags };
}

/** Read an option as a string, with a default. */
export function option(args: ParsedArgs, name: string, fallback: string): string {
  return args.options[name] ?? fallback;
}

/** Read an option as an integer, falling back when absent or unparseable. */
export function intOption(
  args: ParsedArgs,
  name: string,
  fallback: number,
  range?: { min?: number; max?: number },
): number {
  const raw = args.options[name];
  if (raw === undefined) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;

  const min = range?.min ?? Number.NEGATIVE_INFINITY;
  const max = range?.max ?? Number.POSITIVE_INFINITY;
  return value < min || value > max ? fallback : value;
}

/** Read a flag, which may also be given as `--flag=true`. */
export function flag(args: ParsedArgs, name: string): boolean {
  if (args.flags.has(name)) return true;
  const value = args.options[name];
  return value === 'true' || value === '1' || value === '';
}

/** Reject unknown options rather than silently ignoring them. */
export function unknownOptions(args: ParsedArgs, known: readonly string[]): string[] {
  return [...Object.keys(args.options), ...args.flags].filter((name) => !known.includes(name));
}
