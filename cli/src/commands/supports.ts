import {
  SUPPORT_CONVERSATION_CAPS,
  SUPPORT_RANK_THRESHOLDS,
  supportRankPlan,
} from "../tables/supports.ts";
import {
  MAX_SIMULTANEOUS_SUPPORT_LEVELS,
  SUPPORT_BONUSES_MAX_DISTANCE,
  SUPPORT_EXP_DISTANCE,
  rankedBonus,
} from "../tables/supportBonus.ts";
import type { Command } from "./types.ts";

export const supports: Command = {
  name: "supports",
  summary: "Support relationships as a deduplicated edge list",
  description:
    "Every support pair once, as an edge list ordered `a < b`, with the rank " +
    "plan for reaching each level. `byUnit` indexes the same pairs by unit id, " +
    "which is often the easier shape to work with; it carries ids and names " +
    "only, so take the numbers from `edges`.",
  run: ({ rom }) => ({
    limit: 7,
    /**
     * Cumulative support points that define each rank. A pair holds one of
     * these values *after* taking the corresponding support conversation.
     */
    rankThresholds: SUPPORT_RANK_THRESHOLDS,
    /**
     * The point totals at which each rank's support conversation unlocks - one
     * below the rank's own threshold, because `UnitGainSupportExp` clamps the
     * pair's total to the cap for its current rank.
     */
    conversationCaps: SUPPORT_CONVERSATION_CAPS,
    /**
     * How far the bonuses reach versus how close the pair must be to gain
     * points. `bonusRange` is Chebyshev-free: both are Manhattan (|dx| + |dy|).
     */
    distances: {
      bonusRange: SUPPORT_BONUSES_MAX_DISTANCE,
      expRange: SUPPORT_EXP_DISTANCE,
    },
    /** Support *levels* a single unit may hold in total (A=3, B=2, C=1). */
    maxTotalSupportLevels: MAX_SIMULTANEOUS_SUPPORT_LEVELS,
    /**
     * Affinity bonus rows, one per affinity id the ROM defines.
     *
     * **Hack rosters define affinities the reference does not.** Vision Quest
     * has 15 rows where FE8 has 7, and its playable units carry ids 11-15 that
     * no vanilla table covers - so `affinityNames` reports `-` for them while
     * the bonus is still real and still applied by the game.
     *
     * `raw` is what the table stores: HALF-points, which is why every row shows
     * `atk=1, critAvoid=5`. Use `byRank` for the C/B/A numbers a player sees.
     */
    affinityBonuses: rom.supportBonuses.map((b) => ({
      affinity: b.affinity,
      /** `null` when the id is past the reference's seven and has no name. */
      affinityName: b.affinityName ?? null,
      bonuses: b.bonuses,
      /** C/B/A rows scaled from `bonuses`. See `rankedBonus` in `supportBonus.ts`. */
      byRank: rankedBonus(b),
    })),
    edges: rom.supportGraph.map((e) => ({
      a: e.a,
      aName: e.aName,
      b: e.b,
      bName: e.bName,
      initial: e.initial,
      growth: e.growth,
      ...supportRankPlan(e.initial, e.growth),
      reciprocal: e.reciprocal,
      ...(e.mismatch ? { mismatch: e.mismatch } : {}),
    })),
    byUnit: rom.supports.entries.map((entry) => ({
      id: entry.unitId,
      name: entry.unitName,
      /**
       * Partners actually present in the table. Hacks can leave the declared
       * count disagreeing with the record, so the record is what is reported.
       */
      partnerCount: entry.partners.length,
      /**
       * **Id and name only.** The pair's numbers are on `edges`, which this
       * view only re-indexes: `edges` has one row per unordered pair (`a < b`)
       * carrying `initial` / `growth` / `startingRank` / `turnsTo`, and a
       * partner whose reverse direction disagrees with it is preserved in that
       * edge's `mismatch`. Restating them here cost 91 KB on Vision Quest - 90%
       * of `byUnit` - to duplicate `edges`' own 49 KB across 318 rows that hold
       * 159 distinct pairs. Look the numbers up by `{id, partner.id}` instead.
       */
      partners: entry.partners.map((p) => ({ id: p.unitId, name: p.unitName })),
    })),
    limitations: [
      "A support bonus is the sum of BOTH units' affinity rows, each scaled by " +
        "its own rank, then halved once at the end: " +
        "floor((row[mine]*L(mine) + row[theirs]*L(theirs)) / 2) with L = 1/2/3 " +
        "for C/B/A. The table stores HALF-points, which is why every row shows " +
        "atk=1 and critAvoid=5 - read the `byRank` view instead of the raw bytes.",
      "Only adjacent pairs (|dx| + |dy| <= 1, or one carrying the other) gain " +
        "support points, but the bonus applies out to 3 tiles. The asymmetry is " +
        "in the game code, not a parse artefact.",
      "One support level per pair per chapter, and a unit may hold at most 5 " +
        "support levels in total (A=3, B=2, C=1).",
      "turnsTo assumes every conversation is taken the instant it unlocks and " +
        "ignores the one-level-per-chapter cap, so it is a lower bound on the " +
        "number of chapters needed.",
    ],
  }),
};
