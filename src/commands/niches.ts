import { buildPromotionGraph } from "../model/promotion.ts";
import { availabilityOf } from "../analysis/service.ts";
import type { ClassRecord } from "../model/records.ts";
import { defineDbCommand } from "./types.ts";

/** ROM weapon-slot order, used to render a niche key. */
const WEAPON_SLOTS = ["sword", "lance", "axe", "bow", "staff", "anima", "light", "dark"] as const;

/**
 * The niche a class occupies: which weapon families it can use, how it moves,
 * and whether it carries a special action. Two classes with the same profile
 * offer the same capability even when their ids differ, because the class table
 * carries duplicate entries.
 */
function nicheOf(c: ClassRecord, mobility: string): string {
  const weapons = WEAPON_SLOTS.filter((_, i) => (c.weaponLevels[i] as number) > 0);
  const arms = weapons.length === 0 ? "none" : weapons.join("+");
  const special = c.specialAction === null ? "" : `@${c.specialAction}`;
  return `${arms}|${mobility}${special}`;
}

/**
 * Mobility classification of one class. Duplicated from the `roles` command on
 * purpose: that command owns the rule for its own output, and this one needs a
 * single label to build a niche key from.
 */
function mobilityOf(c: ClassRecord): string {
  if (c.mount === "wyvern" || c.mount === "pegasus") return "flying";
  if (c.mount === "horse") return "mounted";
  if (c.mount === "armour") return "armour";
  if (c.flying || c.terrainBonusImmune) return "flying";
  return "normal";
}

export const niches = defineDbCommand({
  name: "niches",
  input: "db",
  summary: "Group classes into niches and count how many joiners can reach each",
  description:
    "One row per niche: its weapon families, mobility and special action, how " +
    "many non-empty classes offer it, and how many player-army units can reach " +
    "it along the promotion graph. A niche reachable by one or two joiners is " +
    "the reason to train them; a niche reachable by ten is not a reason to " +
    "train anyone. Reachability follows `buildPromotionGraph` - the CC branch " +
    "table plus the class record's link - and the units counted are the ones " +
    "`availability` reports as joiners (`joinMapIndex` non-null), the same set " +
    "the `joins` command's `join` rows describe.",
  run: async ({ extract }) => {
    const classes = (await extract.classes()).filter((c) => !c.isEmpty);
    const classById = new Map(classes.map((c) => [c.id, c]));
    const graph = buildPromotionGraph(classes, await extract.classBranches());

    const units = await extract.units();
    const unitById = new Map(units.map((u) => [u.id, u]));
    // The joiner set is exactly what the `availability` command reports, so the
    // two commands cannot disagree about who is in the pool.
    const joiners = (await availabilityOf(extract))
      .filter((u) => u.joinMapIndex !== null)
      .map((u) => u.unitId);

    const classesByNiche = new Map<string, number[]>();
    for (const c of classes) {
      const key = nicheOf(c, mobilityOf(c));
      classesByNiche.set(key, [...(classesByNiche.get(key) ?? []), c.id]);
    }

    // niche -> the joiners that can reach it, starting from the class they join in
    const reach = new Map<string, Set<number>>();
    for (const unitId of joiners) {
      const unit = unitById.get(unitId);
      if (unit === undefined) continue;
      const start = classById.get(unit.classId);
      if (start === undefined) continue;
      const reached = new Set<number>([start.id]);
      let frontier = [start.id];
      for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
        const next: number[] = [];
        for (const id of frontier) {
          for (const target of graph.targetsAll.get(id) ?? []) {
            if (reached.has(target.id)) continue;
            reached.add(target.id);
            next.push(target.id);
          }
        }
        frontier = next;
      }
      for (const classId of reached) {
        const c = classById.get(classId);
        if (c === undefined) continue;
        const key = nicheOf(c, mobilityOf(c));
        const set = reach.get(key) ?? new Set<number>();
        set.add(unitId);
        reach.set(key, set);
      }
    }

    return [...classesByNiche.entries()]
      .map(([niche, classIds]) => {
        const reachable = [...(reach.get(niche) ?? new Set<number>())].sort((a, b) => a - b);
        return {
          niche,
          classCount: classIds.length,
          classIds,
          joinerCount: reachable.length,
          joiners: reachable.map((id) => ({ unitId: id, name: unitById.get(id)?.name ?? "" })),
        };
      })
      // Scarce-but-reachable first: a niche no joiner can reach cannot be part of
      // a recommendation, and a niche ten joiners reach is not a reason to train.
      .sort((a, b) => {
        const aDead = a.joinerCount === 0 ? 1 : 0;
        const bDead = b.joinerCount === 0 ? 1 : 0;
        return aDead - bDead || a.joinerCount - b.joinerCount || a.niche.localeCompare(b.niche);
      });
  },
});
