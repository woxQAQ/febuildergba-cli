/**
 * A complete, rebuildable extract. Only decoded records and provenance cross
 * this boundary; the ROM buffer, text decoder and resource definitions remain
 * inside extraction.
 */
import type { GameVersion } from "./game.ts";
import type {
  Unit,
  UnitClass,
  Chapter,
  CondSlotInfo,
  SupportReadResult,
  SupportBonus,
  TerrainReadResult,
  ForceSortieTable,
  ClassBranchTable,
  Item,
  ShopReadResult,
  ChapterObjects,
  SkillReadResult,
} from "./snapshotRecords.ts";
import type { EventTrace } from "./events.ts";
import type { PlayOrder } from "./storyPath.ts";
import type { DebugMapRecord } from "./debugMap.ts";
import type { UnitStatRow } from "./stats.ts";

export interface SnapshotMetadata {
  path: string;
  sizeBytes: number;
  gameCode: string;
  title: string;
  version: GameVersion;
  displayName: string;
  isMultibyte: boolean;
  skillSystem: string;
  magicSplit: string;
  notes: string[];
  configDir: string | null;
  configLanguage: string;
}

export interface ExtractionSnapshot {
  metadata: SnapshotMetadata;
  diagnostics: string[];
  chaptersAvailable: boolean;
  eventsAvailable: boolean;
  classes: UnitClass[];
  units: Unit[];
  supports: SupportReadResult;
  supportBonuses: SupportBonus[];
  affinityNames: Map<number, string>;
  terrainNames: TerrainReadResult;
  condSlots: CondSlotInfo[];
  eventTrace: EventTrace;
  chapters: Chapter[];
  playOrder: PlayOrder;
  /**
   * Debug (developer) maps detected over the END_EVENT evidence - real rows
   * the story never visits. Kept as a run-level fact next to the play order
   * because both answer "which maps does a playthrough touch".
   */
  debugMaps: readonly DebugMapRecord[];
  unitStats: UnitStatRow[];
  forceSortie: ForceSortieTable | null;
  /** Class-change branch table; `null` on FE6/FE7, which have none. */
  classBranch: ClassBranchTable | null;
  items: Item[];
  shopData: ShopReadResult | null;
  chapterObjects: ChapterObjects[];
  skills: SkillReadResult | null;
}
