import { parseRom } from "../load.ts";
import { extractEventTrace, reachableInstructions } from "../tables/eventTrace.ts";
import type { Command } from "./types.ts";

export const gains: Command = {
  name: "gains",
  summary: "List gold and items each chapter's events hand directly to the player",
  description:
    "Direct gold writes and item grants reachable from a chapter's event " +
    "scripts, as two lists. Replaces the former `chapter_gold` and " +
    "`chapter_item_gives` db views; both were the same recursive CALL reach " +
    "over the raw event layer, filtered to instructions carrying a gold " +
    "literal resp. an `{ITEM}`-category grant. The reach now runs in memory " +
    "over the same trace `extract` persists (`tables/eventTrace.ts`). In " +
    "`items`, `unitId` 0xFFFF means the unit currently acting. Chests and " +
    "villages are map objects, not event grants - they are in the extract's " +
    "`map_objects` table.",
  run: ({ rom }) => {
    const parsed = parseRom(rom);
    const trace = extractEventTrace(
      parsed.rom,
      parsed.layout,
      parsed.chapters,
      parsed.condSlots,
      parsed.eventScripts,
    );
    const reached = reachableInstructions(trace);
    return {
      gold: reached
        .filter((r) => r.instruction.goldDelta !== null)
        .map((r) => ({
          mapIndex: r.mapIndex,
          scriptId: r.instruction.scriptId,
          seq: r.instruction.seq,
          delta: r.instruction.goldDelta,
        })),
      items: reached
        .filter((r) => r.instruction.itemId !== null)
        .map((r) => ({
          mapIndex: r.mapIndex,
          scriptId: r.instruction.scriptId,
          seq: r.instruction.seq,
          itemId: r.instruction.itemId,
          unitId: r.instruction.giveUnitId,
        })),
    };
  },
};