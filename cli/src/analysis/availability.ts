/**
 * Per-chapter unit availability: "can unit U be fielded in chapter N?" -
 * the first constraint on "who is worth training" (a unit that leaves the
 * army stops paying back investment). Pure derivation over the extract db
 * ({@link AvailabilityInput}); nothing here is persisted.
 *
 * ## Data sources
 *
 *   - Initial placements: `data.chapters[].placements` / `hardPlacements`
 *     (condition slots 10/11, the normal/hard 自軍配置 blocks).
 *   - Event loads: `reachedLoadSites` over the event trace - every load
 *     site a chapter's scripts reach, with its unit block attached.
 *   - Chapter order: `data.playOrder` (`derived_play_order` materialised);
 *     `position`, not `chapterNumber`, is what orders a playthrough.
 *   - Forced deployment: `data.forceSortie`, the 必ず出撃 table.
 *
 * ## Derivation rules (v1, heuristic)
 *
 * 1. **Join chapter.** The earliest appearance that puts the unit in the
 *    player's army: a player-side *placement* whose class id is 0 or the
 *    unit's own class (a mismatched class means a cutscene double wearing
 *    the unit's id, not the unit - same filter as the `unit_joins` view's
 *    WHERE), or a *recruit* event load (LOAD1) on the player side.
 *    "Earliest" ranks by play-order position, off-path maps last, map index
 *    as tie-break - the ranking the `joins` command uses, rewritten in TS.
 * 2. **Default after join: available.** Every chapter at or after the join
 *    position is `available` unless evidence says otherwise:
 *    a `removed`-side record (消滅: deleted on map load, how a hack removes
 *    a roster unit) marks the chapter `removed`; an `ally`-side appearance
 *    marks it `npc`.
 *
 *    **Correctness boundary: absence is not evidence.** FE placement blocks
 *    list only the initial deployment; the rest of the army is picked at the
 *    prep screen. A joined unit missing from a chapter's blocks is the
 *    normal case, not a leave - only an explicit `removed`/`ally` record
 *    changes the status.
 * 3. **Forced sortie.** A `forceSortie` record matching the unit id and the
 *    chapter's map index (`0xFF` = any map) marks the chapter `forced`
 *    instead of `available`. The route byte is matched loosely: `0xFF` means
 *    any route, and any other value is treated as matching, because the
 *    route id lives in `ChapterData+0x1B` at runtime and cannot be resolved
 *    statically - records restricted to one route are over-approximated as
 *    forced on both (see `tables/forceSortie.ts` for why the byte's meaning
 *    on hacks is itself unreliable).
 * 4. **Gaps.** Maximal post-join runs of non-deployable chapters (`npc` /
 *    `removed`), merged while consecutive in position; a run whose reason
 *    changes splits into two segments. `forced` counts as deployable -
 *    the unit is guaranteed on the field - so it appears in
 *    `availableCount`, never in `gaps`.
 *
 * ## Known blind spots
 *
 *   - **Route splits.** When the story branches, a unit may leave on one
 *     route and stay on the other; the play order is a single sequence, so
 *     route-conditional leaves are invisible here.
 *   - **Conditional events.** Reaching a script is not firing it: a TALK or
 *     TURN recruit behind a flag/turn condition counts as a join even when a
 *     playthrough can skip it, and a conditional removal behind a branch is
 *     reported as unconditional.
 *   - **Defections.** A joined unit appearing with `enemy` side later is not
 *     modelled - it reads as `available`.
 *   - **Removal persistence.** `removed` is per-chapter evidence; whether the
 *     unit ever returns is inferred only from later appearances, so a silent
 *     permanent leave shows as one `removed` chapter followed by `available`.
 *
 * The trace is read back from the db (`data.trace`), not re-walked:
 * `extract` persists the raw event layer and the loader rebuilds the same
 * shape (`repository/read.ts`), so this module never touches the ROM.
 */

import type { AnalysisUnit, AvailabilityInput } from "./data.ts";
import { collectAppearances, isPlayerArmyAppearance } from "./appearances.ts";
import type { UnitAppearance } from "./appearances.ts";
import type { ForceSortieRow } from "../model/records.ts";

export type ChapterStatus =
  /** Not yet in the army. */
  | "not_joined"
  /** In the army, deployable at the prep screen. */
  | "available"
  /** Must be deployed (force-sortie table hit). */
  | "forced"
  /** On the field as an ally/NPC; present but not controllable. */
  | "npc"
  /** Removed by an event (a 消滅 record deletes the unit on map load). */
  | "removed";

export interface UnitAvailability {
  unitId: number;
  name: string;
  /**
   * 1-based play-order position of the join chapter. `null` when the unit
   *   never joins **or** joined on a map off every known path - check
   *   {@link UnitAvailability.joinMapIndex} to tell the two apart.
   */
  joinPosition: number | null;
  /** Map-setting index of the join chapter; `null` = never joins. */
  joinMapIndex: number | null;
  /** Status per playable chapter, keyed by play-order position, ascending. */
  chapters: ReadonlyMap<number, { mapIndex: number; status: ChapterStatus }>;
  /**
   * Post-join chapters where the unit can be fielded (`available` +
   * `forced`) out of the post-join total. Both 0 for a unit that never joins.
   */
  availableCount: number;
  totalAfterJoin: number;
  /** Post-join non-deployable stretches, merged into segments. */
  gaps: readonly { fromPosition: number; toPosition: number; reason: ChapterStatus }[];
}

/** One witnessed appearance of a unit in one chapter. */
type Appearance = UnitAppearance;

// --- appearance collection ------------------------------------------------

/** Appearances grouped by unit id; the collection rules live in `appearances.ts`. */
function appearancesByUnit(data: AvailabilityInput): Map<number, Appearance[]> {
  const out = new Map<number, Appearance[]>();
  for (const a of collectAppearances(data)) {
    const list = out.get(a.unitId);
    if (list === undefined) out.set(a.unitId, [a]);
    else list.push(a);
  }
  return out;
}

// --- force sortie ---------------------------------------------------------

/** Unit id -> the map indices its force-sortie records name; `null` set = any map. */
function forceSortieIndex(records: readonly ForceSortieRow[]): Map<number, Set<number> | null> {
  const out = new Map<number, Set<number> | null>();
  for (const r of records) {
    let maps = out.get(r.unitId);
    if (maps === null) continue; // already "any map"
    if (maps === undefined) {
      maps = new Set<number>();
      out.set(r.unitId, maps);
    }
    // 0xFF in the map byte is "no map constraint" - forced on every map.
    // The route byte is deliberately not consulted; see the module doc.
    if (r.mapIndex === 0xff) out.set(r.unitId, null);
    else maps.add(r.mapIndex);
  }
  return out;
}

// --- main entry -----------------------------------------------------------

/**
 * Availability of every unit the ROM shows anywhere (placement or event
 * load), sorted by unit id. Units with no recorded appearance at all are
 * omitted - there is nothing to say about them.
 */
export function computeAvailability(data: AvailabilityInput): UnitAvailability[] {
  const appearances = appearancesByUnit(data);
  const forced = forceSortieIndex(data.forceSortie);

  const playable = data.playOrder.steps.filter((s) => s.playable);
  const positionOf = data.playOrder.position;
  const unitById = new Map<number, AnalysisUnit>(data.units.map((u) => [u.id, u]));

  const results: UnitAvailability[] = [];
  for (const [unitId, apps] of [...appearances.entries()].sort((a, b) => a[0] - b[0])) {
    // Rule 1: earliest player-army appearance wins the join chapter.
    let joinMapIndex: number | null = null;
    let joinRank = Number.POSITIVE_INFINITY;
    for (const a of apps) {
      if (!isPlayerArmyAppearance(a)) continue;
      const rank = positionOf.get(a.mapIndex) ?? Number.POSITIVE_INFINITY;
      if (
        rank < joinRank ||
        (rank === joinRank && (joinMapIndex === null || a.mapIndex < joinMapIndex))
      ) {
        joinRank = rank;
        joinMapIndex = a.mapIndex;
      }
    }
    const joinPosition = joinMapIndex === null ? null : (positionOf.get(joinMapIndex) ?? null);

    const byMap = new Map<number, Appearance[]>();
    for (const a of apps) {
      const list = byMap.get(a.mapIndex);
      if (list === undefined) byMap.set(a.mapIndex, [a]);
      else list.push(a);
    }

    const forcedMaps = forced.get(unitId);
    const isForced = (mapIndex: number): boolean =>
      forcedMaps === null || (forcedMaps !== undefined && forcedMaps.has(mapIndex));

    const chapters = new Map<number, { mapIndex: number; status: ChapterStatus }>();
    let availableCount = 0;
    let totalAfterJoin = 0;
    const gaps: { fromPosition: number; toPosition: number; reason: ChapterStatus }[] = [];

    for (const step of playable) {
      const here = byMap.get(step.mapIndex) ?? [];
      let status: ChapterStatus;
      // Evidence outranks membership: a removed/ally record says something
      // concrete about this chapter, before or after the join.
      if (here.some((a) => a.side === "removed")) status = "removed";
      else if (here.some((a) => a.side === "ally")) status = "npc";
      else if (step.order >= joinRank) status = isForced(step.mapIndex) ? "forced" : "available";
      else status = "not_joined";
      chapters.set(step.order, { mapIndex: step.mapIndex, status });

      if (step.order >= joinRank) {
        totalAfterJoin++;
        if (status === "available" || status === "forced") {
          availableCount++;
        } else {
          const last = gaps[gaps.length - 1];
          if (last !== undefined && last.toPosition === step.order - 1 && last.reason === status) {
            last.toPosition = step.order;
          } else {
            gaps.push({ fromPosition: step.order, toPosition: step.order, reason: status });
          }
        }
      }
    }

    results.push({
      unitId,
      name:
        unitById.get(unitId)?.name ??
        `Unit 0x${unitId.toString(16).toUpperCase().padStart(2, "0")}`,
      joinPosition,
      joinMapIndex,
      chapters,
      availableCount,
      totalAfterJoin,
      gaps,
    });
  }
  return results;
}
