import { unlinkSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { openDb } from "../db/index.ts";
import { populate } from "../db/populate.ts";
import type { Command } from "./types.ts";

/**
 * Default output path: the ROM's file stem with a `.db` suffix, in the
 * current directory - `fe-rom extract ../fixtures/dream-of-five.gba` writes
 * `./dream-of-five.db`.
 */
function defaultOutPath(romPath: string): string {
  const stem = basename(romPath, extname(romPath));
  return resolve(`${stem}.db`);
}

export const extract: Command = {
  name: "extract",
  summary: "Parse the whole ROM once into a SQLite database for SQL analysis",
  description:
    "Parses every table the ROM carries - units, classes, supports, chapters " +
    "and their event-script walks, items, shops, map objects, enemy " +
    "projections (both autolevel modes) - and writes it all to one SQLite " +
    "database. Analysis then queries the db instead of re-running the CLI: " +
    "filtering is a WHERE clause, joining is a JOIN, and neither costs a " +
    "re-parse.\n\n" +
    "The schema stores facts, not presentations: names join by id, prices " +
    "are `uses * unit_price`, the old `units` roster filter is the `roster` " +
    "view. See src/db/schema.ts for the full table list and conventions.\n\n" +
    "An existing output file is replaced: an extract is a rebuildable " +
    "artifact, not state.\n\n" +
    "Note: this uses Node's built-in node:sqlite, which prints an " +
    "ExperimentalWarning on stderr. It is harmless.",
  run: async ({ rom, flags }) => {
    const out = flags.out ?? defaultOutPath(rom.path);

    // Fresh extract: a stale db that half-survives looks like a finished one,
    // which is worse than losing it.
    try {
      unlinkSync(out);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const started = performance.now();
    const handle = openDb(out);
    let result;
    try {
      result = await populate(handle, rom);
    } finally {
      handle.close();
    }
    const elapsed = performance.now() - started;

    const rows = Object.values(result.tables).reduce((a, n) => a + n, 0);
    console.error(
      `extracted ${rows} rows across ${Object.keys(result.tables).length} tables ` +
        `into ${out} (${elapsed.toFixed(0)}ms)`,
    );
    if (result.unresolvedEnemyClasses > 0) {
      console.error(
        `warning: ${result.unresolvedEnemyClasses} enemy placement records had an ` +
          "unresolvable class id and are absent from enemy_samples",
      );
    }

    return { db: out, elapsedMs: Math.round(elapsed), tables: result.tables };
  },
};
