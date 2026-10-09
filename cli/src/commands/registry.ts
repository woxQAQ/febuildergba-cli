import type { Command } from './types.ts';

import { info } from './info.ts';
import { units } from './units.ts';
import { classes } from './classes.ts';
import { roles } from './roles.ts';
import { supports } from './supports.ts';
import { terrain } from './terrain.ts';
import { chapters } from './chapters.ts';
import { items } from './items.ts';
import { shops } from './shops.ts';
import { objects } from './objects.ts';
import { enemyStats } from './enemyStats.ts';
import { text } from './text.ts';
import { validate } from './validate.ts';

/**
 * Every command, in the order the usage table lists them.
 *
 * This array is the only place a command needs to be registered: the usage
 * text, the command table, the dispatcher and the "unknown command" error all
 * read from here. Adding a command is one file plus one line in this list.
 */
export const COMMANDS: readonly Command[] = [
  info,
  units,
  classes,
  roles,
  supports,
  terrain,
  chapters,
  items,
  shops,
  objects,
  enemyStats,
  text,
  validate,
];

/** Look up a command by the word the user typed, or `undefined`. */
export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Longest command name, so the usage table can pad its column. */
export function commandColumnWidth(): number {
  return COMMANDS.reduce((n, c) => Math.max(n, c.name.length), 0);
}