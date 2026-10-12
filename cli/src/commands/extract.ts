import { renameSync, unlinkSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { extractData } from "../extract/service.ts";
import { openDb } from "../repository/open.ts";
import { writeSnapshot } from "../repository/write.ts";
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

/** Remove `path` if it exists; any other failure is real and propagates. */
function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export const extract: Command<"rom"> = {
  name: "extract",
  input: "rom",
  summary: "Parse the whole ROM once into a SQLite database for SQL analysis",
  description:
    "Parses every table the ROM carries - units, classes, supports, chapters " +
    "and their event-script walks, items, shops and map objects - and writes " +
    "it all to one SQLite database. Analysis then reads the db instead of the " +
    "ROM: the analysis commands take the .db as their input (`fe-rom roster " +
    "dream-of-five.db`, `fe-rom joins dream-of-five.db`, ...), and ad-hoc " +
    "questions are SQL - filtering is a WHERE clause, joining is a JOIN, and " +
    "neither costs a re-parse.\n\n" +
    "The schema stores facts, not presentations: names join by id, prices " +
    "are `uses * unit_price`; per-question derivations such as the roster of " +
    "support-bearing units are commands of their own. See src/repository/schema.ts " +
    "for the full table list and conventions.\n\n" +
    "An existing output file is replaced atomically: the extract is built " +
    "into a scratch file next to the output and renamed over it, so a failed " +
    "run leaves the previous database intact. The schema has no migrations - " +
    "an extract is a rebuildable artifact, not state.\n\n" +
    "Note: this uses Node's built-in node:sqlite, which prints an " +
    "ExperimentalWarning on stderr. It is harmless.",
  run: async ({ path, flags }) => {
    const out = flags.out ?? defaultOutPath(path);

    // Rebuild into a scratch file, then rename over the output: a failed
    // extract must not take the previous good database down with it. The
    // scratch file sits next to the output so the rename stays on one
    // filesystem.
    const tmp = `${out}.tmp`;
    unlinkIfExists(tmp);

    const started = performance.now();
    let result;
    try {
      const handle = openDb(tmp);
      try {
        const snapshot = extractData(path, {
          ...(flags.lang === undefined ? {} : { language: flags.lang }),
        });
        for (const diagnostic of snapshot.diagnostics) {
          console.error(`warning: ${diagnostic}`);
        }
        result = await writeSnapshot(handle, snapshot);
      } finally {
        handle.close();
      }
      renameSync(tmp, out);
    } catch (error) {
      unlinkIfExists(tmp);
      throw error;
    }
    const elapsed = performance.now() - started;

    const rows = Object.values(result.tables).reduce((a, n) => a + n, 0);
    console.error(
      `extracted ${rows} rows across ${Object.keys(result.tables).length} tables ` +
        `into ${out} (${elapsed.toFixed(0)}ms)`,
    );

    return { db: out, elapsedMs: Math.round(elapsed), tables: result.tables };
  },
};
