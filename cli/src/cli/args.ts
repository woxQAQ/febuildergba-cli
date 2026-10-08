import { parseArgs } from 'node:util';

import { flagsFor, globalFlags, type FlagSpec } from './flags.ts';
import { findCommand } from '../commands/registry.ts';
import type { ResolvedFlags } from '../commands/types.ts';

export interface ParsedArgv {
  /** Command word, or `null` when the user gave none. */
  command: string | null;
  romPath: string;
  /** Positionals after the ROM path - `text` takes text ids here. */
  args: string[];
  flags: ResolvedFlags;
  /** `--help` / `-h` was given. Checked before the ROM is loaded. */
  help: boolean;
}

type OptionConfig = Record<string, { type: 'string' | 'boolean'; short?: string }>;

/**
 * `parseArgs` config built from the flags a command accepts.
 *
 * `strict: false` because the command word is itself a positional: the strict
 * flag set depends on which command it is, which we cannot know until argv has
 * been scanned. Unknown options are therefore collected rather than rejected,
 * and reported by `rejectUnknownFlags` below - as an error message instead of
 * an exception, and only when the command itself is real.
 */
function optionConfig(flags: readonly FlagSpec[]): OptionConfig {
  const options: OptionConfig = {};
  for (const flag of flags) {
    options[flag.name] =
      flag.short === undefined ? { type: flag.type } : { type: flag.type, short: flag.short };
  }
  return options;
}

/**
 * The first option in argv that the accepted set does not cover, as the user
 * typed it (`--foo`, `-x`, `--foo=bar`). `null` when everything is known.
 */
function firstUnknownFlag(argv: readonly string[], accepted: readonly FlagSpec[]): string | null {
  const long = new Set(accepted.map((f) => f.name));
  const short = new Set(accepted.flatMap((f) => (f.short === undefined ? [] : [f.short])));

  for (const token of argv) {
    if (token === '-' || !token.startsWith('-')) continue;
    const body = token.startsWith('--') ? token.slice(2) : token.slice(1);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    if (token.startsWith('--') ? long.has(name) : short.has(name)) continue;
    return token;
  }
  return null;
}

/**
 * Parse `argv` into a command, a ROM path, trailing positionals and flags.
 *
 * Throws a plain `Error` for input the user got wrong (unknown option); the
 * caller turns that into a message plus exit code 2.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  // First positional is the command word; the flags it accepts depend on it,
  // so a permissive pass with the global flags finds it.
  const peek = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: optionConfig(globalFlags()),
  });
  const command = peek.positionals[0] ?? null;

  const accepted = flagsFor(command);
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: optionConfig(accepted),
  });

  // Only worth complaining about once we know the command is real: otherwise
  // the "unknown command" message is the more useful one.
  if (command !== null && findCommand(command) !== undefined) {
    const bad = firstUnknownFlag(argv, accepted);
    if (bad !== null) throw new Error(`unknown option "${bad}" for "${command}"`);
  }

  const str = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === 'string' ? value : undefined;
  };

  // Hoisted so `exactOptionalPropertyTypes` sees a narrowed `string`, not
  // `string | undefined` re-widened by the second call.
  const out = str('out');
  const range = str('range');

  return {
    command,
    romPath: positionals[1] ?? '',
    args: positionals.slice(2),
    help: values.help === true,
    flags: {
      all: values.all === true,
      compact: values.compact === true,
      playableOnly: values['playable-only'] === true,
      hard: values.hard === true,
      ...(out === undefined ? {} : { out }),
      ...(range === undefined ? {} : { range }),
    },
  };
}