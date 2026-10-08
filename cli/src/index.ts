#!/usr/bin/env node
/**
 * fe-rom - GBA Fire Emblem ROM parser.
 *
 * Extracts unit, class and support data from FE6/FE7/FE8 ROMs so it can be fed
 * to an AI for analysis.
 *
 * Runs directly on Node >= 22.6 thanks to built-in TypeScript type stripping:
 *
 *     node src/index.ts dump ../../fixtures/dream-of-five.gba
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

import { loadRom, UnsupportedRomError } from './load.ts';
import { findCommand } from './commands/registry.ts';
import { parseArgv } from './cli/args.ts';
import { commandHelp, suggestions, usage } from './cli/help.ts';
import { emit } from './cli/emit.ts';

/** Bad invocation: the user can fix it. Exit 2, matching the old CLI. */
function fail(message: string, showUsage = true): void {
  console.error(`error: ${message}`);
  if (showUsage) console.error(`\n${usage()}`);
  process.exitCode = 2;
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

  const { command, romPath, args, flags, help } = parsed;

  if (help) {
    const target = command === null ? undefined : findCommand(command);
    console.log(target === undefined ? usage() : commandHelp(target));
    return;
  }

  if (command === null) {
    fail('no command given', true);
    return;
  }

  const resolved = findCommand(command);
  if (resolved === undefined) {
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
    rom = loadRom(romPath);
  } catch (error) {
    if (error instanceof UnsupportedRomError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    // Anything else (missing file, bad header) is unexpected: let it surface.
    throw error;
  }

  try {
    const payload = resolved.run({ rom, flags, args });
    emit(payload, flags);
    const code = resolved.exitCode?.(payload) ?? 0;
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();