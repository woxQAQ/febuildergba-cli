import { parseArgs } from "node:util";

import { FLAGS, flagsFor, type FlagSpec } from "./flags.ts";
import { findCommand } from "../commands/registry.ts";
import { isKnownLanguage, LANGUAGE_NAMES } from "../config/data.ts";
import type { Command, ResolvedFlags } from "../commands/types.ts";

export interface ParsedArgv {
  /** Command word exactly as typed, or `null` when the user gave none. */
  command: string | null;
  /** The registered command, or `null` when the word is not one. */
  resolved: Command | null;
  romPath: string;
  /** Positionals after the ROM path - `text` takes text ids here. */
  args: string[];
  flags: ResolvedFlags;
  /** `--help` / `-h` was given. Checked before the ROM is loaded. */
  help: boolean;
}

type OptionConfig = Record<string, { type: "string" | "boolean"; short?: string }>;

/**
 * `parseArgs` config built from the flags a command accepts.
 *
 * Built from **every** flag rather than from one command's set, because
 * tokenising argv must not depend on which command it turns out to be: whether
 * `--out` swallows the next token depends only on its type, never on who is
 * reading it. Which flags the command is *allowed* to use is enforced
 * separately, from the parse's own token list - see `firstUnknownOption`.
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
 * The first option `parseArgs` saw that the command does not accept, as the
 * user typed it.
 *
 * Membership only: the tokens come from `parseArgs`, so `--` (an
 * `option-terminator`, not an option), `--out -x` (one option token with the
 * value `-x`) and `--foo=bar` are all already classified the way the standard
 * says they should be. Nothing here re-scans argv.
 */
function firstUnknownOption(
  tokens: readonly {
    kind: string;
    name?: string;
    rawName?: string;
  }[],
  accepted: readonly FlagSpec[],
): string | null {
  const long = new Set(accepted.map((f) => f.name));
  const short = new Set(accepted.flatMap((f) => (f.short === undefined ? [] : [f.short])));

  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const name = token.name ?? "";
    if (name.length === 0) continue;
    const known = name.length > 1 ? long.has(name) : short.has(name);
    if (!known) return token.rawName ?? name;
  }
  return null;
}

/**
 * Parse `argv` into a command, a ROM path, trailing positionals and flags.
 *
 * Throws a plain `Error` for input the user got wrong (unknown option, unknown
 * `--lang`, a stray positional); the caller turns that into a message plus
 * exit code 2.
 *
 * There is exactly one parse here. The previous version ran `parseArgs` twice
 * and then hand-scanned argv to restore the strictness the first pass had to
 * give up, so "what does this argv mean" had two sources that disagreed: the
 * standard `--` terminator was reported as `unknown option "--"`, and the
 * value of `--out` was mistaken for a flag. One permissive parse plus a
 * membership check on its tokens removes the second source.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    tokens: true,
    options: optionConfig(FLAGS),
  });

  const command = positionals[0] ?? null;
  const resolved = command === null ? null : (findCommand(command) ?? null);
  const accepted = flagsFor(resolved);
  // Only worth complaining about once we know the command is real: otherwise
  // the "unknown command" message is the more useful one.
  if (resolved !== null) {
    const bad = firstUnknownOption(tokens, accepted);
    if (bad !== null) throw new Error(`unknown option "${bad}" for "${resolved.name}"`);

    // A command that documents no trailing positionals must not quietly accept
    // them: `fe-rom units rom.gba typo` used to run and exit 0, so a mistyped
    // flag or a forgotten argument was invisible. Everything after `--` lands
    // here too, which is what the terminator is for.
    const extra = positionals.slice(2);
    if (extra.length > 0 && resolved.extraArgs === undefined) {
      throw new Error(
        `"${resolved.name}" takes no extra arguments, but got: ${extra.join(" ")}\n` +
          `Usage: fe-rom ${resolved.name} <rom.gba> [options]`,
      );
    }
  }

  const str = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };

  // Hoisted so `exactOptionalPropertyTypes` sees a narrowed `string`, not
  // `string | undefined` re-widened by the second call.
  const out = str("out");
  const range = str("range");
  const lang = str("lang");
  if (lang !== undefined && !isKnownLanguage(lang)) {
    throw new Error(`--lang expects one of ${LANGUAGE_NAMES.join(", ")}, got "${lang}"`);
  }

  return {
    command,
    resolved,
    romPath: positionals[1] ?? "",
    args: positionals.slice(2),
    help: values.help === true,
    flags: {
      timings: values.timings === true,
      ...(out === undefined ? {} : { out }),
      ...(range === undefined ? {} : { range }),
      ...(lang === undefined ? {} : { lang }),
    },
  };
}
