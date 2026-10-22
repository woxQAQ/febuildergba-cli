/**
 * Unit appearances: every `(unit, chapter)` record the ROM carries, from
 * initial placement blocks and from unit blocks reachable through chapter
 * event scripts. This is the shared input of every "when does this unit show
 * up" derivation - the `joins` command, `availability.ts`, `projection.ts` -
 * so the non-obvious collection rules live here exactly once.
 *
 *   - **Placeholder slots are dropped.** A placement record with a non-zero
 *     unit id but class 0, level 0 and no items carries no unit: `readPlacements`
 *     stops only on `unitId == 0`, so a hack that pads a block with
 *     "clear the field" records (Vision Quest's map 48 pads six units twice,
 *     once per difficulty block) yields them as real rows. They reach no play
 *     order position and would otherwise win the join ranking by being
 *     unrankable. `{@link isPlaceholderPlacement}` is that test.
 *   - **A class override keeps the record, and is reported.** A placement whose
 *     class id is neither 0 nor the unit's own class reads as a stand-in - a
 *     boss cameo, a disguised NPC - but a hack also uses it for a real entry
 *     (Vision Quest joins Tien 20 as a Myrmidon, class 19, not as the Monk class
 *     68 they are in the unit table). Dropping those records loses the join
 *     entirely, so the record is kept and {@link UnitAppearance.placedClassId}
 *     carries the override for a consumer that cares. Event loads carry no
 *     filter: their class id is what the unit spawns as.
 *   - **Debug maps are dropped whole** (`data.debugMaps`, detected in
 *     `model/debugMap.ts`): a jump-chapter menu or unit test bench is real
 *     data, but its player-side load blocks are not army entries - dream-of-five's
 *     map 60 otherwise poses as the join chapter of 17 roster units. Both
 *     placements and event loads are filtered, so a unit seen only on a debug
 *     map has no appearance at all and the consumers report "never joins".
 *
 * Player-army membership shares one predicate. Consumers still decide how
 * to rank appearances and handle off-path maps: `joins` counts them, while
 * `projection` needs a play-order position to project from.
 */

import type { AppearancesInput } from "./data.ts";
import type { UnitSide } from "../model/game.ts";
import { reachedLoadSites } from "../model/events.ts";

export interface UnitAppearance {
  unitId: number;
  mapIndex: number;
  side: UnitSide;
  /** "placement" for the initial deployment blocks, else the load site's kind. */
  source: "placement" | "recruit" | "load" | "cutscene";
  /** Class override of the record; 0 means the unit's own class. */
  placedClassId: number;
  /** Raw placement/load level, retained to audit the unit-table baseline. */
  placedLevel: number;
  /** Entry autolevel can change stats even when class and level match the table. */
  placedAutolevel: number;
  /**
   * Whether the unit is a real character (`has_support_data`), as opposed to a
   * generic template slot. {@link isPlayerArmyAppearance} needs it to tell a
   * recruited ally from an `Enemy` or `Soldier` row a hack loads with `LOAD1`.
   */
  character: boolean;
}

/**
 * A placement record that names a unit but describes nothing: class 0, level 0
 * and no starting items. `readPlacements` emits every record up to the first
 * `unitId == 0`, so a hack that pads a block with these yields them as rows.
 * The class id alone is not enough - 0 legitimately means "the unit's own
 * class" - so the three fields are read together.
 */
export function isPlaceholderPlacement(p: {
  classId: number;
  level: number;
  items: readonly number[];
}): boolean {
  return p.classId === 0 && p.level === 0 && p.items.every((i) => i === 0);
}

/**
 * A placement or recruit load that puts the unit in the player's army.
 *
 * `player` is the obvious case. `ally` is included when the load is classified
 * `recruit` **and the unit is a real character** (`character`): `LOAD1` means
 * "join the party" (`classifyUnitArg`, which reads the `402C` lead byte) while
 * the record's `side` is the allegiance at spawn time, and a unit recruited out
 * of a blue (friendly) army spawns as `ally` first. Without the character test
 * every generic template slot a hack loads with `LOAD1` reads as a joiner: on
 * dream-of-five this predicate would add 52 units, most of them `has_support_data
 * = 0` rows named `Enemy`, `Freelance` or `Warden`.
 *
 * Recruit loads on the `enemy` side are never included: a hack reuses `LOAD1`
 * as a generic loader, and on Vision Quest 116 enemy-side units carry one while
 * only 11 of them ever appear on the player side.
 */
export function isPlayerArmyAppearance(
  a: Pick<UnitAppearance, "side" | "source" | "character">,
): boolean {
  if (a.source === "placement") return a.side === "player";
  if (a.source === "recruit") return a.side === "player" || (a.side === "ally" && a.character);
  return false;
}

/**
 * Every appearance, deduplicated: the normal and hard placement blocks can
 * list the same unit twice, and a shared unit block is reached once per
 * calling script. Ordering is collection order (placements first, then event
 * loads) - consumers that rank appearances apply their own sort.
 */
export function collectAppearances(data: AppearancesInput): UnitAppearance[] {
  const unitById = new Map(data.units.filter((u) => !u.isEmpty).map((u) => [u.id, u]));
  const out: UnitAppearance[] = [];
  const seen = new Set<string>();

  const push = (a: UnitAppearance): void => {
    if (data.debugMaps.has(a.mapIndex)) return;
    const key = `${a.unitId}|${a.mapIndex}|${a.side}|${a.source}|${a.placedClassId}|${a.placedLevel}|${a.placedAutolevel}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };

  for (const chapter of data.chapters) {
    for (const block of [chapter.placements, chapter.hardPlacements]) {
      for (const p of block) {
        const unit = unitById.get(p.unitId);
        if (unit === undefined) continue;
        // A placeholder names a unit but carries no class, level or items.
        if (isPlaceholderPlacement(p)) continue;
        push({
          unitId: p.unitId,
          mapIndex: chapter.index,
          side: p.side,
          source: "placement",
          placedClassId: p.classId,
          placedLevel: p.level,
          placedAutolevel: p.autolevel,
          character: unit.hasSupportData,
        });
      }
    }
  }

  for (const site of reachedLoadSites(data.trace)) {
    for (const u of site.units) {
      push({
        unitId: u.unitId,
        mapIndex: site.mapIndex,
        side: u.side,
        source: site.kind,
        placedClassId: u.classId,
        placedLevel: u.level,
        placedAutolevel: u.autolevel,
        character: unitById.get(u.unitId)?.hasSupportData ?? false,
      });
    }
  }
  return out;
}
