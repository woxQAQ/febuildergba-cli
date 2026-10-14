/** Analysis inputs name the persisted facts each calculation consumes. */
import type { GameVersion } from "../model/game.ts";
import type {
  UnitRecord,
  ClassRecord,
  PlacementRecord,
  ChapterRecord,
  ForceSortieRow,
  PlayOrderRows,
} from "../model/records.ts";
import type { EventGraph } from "../model/events.ts";
import type { UnitStatRow, UnitStartingStats } from "../model/stats.ts";

/** Analysis enriches persisted unit deltas with class bases before calculating. */
export type AnalysisUnit = UnitRecord & { startingStats: UnitStartingStats };
export type AnalysisClass = ClassRecord;
export type AnalysisPlacement = PlacementRecord;
export type AnalysisChapter = ChapterRecord;
export type { SupportPartnerRow, ForceSortieRow, PlayOrderRows } from "../model/records.ts";

// ------------------------------------------------------------------ module inputs
//
// Each calculation declares only the facts it reads. Services supply these
// inputs without exposing persistence or extraction resources to the rules.

/** `analysis/appearances.ts` - the shared collector behind joins/availability/projection. */
export interface AppearancesInput {
  units: readonly AnalysisUnit[];
  chapters: readonly AnalysisChapter[];
  trace: EventGraph;
  /**
   * Debug (developer) maps (`meta` `debugMaps`): real rows no playthrough
   * visits. Appearances there are dropped, so a debug load block cannot pose
   * as a unit's earliest army entry.
   */
  debugMaps: ReadonlySet<number>;
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
