import type { UnitSide } from "./game.ts";

export type Difficulty = "easy" | "normal" | "hard";

/** Cheapest first. The order is the emit order, and it is stable. */
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];

/** The seven stats the simulator grows, plus constitution. */
export interface SimStats {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
  con: number;
}

/** How a unit got onto the map. */
export type AppearanceSource = "placement" | "event";

export interface UnitStatRow {
  mapIndex: number;
  difficulty: Difficulty;
  source: AppearanceSource;
  /**
   * Identifies the block within the source: **0** = the normal placement block
   * (slot 10) and **1** = the hard one (slot 11) for `placement`; the
   * `load_blocks.id` for `event`.
   */
  sourceId: number;
  /** Row number within that block. */
  position: number;
  unitId: number;
  /** Resolved: a record's `classId` of 0 means the unit's own class. */
  classId: number;
  side: UnitSide;
  /** The level the record stores, before any adjustment. */
  shownLevel: number;
  /** The difficulty adjustment applied; always 0 for non-enemies. */
  levelDelta: number;
  /** `shownLevel + levelDelta`, deliberately not clamped. */
  level: number;
  /** `level < 0`: the game underflows and the enemy comes out maxed. */
  levelUnderflow: boolean;
  /** The record's grow flag: `false` means fixed stats, no growth at all. */
  autolevel: boolean;
  /** The level the growth actually ran to: `level + 10` when promoted. */
  growLevel: number;
  /** True when either the unit's or the class's `+41` bit 0 is set. */
  promoted: boolean;
  stats: SimStats;
}

/**
 * A unit's **per-unit** base stats: the 7 stats at `+12..18` plus constitution
 * at `+19`. These are **signed deltas**, not final values - ユニット別能力
 * (`X_BASE`, `@UNITBASE`, InputFormRef.cs:12022): `startingStat = class base +
 * unit base`; the field may be negative, and a sum of -1 **wraps to the maximum**
 * on load (so `0xFF` is -1, not +255).
 */
export interface UnitStats {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
  con: number;
}

/** Class base + per-unit delta; luck has no class base. */
export type UnitStartingStats = UnitStats;

export interface UnitGrowths {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
}

export interface ClassBases {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  con: number;
}

/** Class base + unit delta. Luck has no class base; constitution does. */
export function combineStartingStats(
  unit: UnitStats,
  classBases: ClassBases | undefined,
): UnitStartingStats {
  const base = (key: keyof ClassBases): number => classBases?.[key] ?? 0;
  return {
    hp: base("hp") + unit.hp,
    str: base("str") + unit.str,
    skl: base("skl") + unit.skl,
    spd: base("spd") + unit.spd,
    def: base("def") + unit.def,
    res: base("res") + unit.res,
    // No class luck base exists in FE: luck is purely per-unit.
    lck: unit.lck,
    con: base("con") + unit.con,
  };
}
