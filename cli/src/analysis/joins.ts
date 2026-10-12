import { collectAppearances, isPlayerArmyAppearance } from "./appearances.ts";
import type { UnitAppearance } from "./appearances.ts";
import type { AppearancesInput } from "./data.ts";

export interface JoinsInput extends AppearancesInput {
  position: ReadonlyMap<number, number>;
}

export interface UnitJoin {
  kind: "join" | "appearance";
  appearance: UnitAppearance;
  storyOrder: number | null;
}

/**
 * Earliest army entry and earliest sighting for each witnessed unit.
 * Off-path maps rank last, then map index breaks ties. A full tie retains
 * collection order, so placements precede event loads. Join rows precede
 * sighting rows; each group is ordered by unit id.
 */
export function computeJoins(data: JoinsInput): UnitJoin[] {
  const rank = (a: UnitAppearance): number =>
    data.position.get(a.mapIndex) ?? Number.MAX_SAFE_INTEGER;
  const byUnit = new Map<number, { join?: UnitAppearance; appearance: UnitAppearance }>();
  const earlier = (a: UnitAppearance, b: UnitAppearance): UnitAppearance =>
    rank(a) !== rank(b) ? (rank(a) < rank(b) ? a : b) : a.mapIndex < b.mapIndex ? a : b;

  for (const a of collectAppearances(data)) {
    const previous = byUnit.get(a.unitId);
    const entry: { join?: UnitAppearance; appearance: UnitAppearance } =
      previous ?? { appearance: a };
    entry.appearance = earlier(a, entry.appearance);
    if (isPlayerArmyAppearance(a)) {
      entry.join = entry.join === undefined ? a : earlier(a, entry.join);
    }
    byUnit.set(a.unitId, entry);
  }

  const row = (kind: UnitJoin["kind"], appearance: UnitAppearance): UnitJoin => ({
    kind,
    appearance,
    storyOrder: data.position.get(appearance.mapIndex) ?? null,
  });
  const joins: UnitJoin[] = [];
  const appearances: UnitJoin[] = [];
  for (const [, entry] of [...byUnit].sort((a, b) => a[0] - b[0])) {
    if (entry.join !== undefined) joins.push(row("join", entry.join));
    appearances.push(row("appearance", entry.appearance));
  }
  return [...joins, ...appearances];
}
