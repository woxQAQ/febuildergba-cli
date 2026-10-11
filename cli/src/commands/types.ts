import type { LoadedRom, ParsedRom } from "../load.ts";
import type { ExtractHandle } from "../db/queries.ts";

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
  | "joins"
  | "availability"
  | "expcurve"
  | "projection";

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

/**
 * What a command reads. `extract` parses the ROM; every other command reads the
 * db `extract` wrote - the db is the single source of truth, so the analysis
 * commands never touch the ROM.
 */
export type CommandInput = "rom" | "db";

/**
 * What an `"rom"` command's positional argument is. `text` decodes one id at a
 * time and needs the ROM only as bytes plus a Huffman context; `extract` reads
 * every table, so dispatch hands it the full parse. Narrowing here - rather
 * than in each command body - is what keeps the two from sharing a cost: the
 * context type a command declares is the work `index.ts` does for it.
 */
export type RomInput = "text" | "parsed";

/** Context for a `"rom"` command: the identified ROM. */
export interface TextCommandContext {
  /** The identified ROM; see {@link LoadedRom}. */
  rom: LoadedRom;
  /** Resolved global + command-local flags. */
  flags: ResolvedFlags;
  /** Positionals after the ROM path - `text` takes text ids here. */
  args: string[];
}

/** Context for `extract`: the ROM plus every table it persists. */
export interface ParsedCommandContext {
  rom: ParsedRom;
  flags: ResolvedFlags;
  args: string[];
}

/** Context for a `"db"` command: an extract db opened by `db/queries.ts`. */
export interface DbCommandContext {
  /** The open extract; call the queries the command actually reads. */
  extract: ExtractHandle;
  /** Resolved global + command-local flags. */
  flags: ResolvedFlags;
  /** Positionals after the db path. No current command takes any. */
  args: string[];
}

/** Everything a command body needs, discriminated by the command's `input`. */
export type CommandContext = TextCommandContext | ParsedCommandContext | DbCommandContext;

/**
 * The context a command with `input` receives. `"rom"` commands split on the
 * per-command {@link RomInput} rather than on `input`, because reading the ROM
 * is two different pieces of work.
 */
export type CommandContextFor<I extends CommandInput, R extends RomInput = RomInput> =
  I extends "rom" ? (R extends "text" ? TextCommandContext : ParsedCommandContext) : DbCommandContext;

export interface Command<
  I extends CommandInput = CommandInput,
  R extends RomInput = RomInput,
> {
  /** Word the user types; unique across the registry. */
  readonly name: CommandName;
  /** One line, shown in the command table. */
  readonly summary: string;
  /** Longer text for `fe-rom <command> --help`; defaults to `summary`. */
  readonly description?: string;
  /** Usage-line tail after `[options]`, for commands with bare positionals. */
  readonly extraArgs?: string;
  /** What the positional argument is: a ROM, or an extract db. */
  readonly input: I;
  /**
   * How much of a `"rom"` input to read - ignored for `"db"` commands, which
   * read none of it. The literal is what tells dispatch whether to hand the
   * body a {@link LoadedRom} or a full {@link ParsedRom}.
   */
  readonly romInput?: R;
  /** Run the command; only after its input has loaded. */
  run(context: CommandContextFor<I, R>): unknown | Promise<unknown>;
}

/**
 * The registry's element type. Keeping the `input` and `romInput` literals in
 * the type lets the dispatcher narrow the context it builds; a plain `Command`
 * would widen both away.
 */
export type AnyCommand =
  | Command<"rom", "text">
  | Command<"rom", "parsed">
  | Command<"db">;
