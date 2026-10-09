#!/usr/bin/env node
/**
 * fe-rom - GBA Fire Emblem ROM parser.
 *
 * Extracts unit, class and support data from FE6/FE7/FE8 ROMs so it can be fed
 * to an AI for analysis.
 *
 * Runs directly on Node >= 22.18, where TypeScript type stripping is on by
 * default (22.6 - 22.17 need `--experimental-strip-types`):
 *
 *     node src/index.ts units ../fixtures/dream-of-five.gba
 *
 * Zero runtime dependencies.
 *
 * This file is only the shell: parse argv, load the ROM, hand both to the
 * registered command, print the result. Everything else lives in `src/cli`
 * (flags, help, output) and `src/commands` (one file per command). To add a
 * command, drop a `Command` into `src/commands/` and list it in
 * `src/commands/registry.ts` - the usage text, the option parser and the
 * dispatcher all read from that one registry.
 */

import { formatLoadTrace, loadRom, loadStatsFor, RomNotFoundError, UnsupportedRomError } from './load.ts';
import { UsageError } from './commands/types.ts';
import { parseArgv } from './cli/args.ts';
import { commandHelp, suggestions, usage } from './cli/help.ts';
import { emit } from './cli/emit.ts';

/**
 * Bad invocation: the user can fix it by typing something else. Exit 2,
 * matching the old CLI. `usage` is suppressed for errors that already carry
 * their own one-line usage (a stray positional, say).
 */
function fail(message: string, showUsage = true): void {
  console.error(`error: ${message}`);
  if (showUsage) console.error(`\n${usage()}`);
  process.exitCode = 2;
}

/** The ROM is wrong, not the command line. Exit 1, no usage - nothing to retype. */
function failRom(message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    // Argument errors are the user's to fix, not a crash.
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const { command, resolved, romPath, args, flags, help } = parsed;

  if (help) {
    console.log(resolved === null ? usage() : commandHelp(resolved));
    return;
  }

  if (command === null) {
    fail('no command given', true);
    return;
  }

  if (resolved === null) {
    const near = suggestions(command);
    const hint = near.length === 0 ? '' : `\nDid you mean: ${near.join(', ')}?`;
    fail(`unknown command "${command}"${hint}`);
    return;
  }

  if (romPath === '') {
    fail(`"${command}" needs a ROM path\n\nUsage: fe-rom ${command} <rom.gba> [options]`);
    return;
  }

  let rom;
  try {
    rom = loadRom(romPath, flags.lang === undefined ? {} : { language: flags.lang });
  } catch (error) {
    if (error instanceof UnsupportedRomError) {
      failRom(error.message);
      return;
    }
    // A path that does not exist is the single most common mistake here, so it
    // gets the same one-line treatment as an unsupported ROM - not a stack.
    if (error instanceof RomNotFoundError) {
      failRom(`${error.message}\n  tried: ${error.path}`);
      return;
    }
    throw error;
  }

  try {
    const payload = resolved.run({ rom, flags, args });
    emit(payload, flags);
    // After the payload, on stderr, so `--out` stays pipeable and the numbers
    // describe the run that produced it.
    if (flags.timings) {
      const stats = loadStatsFor(rom);
      if (stats !== undefined) console.error(formatLoadTrace(stats));
    }
    const code = resolved.exitCode?.(payload) ?? 0;
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    // The command may have been called with something it cannot accept - a
    // malformed `--range`, a text id that is not a number. That is still the
    // user's to fix, so it exits 2 like every other usage error.
    if (error instanceof UsageError) {
      fail(error.message);
      return;
    }
    failRom(error instanceof Error ? error.message : String(error));
  }
}

main();