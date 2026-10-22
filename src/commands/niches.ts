import { buildPromotionGraph } from "../model/promotion.ts";
import { availabilityOf } from "../analysis/service.ts";
import { classProfile } from "../analysis/classProfile.ts";
import { defineDbCommand } from "./types.ts";

export const niches = defineDbCommand({
  name: "niches",
  input: "db",
  summary: "Group classes into niches and count how many joiners can reach each",
  description:
    "One row per niche: its weapon families, mobility and special action, how "
    + "many non-empty classes offer it, and how many player-army units can reach "
    + "it within four promotion steps. This is a global reachability index, not a "
    + "training priority or a resource-feasible lineup: off-route joiners and "
    + "mutually exclusive branches are included. `classCount` counts table entries, "
    + "including duplicate profiles, not independent player choices. Rows sort by "
    + "`joinerCount`, then `classCount`, then key, with zero joiners last. "
    + "Reachability follows `buildPromotionGraph` - "
    + "the CC branch "
    + "table plus the class record's link - and the units counted are the ones "
    + "`availability` reports as joiners (`joinMapIndex` non-null), the same set "
    + "the `joins` command's `join` rows describe.",
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
      const key = classProfile(c).niche;
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
        const key = classProfile(c).niche;
        const set = reach.get(key) ?? new Set<number>();
        set.add(unitId);
        reach.set(key, set);
      }
    }

    return {
      data: [...classesByNiche.entries()]
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
        // `classCount` breaks the tie before the niche string: one joiner into one
        // class is a structural monopoly, while one joiner into twenty-nine classes
        // (the weaponless enemy classes) is the least scarce capability there is.
        // Sorting by name first put those two in arbitrary order.
        .sort((a, b) => {
          const aDead = a.joinerCount === 0 ? 1 : 0;
          const bDead = b.joinerCount === 0 ? 1 : 0;
          return (
            aDead - bDead
            || a.joinerCount - b.joinerCount
            || a.classCount - b.classCount
            || a.niche.localeCompare(b.niche)
          );
        }),
    };
  },
});
