import { joinsOf, unitsOf } from "../analysis/service.ts";
import { buildUnitNameMap, unitNameOrId } from "../format.ts";
import { defineDbCommand } from "./types.ts";

export const joins = defineDbCommand({
  name: "joins",
  input: "db",
  summary: "List each unit's earliest join and first appearance, by chapter",
  description:
    "At most one `join` and one `appearance` row per unit. `join` is the earliest "
    + "recognized army entry: player-side placements, player-side `recruit` loads, "
    + "or ally-side `recruit` loads for support-bearing characters. Class "
    + "overrides are kept in `placedClassId`. `appearance` is the earliest chapter "
    + "the unit is seen at all; an appearance does not imply a join. "
    + 'Replaces the former `unit_joins` db view. "Earliest" is play '
    + "position, not chapter number: off-path maps sort last, the map index "
    + "breaks ties. `storyOrder` is null for a chapter on no known path. "
    + "Appearances on debug maps (a jump-chapter menu or unit test bench, "
    + "detected in `model/debugMap.ts`) are excluded and announced as a "
    + "warning.",
  run: async ({ extract }) => {
    const results = await joinsOf(extract);
    const names = buildUnitNameMap(await unitsOf(extract));
    return {
      data: results.map(({ kind, appearance: a, storyOrder }) => ({
        kind,
        unitId: a.unitId,
        name: unitNameOrId(names, a.unitId),
        mapIndex: a.mapIndex,
        storyOrder,
        source: a.source,
        placedClassId: a.placedClassId,
        placedLevel: a.placedLevel,
        placedAutolevel: a.placedAutolevel,
      })),
    };
  },
});
