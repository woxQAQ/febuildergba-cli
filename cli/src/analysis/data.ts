/**
 * The analysis commands' input: everything the ten db-backed commands need,
 * with field semantics identical to the `ParsedRom` pieces they replace. The
 * extract writes the db once (`db/populate.ts`); `db/read.ts` loads it back
 * into this shape, and the modules under `analysis/` compute over it. Nothing
 * here re-parses the ROM - the db is the single source of truth, so a field
 * that is not persisted cannot appear here.
 *
 * The row types are `Pick`s of the parser's types, not parallel interfaces:
 * the analysis modules and their helpers were written against `Unit` /
 * `UnitClass` / `PlacedUnit`, and keeping the field types shared keeps the
 * arithmetic honest (same `growths` shape, same `abilityFlags` tuple).
 */

import type { GameVersion } from "../rom/detect.ts";
import type { Unit } from "../tables/units.ts";
import type { UnitClass } from "../tables/classes.ts";
import type { PlacedUnit } from "../tables/chapters.ts";
import type { PlayOrder } from "../tables/storyPath.ts";
import type { ForceSortieRecord } from "../tables/forceSortie.ts";
import type { EventGraph } from "../tables/eventTrace.ts";
import type { UnitStatRow } from "../tables/unitStats.ts";

/**
 * A unit row, as analysis reads it. The db does not persist empty slots at
 * all, so {@link AnalysisUnit.isEmpty} is always `false` here; the field is
 * kept so the shared predicates (`hasSupportData && !isEmpty`) read the same
 * as they did over the parsed ROM.
 */
export type AnalysisUnit = Pick<
  Unit,
  | "id"
  | "name"
  | "classId"
  | "className"
  | "attribute"
  | "level"
  | "isEmpty"
  | "isPromotedClass"
  | "hasSupportData"
  | "growths"
  | "startingStats"
>;

/** A class row, as analysis reads it. `bases` is absent: its one consumer is
 *  `startingStats`, which the loader rebuilds before this type is seen. */
export type AnalysisClass = Pick<
  UnitClass,
  | "id"
  | "name"
  | "mount"
  | "flying"
  | "terrainBonusImmune"
  | "isEmpty"
  | "promotesToClassId"
  | "sortOrder"
  | "classPower"
  | "abilityFlags"
  | "caps"
  | "promotionBonuses"
>;

/** A placement-block record, as `collectAppearances` reads it. */
export type AnalysisPlacement = Pick<PlacedUnit, "unitId" | "classId" | "side">;

/** A chapter row, as analysis reads it: deploy slots plus both placement blocks. */
export interface AnalysisChapter {
  /** Map-setting row index. **Not** the chapter number. */
  index: number;
  deploySlots: number;
  /** Normal-mode block (condition slot 10), in record order. */
  placements: AnalysisPlacement[];
  /** Hard-mode block (condition slot 11), in record order. */
  hardPlacements: AnalysisPlacement[];
}

export interface AnalysisData {
  /** The ROM's game id (the db's `meta` `rom.version`), for the per-version formula branches. */
  game: GameVersion;
  /** Unit-table order. Empty slots are not persisted; see {@link AnalysisUnit}. */
  units: AnalysisUnit[];
  /** Class-table order, empty entries included. */
  classes: AnalysisClass[];
  /** Map-setting order. */
  chapters: AnalysisChapter[];
  /** `derived_play_order`: the steps, and map index -> 1-based position. */
  playOrder: Pick<PlayOrder, "steps" | "position">;
  /** `force_sortie` records; empty when the game has no such table. */
  forceSortie: readonly Pick<ForceSortieRecord, "unitId" | "mapIndex">[];
  /** `support_partners` rows, in extract (directed-record) order. */
  supportPartners: readonly {
    unitId: number;
    partnerId: number;
    initial: number;
    growth: number;
  }[];
  /**
   * The raw event layer, rebuilt from `chapter_event_slots`,
   * `event_instructions` and `load_block_units` in insertion order - the same
   * shape `extractEventTrace` produces in memory, so the reach walk in
   * `tables/eventTrace.ts` runs over either unchanged.
   */
  trace: EventGraph;
  /** `derived_unit_stats` - the same simulator output `populate` computes. */
  unitStats: UnitStatRow[];
}
