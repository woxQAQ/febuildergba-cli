/**
 * `availability` command: the unit x chapter matrix behind "is this unit even
 * fieldable later" - the first filter a training recommendation applies. The
 * derivation and its heuristics live in `analysis/availability.ts`; this is
 * the shell: load the db, compute, shape the rows for JSON (`chapters` is a
 * Map inside, which JSON.stringify would render as `{}`).
 */

import { computeAvailability } from "../analysis/availability.ts";
import type { Command } from "./types.ts";

export const availability: Command<"db"> = {
  name: "availability",
  input: "db",
  summary: "Show which chapters each unit can be fielded in",
  description:
    "One row per unit seen anywhere: its join chapter (play-order position, " +
    "null when off every known path), a per-chapter status " +
    "(not_joined/available/forced/npc/removed), the deployable count after " +
    "joining, and merged gap segments. The status rules are heuristic - " +
    "absence from a chapter's placement block is the normal case, not a " +
    "leave; see src/analysis/availability.ts for the rules and blind spots.",
  run: ({ data }) => {
    return computeAvailability(data).map((u) => ({
      unitId: u.unitId,
      name: u.name,
      joinPosition: u.joinPosition,
      joinMapIndex: u.joinMapIndex,
      availableCount: u.availableCount,
      totalAfterJoin: u.totalAfterJoin,
      gaps: u.gaps,
      chapters: [...u.chapters.entries()].map(([position, c]) => ({
        position,
        mapIndex: c.mapIndex,
        status: c.status,
      })),
    }));
  },
};
