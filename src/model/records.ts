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
  bases: ClassBases;
  caps: ClassBases;
  promotionBonuses: Omit<ClassBases, "con">;
}

export interface PlacementRecord {
  unitId: number;
  classId: number;
  side: UnitSide;
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

export interface PlayOrderRows {
  readonly steps: readonly PlayOrderStep[];
  readonly position: ReadonlyMap<number, number>;
}
