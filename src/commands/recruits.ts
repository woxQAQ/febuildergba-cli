import { reachedLoadSites } from "../model/events.ts";
import { defineDbCommand } from "./types.ts";

export const recruits = defineDbCommand({
  name: "recruits",
  input: "db",
  summary: "List each chapter's load sites and the units they bring in",
  description:
    'One entry per reachable POINTER_UNIT instruction (a "load site"), with '
    + "the units of its unit block nested under it. Replaces the former "
    + "`chapter_recruits` and `chapter_recruit_units` db views, which were the "
    + "same data flat and pre-joined: sites were the recursive CALL reach over "
    + "the raw event layer filtered to unit loads, units the block rows joined "
    + "on. The reach runs over the trace `extract` persisted "
    + "(`tables/eventTrace.ts`), read back from the db; `kind` is the load "
    + "classification, not proof of player control or reward receipt. Enemy-side "
    + "`recruit` loads do not establish army entry. Inventory item ids, autolevel "
    + "and raw `ext` flags are retained; FE8 ext bit 0x2 marks an item-drop "
    + "candidate, not a verified dropped slot or guaranteed inventory gain.",
  run: async ({ extract }) => ({
    data: reachedLoadSites(await extract.trace()).map((site) => ({
      mapIndex: site.mapIndex,
      scriptId: site.scriptId,
      seq: site.seq,
      position: site.position,
      kind: site.kind,
      blockId: site.blockId,
      units: site.units.map((u) => ({
        position: u.position,
        unitId: u.unitId,
        classId: u.classId,
        level: u.level,
        side: u.side,
        autolevel: u.autolevel,
        items: u.items,
        ext: u.ext,
        x: u.x,
        y: u.y,
      })),
    })),
  }),
});
