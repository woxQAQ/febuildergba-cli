import { reachedLoadSites } from "../tables/eventTrace.ts";
import type { Command } from "./types.ts";

export const recruits: Command<"db"> = {
  name: "recruits",
  input: "db",
  summary: "List each chapter's load sites and the units they bring in",
  description:
    'One entry per reachable POINTER_UNIT instruction (a "load site"), with ' +
    "the units of its unit block nested under it. Replaces the former " +
    "`chapter_recruits` and `chapter_recruit_units` db views, which were the " +
    "same data flat and pre-joined: sites were the recursive CALL reach over " +
    "the raw event layer filtered to unit loads, units the block rows joined " +
    "on. The reach runs over the trace `extract` persisted " +
    "(`tables/eventTrace.ts`), read back from the db; `kind` is the load " +
    "classification - `recruit` loads join the player's army, " +
    "`load`/`cutscene` do not.",
  run: ({ data }) => {
    return reachedLoadSites(data.trace).map((site) => ({
      mapIndex: site.mapIndex,
      scriptId: site.scriptId,
      seq: site.seq,
      kind: site.kind,
      blockId: site.blockId,
      units: site.units.map((u) => ({
        position: u.position,
        unitId: u.unitId,
        classId: u.classId,
        level: u.level,
        side: u.side,
        x: u.x,
        y: u.y,
      })),
    }));
  },
};
