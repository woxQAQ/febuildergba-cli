import { openExtract } from "../repository/read.ts";
import { prepareAnalysis, type AnalysisSource } from "../analysis/service.ts";

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
  | "supports"
  | "transitions"
  | "recruits"
  | "gains"
  | "joins"
  | "availability"
  | "candidates"
  | "niches"
  | "expcurve";
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
  /** `expcurve`: level of the attacker the budget is measured for. */
  actorLevel?: string;
  /** `expcurve`: class power of that attacker. */
  actorClassPower?: string;
  /** `expcurve`: whether that attacker is promoted. */
  actorPromoted?: boolean;
  /** `expcurve`: which difficulty's enemy levels to budget for. */
  difficulty?: string;
  /** `availability`: include the per-chapter status list (off by default). */
  full?: boolean;
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
 * What a command reads. `extract` and `text` read a ROM; analysis commands
 * read the database and never touch the ROM.
 */
export type CommandInput = "rom" | "db";

/**
 * ROM commands open their own input; the dispatcher only supplies arguments.
 */
export interface CommandContext {
  /** ROM or extract database path, as typed. */
  path: string;
  /** Resolved global + command-local flags. */
  flags: ResolvedFlags;
  /** Positionals after the ROM path - `text` takes text ids here. */
  args: string[];
}

/** Context inside a database command's owned resource lifetime. */
export interface DbCommandContext extends CommandContext {
  /** The open extract; call the queries the command actually reads. */
  extract: AnalysisSource;
}

/** Command metadata and its argument-only entry point. */
export interface Command<I extends CommandInput = CommandInput> {
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
  /** Run the command, including opening and closing its resources. */
  run(context: CommandContext): MaybePromise<CommandResult>;
}

/** Command bodies read cleaner as `async () => ({ data })` without importing a type. */
type MaybePromise<T> = T | Promise<T>;

/**
 * The registry retains each command's input kind for usage and flag selection.
 */
export type AnyCommand = Command<"rom"> | Command<"db">;

/**
 * What a command returns: its payload, plus the run facts the envelope carries.
 *
 * Commands return `{ data, diagnostics }` rather than a bare payload because the
 * diagnostics are produced during the run (reading the event layer is what
 * flags a partial decode) and have to travel with the payload that they qualify.
 * `data` stays `unknown` here: each command knows its own shape, and the
 * envelope is the only thing the dispatcher touches.
 */
export interface CommandResult {
  data: unknown;
  /** Warnings raised while producing `data`. Empty when none. */
  diagnostics?: readonly string[];
  /** Parameters the numbers were measured under; see `cli/emit.ts`. */
  parameters?: Readonly<Record<string, unknown>>;
}

/** Share the database lifetime without moving resource ownership to dispatch. */
export function defineDbCommand(
  command: Omit<Command<"db">, "run"> & {
    run(context: DbCommandContext): CommandResult | Promise<CommandResult>;
  },
): Command<"db"> {
  return {
    ...command,
    async run(context) {
      const repository = openExtract(context.path);
      const extract = prepareAnalysis(repository, context.path);
      try {
        const result = await command.run({ ...context, extract });
        // The session's diagnostics are read after the body ran - that is when
        // the event layer, if the command touched it, has been checked. They
        // travel in the envelope instead of stderr so a caller can see them
        // without losing stderr to its own redirections.
        return { ...result, diagnostics: extract.diagnostics() };
      } finally {
        repository.close();
      }
    },
  };
}
