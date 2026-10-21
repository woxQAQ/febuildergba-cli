/**
 * `availability` command: the unit x chapter matrix behind "is this unit even
 * fieldable later" - the first filter a training recommendation applies. The
 * derivation and its heuristics live in `analysis/availability.ts`; this is the
 * shell: load the db, compute, shape the rows for JSON (`chapters` is a Map
 * inside, which JSON.stringify would render as `{}`).
 *
 * The per-chapter list is most of the payload and the least used part of it, so
 * the default row is the summary: join point, window counts, gaps, and the
 * unresolved-join verdict. `--full` adds the per-chapter statuses.
 */

import { availabilityOf } from "../analysis/service.ts";
import { defineDbCommand } from "./types.ts";

export const availability = defineDbCommand({
  name: "availability",
  input: "db",
  summary: "Show which chapters each unit can be fielded in",
  description:
    "One row per unit seen anywhere: its join chapter (play-order position, " +
    "null when off every known path), the deployable count after joining, merged " +
    "gap segments, and `joinUnresolved` for a unit whose join the tables cannot " +
    "settle. The counts and gaps are null for a unit " +
    "whose join chapter is off the play order: such a unit joins but has no " +
    "main-line window to count against, so 0 would read as never joining and an " +
    "empty gap list would read as never missing a chapter. A null `joinMapIndex` " +
    "means the unit has no recorded join: `joinUnresolved` says whether that is " +
    "a confirmed never-join or a verdict the tables cannot reach. " +
    "`--full` adds the per-chapter status list " +
    "(not_joined/available/forced/npc/removed); it is omitted by default because " +
    "it is most of the payload. " +
    "The status rules are heuristic - " +
    "absence from a chapter's placement block is the normal case, not a " +
    "leave; see src/analysis/availability.ts for the rules and blind spots.",
  run: async ({ extract, flags }) => {
    return (await availabilityOf(extract)).map((u) => ({
      unitId: u.unitId,
      name: u.name,
      joinPosition: u.joinPosition,
      joinMapIndex: u.joinMapIndex,
      availableCount: u.availableCount,
      totalAfterJoin: u.totalAfterJoin,
      gaps: u.gaps,
      joinUnresolved: u.joinUnresolved,
      ...(flags.full === true
        ? {
            chapters: [...u.chapters.entries()].map(([position, c]) => ({
              position,
              mapIndex: c.mapIndex,
              status: c.status,
            })),
          }
        : {}),
    }));
  },
});
