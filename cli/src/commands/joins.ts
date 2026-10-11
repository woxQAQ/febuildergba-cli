import { collectAppearances } from "../analysis/appearances.ts";
import type { UnitAppearance } from "../analysis/appearances.ts";
import { buildUnitNameMap, unitNameOrId } from "../tables/units.ts";
import type { Command } from "./types.ts";

/**
 * Whether an appearance puts the unit in the player's army: a player-side
 * placement, or a player-side block of a recruit-classified load. Anything
 * else (enemy/ally sides, plain `load`/`cutscene` kinds) is only a sighting.
 */
function isJoin(a: UnitAppearance): boolean {
  return a.side === "player" && (a.source === "placement" || a.source === "recruit");
}

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
  run: ({ data }) => {
    const appearances = collectAppearances(data);

    // Play-order position is the rank; off-path maps rank last. Ties fall to
    // the map index, and a full tie keeps the record encountered first -
    // placements are collected before event loads, matching the row order of
    // the old view's UNION ALL, so a same-chapter tie reports the placement.
    const position = data.playOrder.position;
    const rank = (a: UnitAppearance): number => position.get(a.mapIndex) ?? Number.MAX_SAFE_INTEGER;
    const earlier = (a: UnitAppearance, b: UnitAppearance): UnitAppearance =>
      rank(a) !== rank(b) ? (rank(a) < rank(b) ? a : b) : a.mapIndex < b.mapIndex ? a : b;
    const earliest = (list: UnitAppearance[]): UnitAppearance => {
      let best = list[0] as UnitAppearance;
      for (const a of list) best = earlier(a, best);
      return best;
    };

    const byUnit = new Map<number, UnitAppearance[]>();
    for (const a of appearances) {
      const list = byUnit.get(a.unitId);
      if (list === undefined) byUnit.set(a.unitId, [a]);
      else list.push(a);
    }

    const names = buildUnitNameMap(data.units);
    const row = (kind: "join" | "appearance", a: UnitAppearance) => ({
      kind,
      unitId: a.unitId,
      name: unitNameOrId(names, a.unitId),
      mapIndex: a.mapIndex,
      storyOrder: position.get(a.mapIndex) ?? null,
      source: a.source,
      placedClassId: a.placedClassId,
    });

    const joinsRows = [];
    const appearanceRows = [];
    for (const [, list] of [...byUnit].sort((x, y) => x[0] - y[0])) {
      const joined = list.filter(isJoin);
      // A unit that never enters the player's army gets no join row, only an
      // appearance - enemy-only bosses are the common case.
      if (joined.length > 0) joinsRows.push(row("join", earliest(joined)));
      appearanceRows.push(row("appearance", earliest(list)));
    }
    return [...joinsRows, ...appearanceRows];
  },
};
