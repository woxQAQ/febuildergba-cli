import type { LoadedRom } from '../load.ts';

/**
 * Flags resolved from the command line, after the command's own flag set has
 * been applied. `out === undefined` means stdout.
 */
export interface ResolvedFlags {
  out?: string;
  range?: string;
  /** `--lang` value; absent means the default (English). */
  lang?: string;
  all: boolean;
  compact: boolean;
  playableOnly: boolean;
  hard: boolean;
}

/**
 * A mistake in the arguments the user typed, as opposed to a failure parsing
 * the ROM. `index.ts` gives this exit code 2 and prints the usage; anything
 * else is exit 1.
 *
 * Throw this from a command body for anything the user can retype: a
 * malformed `--range`, a non-numeric text id. Validating before the ROM is
 * loaded is better still, but a command often cannot know what is valid until
 * it has parsed the tables.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Everything a command body needs: the parsed ROM plus the parsed argv. */
export interface CommandContext {
  rom: LoadedRom;
  /** Resolved global + command-local flags. */
  flags: ResolvedFlags;
  /** Positionals after the ROM path - `text` takes text ids here. */
  args: string[];
}

export interface Command {
  /** Word the user types. Unique across the registry. */
  readonly name: string;
  /** One line, shown in the command table. */
  readonly summary: string;
  /**
   * A longer description for `fe-rom <command> --help`. Defaults to `summary`.
   * Kept short enough to sit under one screen.
   */
  readonly description?: string;
  /**
   * Extra usage-line tail, appended after `[options]` in
   * `fe-rom <command> --help`. For commands that take bare positionals, e.g.
   * `text` and its text ids.
   */
  readonly extraArgs?: string;
  /** Build the JSON payload. Runs only after the ROM has loaded. */
  run(context: CommandContext): unknown;
  /**
   * Exit code the process should use, given what `run` returned. Only
   * `validate` needs this - it reports failures in its payload but still has
   * to write the report and exit non-zero. Defaults to 0.
   */
  exitCode?(payload: unknown): number;
}

/** Convenience re-export so command bodies can take just the context. */
export type CommandRunner = (context: CommandContext) => unknown;