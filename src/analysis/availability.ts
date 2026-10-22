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
 *   - **Off-route joiners have no window.** `derived_play_order` is one
 *     linearisation of a possibly branching route, so a unit can join on a
 *     map that sequence does not cover. Such a unit joins (and
 *     `joinMapIndex` says where), but `availableCount` / `totalAfterJoin` /
 *     `gaps` describe the main line only, so they are absent rather than 0 -
 *     `0` would read as "never joins", and an empty `gaps` would read as "no
 *     missed chapter". Measured on the four fixtures: 13 of 58
 *     joiners on dream-of-five and 16 of 48 on dragonherald, none on Vision
 *     Quest or The Drowned King, where 14 of dragonherald's sit on one
 *     off-order map (map 60, which the transition graph cannot reach at all). Among the fixtures it is between a sixth and a third of
 *     the pool, so an answer that discounts a unit by window length has to
 *     check for it before dividing.
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

/**
 * How a unit's army entry resolved, as one value instead of a combination of
 * nullable fields. The three cases have different consequences downstream, and
 * reading them off {@link UnitAvailability.joinMapIndex} plus
 * {@link UnitAvailability.joinPosition} is the step every consumer got wrong.
 */
export type JoinState =
  /** Joins, on a map the play order covers: the window is defined. */
  | "on_route"
  /** Joins, but on a map the play order does not cover: the window is `null`. */
  | "off_route"
  /** May join, but the static rules cannot settle it; no window either. */
  | "unresolved"
  /** No join record: never joins, and is not a candidate. */
  | "never";

export interface UnitAvailability {
  unitId: number;
  name: string;
  /**
   * The resolved army entry, the field to branch on. Derived from the three
   * below, and consistent with them by construction.
   */
  joinState: JoinState;
  /**
   * 1-based play-order position of the join chapter. `null` when the unit does
   * not join on the play order - {@link UnitAvailability.joinState} says which
   * of the three reasons applies.
   */
  joinPosition: number | null;
  /**
   * Map-setting index of the join chapter. `null` when no join is recorded, which
   * {@link UnitAvailability.joinUnresolved} separates into "never joins" and
   * "cannot be decided from the tables".
   */
  joinMapIndex: number | null;
  /** Status per playable chapter, keyed by play-order position, ascending. */
  chapters: ReadonlyMap<number, { mapIndex: number; status: ChapterStatus }>;
  /**
   * Post-join chapters where the unit can be fielded (`available` +
   * `forced`) out of the post-join total.
   *
   * `null` when no main-line window exists to count: the unit never joins,
   * or its join chapter is off the play order. Both cases have zero post-join
   * main-line chapters, and reporting `0` for the second would claim a fact
   * the data does not carry - that unit is in the army, just not on the route
   * this sequence describes. Check {@link UnitAvailability.joinMapIndex} to
   * tell the two apart.
   */
  availableCount: number | null;
  /** Total post-join chapters; `null` under the same rule as above. */
  totalAfterJoin: number | null;
  /**
   * {@link availableCount} / {@link totalAfterJoin}, the window length as one
   * number. `null` wherever those are (`joinState` is `unresolved` or `never`,
   * or the join is off the route). Present so a ranking does not divide two
   * nullable fields itself: `null` then means "no window", and `NaN` cannot
   * appear.
   */
  windowRatio: number | null;
  /**
   * Post-join non-deployable stretches, merged into segments.
   *
   * `null` under the same rule as {@link availableCount}: an empty array would
   * be indistinguishable from "joined on the main line and never missed a
   * chapter", which is the opposite of what an off-order joiner's window is.
   */
  gaps: readonly { fromPosition: number; toPosition: number; reason: ChapterStatus }[] | null;
  /**
   * Set when the unit may join and the static rules cannot settle it. `null`
   * means the join verdict is final: {@link joinMapIndex} is either a real
   * join or a confirmed never-join.
   *
   * A unit carrying `recruit-from-enemy` is one whose only join-like evidence
   * is an enemy-side `LOAD1`: vanilla FE's "talk and they defect", which a hack
   * may also use to spawn a boss the player later recruits.
   *
   * `load-only` covers the other half of the same question: the unit does appear
   * on the player's side already, but only through `LOAD2`/`LOAD3`, so no record
   * adds it to the party. The scripts hand it over later, and the tables cannot
   * say when. Reports of this kind are the ones that read as "has support data,
   * has a portrait, but `joinMapIndex` is null".
   *
   * A candidate carries no window: `availableCount`, `totalAfterJoin` and
   * `gaps` stay `null`. It is a question for the answer to raise, not a
   * joiner the ranking may use.
   */
  joinUnresolved: "recruit-from-enemy" | "load-only" | null;
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
        rank < joinRank
        || (rank === joinRank && (joinMapIndex === null || a.mapIndex < joinMapIndex))
      ) {
        joinRank = rank;
        joinMapIndex = a.mapIndex;
      }
    }
    const joinPosition = joinMapIndex === null ? null : (positionOf.get(joinMapIndex) ?? null);

    // Rule 1 cannot settle every unit. An enemy-side `LOAD1` is how vanilla FE
    // expresses "talk to this enemy and they defect", and hacks also use the
    // same opcode to spawn a boss the player later recruits. Both readings agree
    // the unit is meant to become playable, so the join chapter is named as
    // unresolved instead of being folded into "never joins".
    //
    // The roster gate matters: generic enemy templates carry the same opcode (on
    // Vision Quest 96 such rows, only a handful of them real characters), and
    // `has_support_data` is this extract's existing marker for "a real player
    // character". Without it the candidate list is every spawner row in the ROM.
    let joinUnresolved: UnitAvailability["joinUnresolved"] = null;
    if (joinMapIndex === null && unitById.get(unitId)?.hasSupportData === true) {
      const onPlayerSide = apps.some((a) => a.side === "player" || a.side === "ally");
      const enemyRecruit = apps.some((a) => a.source === "recruit" && a.side === "enemy");
      if (enemyRecruit && !onPlayerSide) joinUnresolved = "recruit-from-enemy";
      else if (onPlayerSide) joinUnresolved = "load-only";
    }

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

    // A window exists only for a unit that joins on the play order. The loop
    // below would leave both counts at 0 for any other joiner, and 0 reads as
    // "never joins" while the unit did join - off the route. So the absent case
    // is stated here rather than left to be inferred from a zero.
    const windowed = joinPosition !== null;

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
        if (windowed && (status === "available" || status === "forced")) {
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
        unitById.get(unitId)?.name
        ?? `Unit 0x${unitId.toString(16).toUpperCase().padStart(2, "0")}`,
      joinState: joinStateOf(joinMapIndex, joinPosition, joinUnresolved),
      joinPosition,
      joinMapIndex,
      chapters,
      // Absent rather than 0 for an off-route joiner - see the field docs.
      availableCount: windowed ? availableCount : null,
      totalAfterJoin: windowed ? totalAfterJoin : null,
      windowRatio: windowed && totalAfterJoin > 0 ? availableCount / totalAfterJoin : null,
      gaps: windowed ? gaps : null,
      joinUnresolved,
    });
  }
  return results;
}

/** The one place the three nullable fields are collapsed into a verdict. */
function joinStateOf(
  joinMapIndex: number | null,
  joinPosition: number | null,
  joinUnresolved: UnitAvailability["joinUnresolved"],
): JoinState {
  if (joinMapIndex === null) return joinUnresolved === null ? "never" : "unresolved";
  return joinPosition === null ? "off_route" : "on_route";
}
