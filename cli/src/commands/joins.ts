import { joinsOf } from "../db/analysis.ts";
import { buildUnitNameMap, unitNameOrId } from "../tables/units.ts";
import type { Command } from "./types.ts";

export const joins: Command<"db"> = {
  name: "joins",
  input: "db",
  summary: "List each unit's earliest join and first appearance, by chapter",
  description:
    "Two rows per unit that appears anywhere: `join` is the earliest chapter " +
    "the unit enters the player's army (player-side placements whose class " +
    "override is absent or matches the unit's own class, plus player-side " +
    "`recruit` loads); `appearance` is the earliest chapter the unit is seen " +
    'at all. Replaces the former `unit_joins` db view. "Earliest" is play ' +
    "position, not chapter number: off-path maps sort last, the map index " +
    "breaks ties. `storyOrder` is null for a chapter on no known path.",
  run: async ({ extract }) => {
    const results = await joinsOf(extract);
    const names = buildUnitNameMap(await extract.units());
    return results.map(({ kind, appearance: a, storyOrder }) => ({
      kind,
      unitId: a.unitId,
      name: unitNameOrId(names, a.unitId),
      mapIndex: a.mapIndex,
      storyOrder,
      source: a.source,
      placedClassId: a.placedClassId,
    }));
  },
};
