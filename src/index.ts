#!/usr/bin/env node
/**
 * CLI shell: parse arguments, dispatch to a resource-owning command, emit JSON.
 * The registry supplies the command table, help text and accepted flags.
 */
import { RomNotFoundError } from "./extract/service.ts";
import { UsageError } from "./commands/types.ts";
import { parseArgv } from "./cli/args.ts";
import { commandHelp, suggestions, usage } from "./cli/help.ts";
import { emit, type CommandMeta } from "./cli/emit.ts";
import { openExtract } from "./repository/read.ts";

/**
 * The db's game version, for the envelope's `meta`.
 *
 * A second open, deliberately: the dispatcher must not own the db lifetime that
 * a command manages, and this read is one indexed row. A db that cannot be read
 * at all is left to the command, which will report it with its own message.
 */
async function gameOfPath(path: string): Promise<string | undefined> {
  try {
    const repository = openExtract(path);
    try {
      return await repository.game();
    } finally {
      repository.close();
    }
  } catch {
    return undefined;
  }
}

/** Invalid invocation: exit 2, with usage unless already included. */
function fail(message: string, showUsage = true): void {
  console.error(`error: ${message}`);
  if (showUsage) console.error(`\n${usage()}`);
  process.exitCode = 2;
}

async function run(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const { command, resolved, path, args, flags, help } = parsed;
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
  if (path === "") {
    const isDb = resolved.input === "db";
    const input = isDb ? "an extract db path" : "a ROM path";
    fail(
      `"${command}" needs ${input}\n\nUsage: fe-rom ${command} ${isDb ? "<file.db>" : "<rom.gba>"} [options]`,
    );
    return;
  }

  try {
    const result = await resolved.run({ path, flags, args });
    // The envelope is assembled here rather than by each command: the command
    // word and the input path are dispatch facts, and putting them here is what
    // keeps every payload in the same shape.
    const game = resolved.input === "db" ? await gameOfPath(path) : undefined;
    const meta: CommandMeta = {
      command: resolved.name,
      path,
      ...(game === undefined ? {} : { game }),
      diagnostics: result.diagnostics ?? [],
      ...(result.parameters === undefined ? {} : { parameters: result.parameters }),
    };
    emit(result.data, meta);
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `error: ${message}${error instanceof RomNotFoundError ? `\n  tried: ${error.path}` : ""}`,
    );
    process.exitCode = 1;
  }
}

void run();
