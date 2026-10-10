/**
 * The option registry - the single place every CLI flag is declared.
 *
 * Each flag carries its own help text and the list of commands that actually
 * read it. `src/cli/args.ts` builds the `parseArgs` config from that list, so
 * a flag a command does not use is rejected instead of silently swallowed.
 * Global flags (no `commands` key) are accepted by every command.
 *
 * Adding a command-local flag therefore takes two edits: declare it here, then
 * read `ctx.flags.<name>` in the command. Nothing else - not the usage text,
 * not the option parser, not the dispatcher - needs to know it exists.
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
   * Typed as `CommandName` so a misspelling is a compile error - as a plain
   * string it made the flag silently unavailable to the command it was meant
   * for, and nothing reported it. Order here is the order the flag appears in
   * a command's help.
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
      "SQLite output path; default is the ROM's file stem with .db, in the " +
      "current directory. An existing file is replaced",
    commands: ["extract"],
  },
  {
    name: "lang",
    type: "string",
    arg: `<${LANGUAGE_NAMES.join("|")}>`,
    summary:
      "Language for the config/data name tables (chapter conditions, class " +
      "ability bits) baked into the db; default en, and a missing translation " +
      'falls back to English then Japanese. "ja" is the bare upstream file',
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
