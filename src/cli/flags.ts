/**
 * The option registry - the single place every CLI flag is declared. Each flag
 * carries help text and the commands that read it; `src/cli/args.ts` builds the
 * `parseArgs` config from that list, so an unused flag is rejected rather than
 * swallowed. Global flags (no `commands` key) are accepted by every command.
 *
 * Adding a command-local flag is two edits: declare it here, read
 * `ctx.flags.<name>` in the command. Nothing else needs to know it exists.
 */
import { LANGUAGE_NAMES } from "../config/data.ts";
import type { Command, CommandName } from "../commands/types.ts";

export interface FlagSpec {
  /** Canonical name without the leading dashes. */
  readonly name: string;
  readonly type: "string" | "boolean";
  /** Single-letter alias, without the leading dash. */
  readonly short?: string;
  /** Metavar for value-taking flags, e.g. `<file>`. */
  readonly arg?: string;
  readonly summary: string;
  /**
   * Commands that read this flag, by name. Omitted means "every command".
   * Typed as `CommandName` so a misspelling is a compile error rather than a
   * flag silently unavailable to the command it was meant for. Order here is
   * the order the flag appears in a command's help.
   */
  readonly commands?: readonly CommandName[];
  /** Per-command clarification appended to `summary`, keyed by command name. */
  readonly notes?: Readonly<Partial<Record<CommandName, string>>>;
}

export const FLAGS: readonly FlagSpec[] = [
  {
    name: "out",
    type: "string",
    arg: "<db>",
    summary:
      "SQLite output path; default is the ROM's file stem with .db, in the "
      + "current directory. An existing file is replaced",
    commands: ["extract"],
  },
  {
    name: "lang",
    type: "string",
    arg: `<${LANGUAGE_NAMES.join("|")}>`,
    summary:
      "Language for the config/data name tables (chapter conditions, class "
      + "ability bits) baked into the db; default en, and a missing translation "
      + 'falls back to English then Japanese. "ja" is the bare upstream file',
    commands: ["extract"],
  },
  {
    name: "range",
    type: "string",
    arg: "<a-b>",
    summary: "Decode a contiguous id range, inclusive",
    commands: ["text"],
  },
  {
    name: "actor-level",
    type: "string",
    arg: "<n>",
    summary:
      "Level of the attacker the exp budget is measured for; default 20, the "
      + "highest unpromoted level",
    commands: ["expcurve"],
  },
  {
    name: "actor-class-power",
    type: "string",
    arg: "<n>",
    summary:
      "Class power (class table +26) of that attacker; fixed default 3, not "
      + "inferred from this ROM",
    commands: ["expcurve"],
  },
  {
    name: "actor-promoted",
    type: "boolean",
    summary:
      "Treat the attacker as promoted (effective level +20). Its class-bonus-B "
      + "term is not modelled; see the command's assumptions",
    commands: ["expcurve"],
  },
  {
    name: "difficulty",
    type: "string",
    arg: "<easy|normal|hard>",
    summary:
      "Budget for one difficulty's enemy levels; default emits all three. Hard "
      + "boosts enemy levels by the chapter's `hard_boost`, normal and easy cut "
      + "them by `normal_penalty` / `easy_penalty`",
    commands: ["expcurve"],
  },
  {
    name: "full",
    type: "boolean",
    summary:
      "Include the per-chapter status list. Off by default because it is most "
      + "of the payload; ask for it only when a question is about particular "
      + "chapters rather than a join position or a window length",
    commands: ["availability"],
  },
  {
    name: "from-position",
    type: "string",
    arg: "<n>",
    summary:
      "Inclusive model play-order position; default 1. Filters chapter counts "
      + "and budgets, never the candidate IDs or join evidence",
    commands: ["candidates", "availability", "expcurve"],
  },
  {
    name: "before-position",
    type: "string",
    arg: "<n>",
    summary:
      "Exclusive model play-order position; default one past the last step. "
      + "Use the target's position to exclude its own battle experience. "
      + "Does not select an executable story route",
    commands: ["candidates", "availability", "expcurve"],
  },
  {
    name: "help",
    type: "boolean",
    short: "h",
    summary: "Show usage; with a command, that command's options",
  },
];

/** Flags accepted by every command, by name. */
export function globalFlags(): readonly FlagSpec[] {
  return FLAGS.filter((f) => f.commands === undefined);
}

/**
 * Flags a command accepts, by name.
 *
 * `command` is the registered command rather than a bare word: an unknown word
 * has no flag set of its own, and the caller needs to know that to decide
 * whether an unrecognised option is worth reporting or whether "unknown
 * command" is the more useful message.
 */
export function flagsFor(command: Command | null): readonly FlagSpec[] {
  if (command === null) return globalFlags();
  const local = FLAGS.filter((f) => f.commands?.includes(command.name) === true);
  return [...globalFlags(), ...local];
}
