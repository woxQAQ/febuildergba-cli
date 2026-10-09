/**
 * The option registry - the single place every CLI flag is declared.
 *
 * Each flag carries its own help text and the list of commands that actually
 * read it. `src/cli/args.ts` builds the `parseArgs` config from that list, so
 * a flag a command does not use is rejected instead of silently swallowed.
 * Global flags (no `commands` key) are accepted by every command.
 *
 * Adding a command-local flag therefore takes two edits: declare it here, then
 * read `ctx.<camelCase>` in the command. Nothing else - not the usage text, not
 * the option parser, not the dispatcher - needs to know it exists.
 */
import { LANGUAGE_NAMES } from '../config/data.ts';
import type { Command, CommandName } from '../commands/types.ts';

export interface FlagSpec {
  /** Canonical name without the leading dashes. */
  readonly name: string;
  readonly type: 'string' | 'boolean';
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
    name: 'lang',
    type: 'string',
    arg: `<${LANGUAGE_NAMES.join('|')}>`,
    summary:
      `Language for the config/data name tables (chapter conditions, class ` +
      `ability bits); default en, and a missing translation falls back to ` +
      `English then Japanese. "ja" is the bare upstream file`,
  },
  {
    name: 'out',
    type: 'string',
    arg: '<file>',
    summary: 'Write JSON to a file instead of stdout',
  },
  {
    name: 'compact',
    type: 'boolean',
    summary: 'Emit compact JSON instead of pretty-printed',
  },
  {
    name: 'timings',
    type: 'boolean',
    summary:
      'Print per-table load times to stderr, with the expensive table a cheap-looking one pulled in',
  },
  {
    name: 'help',
    type: 'boolean',
    short: 'h',
    summary: 'Show usage; with a command, that command\'s options',
  },
  {
    name: 'all',
    type: 'boolean',
    summary: 'Include empty/unused table slots',
    commands: [
      'units', 'classes', 'terrain', 'items', 'objects', 'chapters', 'enemy-stats',
    ],
    notes: {
      units:
        'emit every slot, including the enemy / generic-template rows and the ' +
        'empty ones - a plain run is already restricted to the roster',
      classes: 'also resolve each class\' impassable terrain list',
      chapters:
        'also include padded map rows and the instruction-level transitions ' +
        'behind each chapter\'s destinations',
      'enemy-stats':
        'also emit `samples`, one row per projected enemy record - a plain run ' +
        'emits only the distributions computed from them',
    },
  },
  {
    name: 'playable-only',
    type: 'boolean',
    summary:
      'Restrict to units that carry support data - the closest thing to a real roster this parse can offer',
    commands: ['units', 'roles', 'chapters'],
    notes: {
      units: 'the default - a plain run already emits only those units',
    },
  },
  {
    name: 'hard',
    type: 'boolean',
    summary:
      'Project hard-mode stats: the promoted autolevel round is 19 levels instead of 9',
    commands: ['enemy-stats'],
  },
  {
    name: 'range',
    type: 'string',
    arg: '<a-b>',
    summary: 'Decode a contiguous id range, inclusive',
    commands: ['text'],
  },
];

/** Flags accepted by every command, by name. */
export function globalFlags(): readonly FlagSpec[] {
  return FLAGS.filter((f) => f.commands === undefined);
}

/**
 * Flags accepted by every command, by name.
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