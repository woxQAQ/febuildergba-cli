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
   * Order here is the order the flag appears in a command's help.
   */
  readonly commands?: readonly string[];
  /** Per-command clarification appended to `summary`, keyed by command name. */
  readonly notes?: Readonly<Record<string, string>>;
}

export const FLAGS: readonly FlagSpec[] = [
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
    name: 'help',
    type: 'boolean',
    short: 'h',
    summary: 'Show usage; with a command, that command\'s options',
  },
  {
    name: 'all',
    type: 'boolean',
    summary: 'Include empty/unused table slots',
    commands: ['units', 'classes', 'terrain', 'items', 'objects', 'chapters'],
    notes: {
      chapters: 'also include non-character join records',
    },
  },
  {
    name: 'playable-only',
    type: 'boolean',
    summary:
      'Restrict to units that carry support data - the closest thing to a real roster this parse can offer',
    commands: ['units', 'roles', 'chapters'],
  },
  {
    name: 'hard',
    type: 'boolean',
    summary:
      '(enemy-stats) Project hard-mode stats: the promoted autolevel round is 19 levels instead of 9',
    commands: ['enemy-stats'],
  },
  {
    name: 'range',
    type: 'string',
    arg: '<a-b>',
    summary: '(text) Decode a contiguous id range, inclusive',
    commands: ['text'],
  },
];

/** Flags accepted by every command, by name. */
export function globalFlags(): readonly FlagSpec[] {
  return FLAGS.filter((f) => f.commands === undefined);
}

/**
 * The flags a command accepts: its own plus every global one. `command` may be
 * `null` (no command given yet), in which case only the globals are known and
 * the parse stays permissive - see `src/cli/args.ts`.
 */
export function flagsFor(command: string | null): readonly FlagSpec[] {
  if (command === null) return globalFlags();
  const local = FLAGS.filter((f) => f.commands?.includes(command) === true);
  return [...globalFlags(), ...local];
}