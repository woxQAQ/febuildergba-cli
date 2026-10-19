import type { MountKind, UnitSide } from "./game.ts";
import type { ClassBases, UnitGrowths, UnitStats } from "./stats.ts";
import type { PlayOrderStep } from "./storyPath.ts";

/** Persisted unit facts; starting stats are calculated from class bases by analysis. */
export interface UnitRecord {
  id: number;
  name: string;
  classId: number;
  className: string;
  affinityId: number;
  level: number;
  isEmpty: boolean;
  isPromotedClass: boolean;
  hasSupportData: boolean;
  stats: UnitStats;
  growths: UnitGrowths;
}

export interface ClassRecord {
  id: number;
  name: string;
  mount: MountKind;
  flying: boolean;
  terrainBonusImmune: boolean;
  isEmpty: boolean;
  promotesToClassId: number;
  sortOrder: number;
  classPower: number;
  abilityFlags: [number, number, number, number];
  /**
   * Weapon levels in ROM order (sword, lance, axe, bow, staff, anima, light,
   * dark). The numbers are ranks, not letters: `tables/items.ts`'s
   * `weaponRankLetter` maps them (1/31/71/121/181/251 = E/D/C/B/A/S), and it is
   * documented there as the same scale unit weapon levels use.
   */
  weaponLevels: [number, number, number, number, number, number, number, number];
  /** `dancer` / `bard` / `thief`, or `null` for an ordinary class. */
  specialAction: "dancer" | "bard" | "thief" | null;
  bases: ClassBases;
  caps: ClassBases;
  promotionBonuses: Omit<ClassBases, "con">;
}

export interface PlacementRecord {
  unitId: number;
  classId: number;
  side: UnitSide;
  /**
   * `+3` bits 3-7 (the record's level). Carried so callers can tell a
   * placeholder from a real entry: `readPlacements` emits every record up to
   * the first `unitId == 0`, and a hack that pads a block leaves `classId`,
   * `level` and `items` all zero. See `analysis/appearances.ts`.
   */
  level: number;
  /** `+12..15`: starting items; all zero when the record names no unit. */
  items: readonly number[];
}

export interface ChapterRecord {
  /** Map-setting row index, not the chapter number. */
  index: number;
  deploySlots: number;
  placements: PlacementRecord[];
  hardPlacements: PlacementRecord[];
}

export interface SupportPartnerRow {
  unitId: number;
  partnerId: number;
  initial: number;
  growth: number;
}

export interface ForceSortieRow {
  unitId: number;
  mapIndex: number;
}

/**
 * One row of the class-change branch table (CC分岐表): the two promotion
 * targets the game's CC menu offers for this class. `0` means "no branch in
 * that slot", and the table is dense over class ids, so a class with no
 * promotion gets a row of zeros. See `tables/classBranch.ts` for why this is
 * stored separately from the class record's `+5`.
 */
export interface ClassBranchRow {
  classId: number;
  branch1: number;
  branch2: number;
}

export interface PlayOrderRows {
  readonly steps: readonly PlayOrderStep[];
  readonly position: ReadonlyMap<number, number>;
}
