import {
  SUPPORT_CONVERSATION_CAPS,
  SUPPORT_RANK_THRESHOLDS,
  supportRankPlan,
} from '../tables/supports.ts';
import {
  MAX_SIMULTANEOUS_SUPPORT_LEVELS,
  SUPPORT_BONUSES_MAX_DISTANCE,
  SUPPORT_EXP_DISTANCE,
} from '../tables/supportBonus.ts';
import type { Command } from './types.ts';

export const supports: Command = {
  name: 'supports',
  summary: 'Support relationships as a deduplicated edge list',
  description:
    'Every support pair, once per direction, with the rank plan for reaching ' +
    'each level. `byUnit` is the same data indexed by unit id, which is often ' +
    'the easier shape to work with.',
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
      declaredCount: entry.declaredCount,
      partners: entry.partners.map((p) => ({
        id: p.unitId,
        name: p.unitName,
        initial: p.initial,
        growth: p.growth,
        ...supportRankPlan(p.initial, p.growth),
      })),
    })),
    limitations: [
      'A support bonus is the sum of BOTH units\' affinity rows, each scaled by ' +
        'its own rank, then halved once at the end: ' +
        'floor((row[mine]*L(mine) + row[theirs]*L(theirs)) / 2) with L = 1/2/3 ' +
        'for C/B/A. The table stores HALF-points, which is why every row shows ' +
        'atk=1 and critAvoid=5 - read the `byRank` view instead of the raw bytes.',
      'Only adjacent pairs (|dx| + |dy| <= 1, or one carrying the other) gain ' +
        'support points, but the bonus applies out to 3 tiles. The asymmetry is ' +
        'in the game code, not a parse artefact.',
      'One support level per pair per chapter, and a unit may hold at most 5 ' +
        'support levels in total (A=3, B=2, C=1).',
      'turnsTo assumes every conversation is taken the instant it unlocks and ' +
        'ignores the one-level-per-chapter cap, so it is a lower bound on the ' +
        'number of chapters needed.',
    ],
  }),
};