/**
 * These are the *domain* types the extract db round-trips into: the loader
 * (`db/queries.ts`) builds them from rows, and `analysis/` reads them. They are
 * `Pick`s of the parser's types rather than parallel interfaces, because the
 * arithmetic in `analysis/` was written against `Unit` / `UnitClass` /
 * `PlacedUnit` and sharing the field types keeps it honest (same `growths`
 * shape, same `abilityFlags` tuple).
 *
 * There is deliberately no aggregate "everything the commands need" type: each
 * analysis module declares the fields it reads, and its command asks the loader
 * only for those - so a module that needs no unit stats does not pay for them.
 * Nothing here re-parses the ROM - the db is the single source of truth, so a
 * field that is not persisted cannot appear here.
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

/** `support_partners` row, in extract (directed-record) order. */
export interface SupportPartnerRow {
  unitId: number;
  partnerId: number;
  initial: number;
  growth: number;
}

/** `force_sortie` row; empty when the game has no such table. */
export type ForceSortieRow = Pick<ForceSortieRecord, "unitId" | "mapIndex">;

/** `derived_play_order`: the steps, and map index -> 1-based position. */
export type PlayOrderRows = Pick<PlayOrder, "steps" | "position">;

// ------------------------------------------------------------------ module inputs
//
// Each analysis module declares the rows it reads, here rather than in an
// aggregate: a caller (a command, or the adapter in `db/analysis.ts`) hands over
// exactly these, so a module's dependencies are visible in its signature and a
// command pays only for what it calls. Fields are the same objects the loader
// builds - these interfaces only name the subsets, they add no structure.

/** `analysis/appearances.ts` - the shared collector behind joins/availability/projection. */
export interface AppearancesInput {
  units: readonly AnalysisUnit[];
  chapters: readonly AnalysisChapter[];
  trace: EventGraph;
}

/** `analysis/availability.ts` - the unit x chapter matrix. */
export interface AvailabilityInput extends AppearancesInput {
  playOrder: PlayOrderRows;
  forceSortie: readonly ForceSortieRow[];
}

/** `analysis/expcurve.ts` - the per-chapter experience budget. */
export interface ExpCurveInput {
  game: GameVersion;
  classes: readonly AnalysisClass[];
  /** `derived_unit_stats`: the simulator output the budget counts enemies from. */
  unitStats: readonly UnitStatRow[];
  playOrder: PlayOrderRows;
}

/**
 * `analysis/projection.ts` - expected stats. A superset of {@link ExpCurveInput}
 * (the projection consumes the curve) plus the roster it projects and the
 * appearances it ranks joins by.
 */
export interface ProjectionInput extends ExpCurveInput, AppearancesInput {}
