import type { Command, CommandName } from "./types.ts";

import { extract } from "./extract.ts";
import { text } from "./text.ts";

/**
 * Every command, keyed by the word the user types.
 *
 * `Record<CommandName, Command>` rather than an array: it is the
 * only shape that makes "a command exists in `CommandName` but was never
 * registered" a compile error instead of a command that silently does not
 * exist. Declaration order below is the order the usage table lists them.
 *
 * This is the only place a command needs to be registered: the usage text,
 * the command table, the dispatcher and the "unknown command" error all read
 * from here. Adding a command is one file plus one line in this table.
 */
const REGISTRY: Readonly<Record<CommandName, Command>> = {
  extract,
  text,
};

/** Every command, in the order the usage table lists them. */
export const COMMANDS: readonly Command[] = Object.values(REGISTRY);

/**
 * Look up a command by the word the user typed, or `undefined`.
 *
 * `hasOwn` first because the word arrives as a plain `string`: without it a
 * prototype key such as `"toString"` would resolve to a function.
 */
export function findCommand(name: string): Command | undefined {
  return Object.hasOwn(REGISTRY, name) ? REGISTRY[name as CommandName] : undefined;
}

/**
 * The word the user typed, narrowed to a real `CommandName`. `null` when it is
 * not one, so callers can tell "no command given" from "unknown command"
 * without looking the name up twice.
 */
export function commandNameOf(word: string | undefined): CommandName | null {
  if (word === undefined || !Object.hasOwn(REGISTRY, word)) return null;
  return word as CommandName;
}

/** Longest command name, so the usage table can pad its column. */
export function commandColumnWidth(): number {
  return COMMANDS.reduce((n, c) => Math.max(n, c.name.length), 0);
}
