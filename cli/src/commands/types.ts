import type { RomHandle } from "../load.ts";

/**
 * Every command word, as a literal union.
 *
 * This is the single source of truth for "which commands exist", so that two
 * things are checked rather than free strings:
 *
 *   - `Command.name` - a command whose name is not in here is a typo, and a
 *     compile error rather than a command the registry never matches.
 *   - `FlagSpec.commands` / `FlagSpec.notes` - a misspelled command name in a
 *     flag declaration would make that flag silently unavailable.
 *
 * Adding a command: add the word here, then let `registry.ts` fail to compile
 * until you have registered it there too.
 */
export type CommandName =
  | "extract"
  | "text"
  | "roster"
  | "roles"
  | "supports"
  | "transitions"
  | "recruits"
  | "gains"
  | "joins";

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

/** Everything a command body needs: the parsed argv plus the identified ROM. */
export interface CommandContext {
  /**
   * The identified ROM. `text` reads it directly; `extract` passes it to
   * `parseRom` - see `load.ts` for why those are separate stages.
   */
  rom: RomHandle;
  /** Resolved global + command-local flags. */
  flags: ResolvedFlags;
  /** Positionals after the ROM path - `text` takes text ids here. */
  args: string[];
}

export interface Command {
  /** Word the user types; unique across the registry. */
  readonly name: CommandName;
  /** One line, shown in the command table. */
  readonly summary: string;
  /** Longer text for `fe-rom <command> --help`; defaults to `summary`. */
  readonly description?: string;
  /** Usage-line tail after `[options]`, for commands with bare positionals. */
  readonly extraArgs?: string;
  /** Run the command; only after the ROM has loaded. */
  run(context: CommandContext): unknown | Promise<unknown>;
}

/** Convenience re-export so command bodies can take just the context. */
export type CommandRunner = (context: CommandContext) => unknown;
