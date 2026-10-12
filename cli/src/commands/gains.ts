import { reachableInstructions } from "../model/events.ts";
import { defineDbCommand } from "./types.ts";

export const gains = defineDbCommand({
  name: "gains",
  input: "db",
  summary: "List gold and items each chapter's events hand directly to the player",
  description:
    "Direct gold writes and item grants reachable from a chapter's event " +
    "scripts, as two lists. Replaces the former `chapter_gold` and " +
    "`chapter_item_gives` db views; both were the same recursive CALL reach " +
    "over the raw event layer, filtered to instructions carrying a gold " +
    "literal resp. an `{ITEM}`-category grant. The reach runs over the trace " +
    "`extract` persisted (`tables/eventTrace.ts`), read back from the db. In " +
    "`items`, `unitId` 0xFFFF means the unit currently acting. Chests and " +
    "villages are map objects, not event grants - they are in the extract's " +
    "`map_objects` table.",
  run: async ({ extract }) => {
    const reached = reachableInstructions(await extract.trace());
    return {
      gold: reached
        .flatMap((r) => r.instruction.gold.map((gold) => ({
          mapIndex: r.mapIndex,
          scriptId: r.instruction.scriptId,
          seq: r.instruction.seq,
          delta: gold.delta,
        }))),
      items: reached
        .flatMap((r) => r.instruction.items.map((item) => ({
          mapIndex: r.mapIndex,
          scriptId: r.instruction.scriptId,
          seq: r.instruction.seq,
          itemId: item.itemId,
          unitId: item.unitId,
        }))),
    };
  },
});
