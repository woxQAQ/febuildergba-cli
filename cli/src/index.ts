#!/usr/bin/env node
/**
 * fe-rom - GBA Fire Emblem ROM extractor. Parses FE6/FE7/FE8 once into a SQLite
 * database; everything downstream reads the db, not the ROM:
 *     node src/index.ts extract ../fixtures/dream-of-five.gba
 *     node src/index.ts roster dream-of-five.db
 *     sqlite3 dream-of-five.db 'SELECT name, level FROM units WHERE has_support_data'
 *
 * Runs on Node >= 22.18 (type stripping on by default; 22.6-22.17 need
 * `--experimental-strip-types`). Storage is Node's `node:sqlite`; drizzle-orm
 * is the one runtime dependency.
 *
 * This file is the shell only: parse argv, load the command's input (the ROM
 * for `extract`/`text`, the extract db for everything else), hand it to the
 * registered command, print. Adding a command is one `Command` file plus a
 * line in `src/commands/registry.ts`; the usage text, option parser and
 * dispatcher all read that registry.
 */

import { load, readRom, RomNotFoundError, UnsupportedRomError } from "./load.ts";
import { openExtract } from "./db/queries.ts";
import { UsageError } from "./commands/types.ts";
import type {
  AnyCommand,
  Command,
  CommandContext,
  DbCommandContext,
  ParsedCommandContext,
  TextCommandContext,
} from "./commands/types.ts";
import { parseArgv } from "./cli/args.ts";
import { commandHelp, suggestions, usage } from "./cli/help.ts";
import { emit } from "./cli/emit.ts";

/**
 * Bad invocation: the user can fix it by typing something else. Exit 2.
 * `usage` is suppressed for errors that already carry their own one-line
 * usage (a stray positional, say).
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

/**
 * The two ROM errors a user can act on, as one-line messages: an unsupported or
 * truncated file, and a path that does not exist (the most common mistake
 * here). Anything else is a bug and propagates. Returns whether it reported.
 */
function reportRomError(error: unknown): boolean {
  if (error instanceof UnsupportedRomError) {
    failRom(error.message);
    return true;
  }
  if (error instanceof RomNotFoundError) {
    failRom(`${error.message}\n  tried: ${error.path}`);
    return true;
  }
  return false;
}

function main(): void {
  void run();
}

/** Run the command and print its payload; turns a UsageError into exit 2. */
async function runAndEmit(command: Command<"rom", "text">, context: TextCommandContext): Promise<void>;
async function runAndEmit(
  command: Command<"rom", "parsed">,
  context: ParsedCommandContext,
): Promise<void>;
async function runAndEmit(command: Command<"db">, context: DbCommandContext): Promise<void>;
async function runAndEmit(command: AnyCommand, context: CommandContext): Promise<void> {
  try {
    // The overloads pin the context to the command's `input`; the union call
    // signature here is the one place that knowledge is not expressible.
    const payload = await (command.run as (context: CommandContext) => unknown)(context);
    emit(payload);
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

async function run(): Promise<void> {
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
    fail("no command given", true);
    return;
  }

  if (resolved === null) {
    const near = suggestions(command);
    const hint = near.length === 0 ? "" : `\nDid you mean: ${near.join(", ")}?`;
    fail(`unknown command "${command}"${hint}`);
    return;
  }

  if (romPath === "") {
    const isDb = resolved.input === "db";
    const input = isDb ? "an extract db path" : "a ROM path";
    fail(
      `"${command}" needs ${input}\n\nUsage: fe-rom ${command} ${isDb ? "<file.db>" : "<rom.gba>"} [options]`,
    );
    return;
  }

  if (resolved.input === "db") {
    // The analysis commands' input is the db `extract` wrote, opened
    // read-only; a missing file or a non-extract db is a one-line exit 1,
    // the same treatment an unreadable ROM gets. The handle stays open with
    // the command - `ExtractHandle.close` runs once it has finished, so a
    // query the command never reaches is never run at all.
    let extract;
    try {
      extract = openExtract(romPath);
    } catch (error) {
      failRom(error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      await runAndEmit(resolved, { extract, flags, args });
    } finally {
      extract.close();
    }
    return;
  }

  // `text` decodes ids and needs no table, so it stops at the identified ROM;
  // `extract` is the only command that pays for the full parse. `romInput` is a
  // per-command literal, so dispatch is a switch rather than a runtime lookup:
  // the guard below is the one place the pair of overloads is picked apart.
  if (resolved.romInput === "text") {
    let rom;
    try {
      rom = readRom(romPath);
    } catch (error) {
      if (reportRomError(error)) return;
      throw error;
    }
    await runAndEmit(resolved as Command<"rom", "text">, { rom, flags, args });
    return;
  }

  let rom;
  try {
    rom = load(romPath, flags.lang === undefined ? {} : { language: flags.lang });
  } catch (error) {
    if (reportRomError(error)) return;
    throw error;
  }

  await runAndEmit(resolved as Command<"rom", "parsed">, { rom, flags, args });
}

main();
