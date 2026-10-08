import type { LoadedRom } from '../load.ts';

/**
 * Flags resolved from the command line, after the command's own flag set has
 * been applied. `out === undefined` means stdout.
 */
export interface ResolvedFlags {
  out?: string;
  range?: string;
  all: boolean;
  compact: boolean;
  playableOnly: boolean;
  hard: boolean;
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