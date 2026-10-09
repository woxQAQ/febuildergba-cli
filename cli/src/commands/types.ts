import type { LoadedRom } from "../load.ts";

/**
 * Every command word, as a literal union.
 *
 * This is the single source of truth for "which commands exist", and it exists
 * so two things that used to be free strings become checked ones:
 *
 *   - `Command.name` - a command whose name is not in here is a typo, and now
 *     a compile error rather than a command the registry never matches.
 *   - `FlagSpec.commands` / `FlagSpec.notes` - a misspelled command name in a
 *     flag declaration used to make that flag silently unavailable, with
 *     nothing anywhere reporting it.
 *
 * Adding a command: add the word here, then let `registry.ts` fail to compile
 * until you have registered it there too.
 */
export type CommandName = "extract" | "text" | "validate";

/**
 * Flags resolved from the command line, after the command's own flag set has
 * been applied.
 */
export interface ResolvedFlags {
  /** `extract`: SQLite output path; absent means `<rom stem>.db`. */
  out?: string;
  /** `text`: an inclusive id range to decode. */
  range?: string;
  /** `extract`: language for the config/data name tables baked into the db. */
  lang?: string;
  /** Print per-table load times to stderr - see `load.ts`. */
  timings: boolean;
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
    this.name = "UsageError";
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
  readonly name: CommandName;
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
  /** Build the payload. Runs only after the ROM has loaded. */
  run(context: CommandContext): unknown | Promise<unknown>;
  /**
   * Exit code the process should use, given what `run` returned. Only
   * `validate` needs this - it reports failures in its payload but still has
   * to write the report and exit non-zero. Defaults to 0.
   */
  exitCode?(payload: unknown): number;
}

/** Convenience re-export so command bodies can take just the context. */
export type CommandRunner = (context: CommandContext) => unknown;
