import type { AnalysisUnit } from "./data.ts";
import type { UnitAvailability, JoinState } from "./availability.ts";
import type { UnitProjection } from "./projection.ts";
import { trainingLevelsForProjection } from "./projection.ts";
import type { UnitJoin } from "./joins.ts";
import type { UnitAppearance } from "./appearances.ts";
import type { ClassRecord, PlayOrderRows } from "../model/records.ts";
import { isPlayerArmyAppearance } from "./appearances.ts";
import { buildPromotionGraph } from "../model/promotion.ts";
import type { ClassBranchRow } from "../model/records.ts";
import { classProfile } from "./classProfile.ts";

interface CandidatesInput {
  units: readonly AnalysisUnit[];
  classes: readonly ClassRecord[];
  classBranches: readonly ClassBranchRow[];
  availability: readonly UnitAvailability[];
  projections: readonly UnitProjection[];
  joins: readonly UnitJoin[];
  appearances: readonly UnitAppearance[];
  playOrder: PlayOrderRows;
}

/** Join existing analyses by id, without selecting a strategy or inventing entry stats. */
export function candidateFacts(input: CandidatesInput) {
  const unitById = new Map(input.units.map((unit) => [unit.id, unit]));
  const classById = new Map(input.classes.map((cls) => [cls.id, cls]));
  const projectionById = new Map(input.projections.map((row) => [row.unitId, row]));
  const availabilityById = new Map(input.availability.map((row) => [row.unitId, row]));
  const graph = buildPromotionGraph(input.classes, input.classBranches);
  const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);
  const rosterIds = sorted(
    input.units.filter((u) => !u.isEmpty && u.hasSupportData).map((u) => u.id),
  );
  const joinRows = input.joins.filter((row) => row.kind === "join");
  const joinerIds = sorted(
    input.availability.filter((u) => u.joinMapIndex !== null).map((u) => u.unitId),
  );
  const joinRowIds = new Set(joinRows.map((row) => row.appearance.unitId));
  const roster = new Set(rosterIds);
  const joiners = new Set(joinerIds);
  const joinStateIds: Record<JoinState, number[]> = {
    on_route: [],
    off_route: [],
    unresolved: [],
    never: [],
  };
  for (const row of input.availability) joinStateIds[row.joinState].push(row.unitId);
  for (const ids of Object.values(joinStateIds)) ids.sort((a, b) => a - b);

  const entries = input.appearances.filter(isPlayerArmyAppearance);
  const profile = (id: number) => {
    const cls = classById.get(id);
    return cls === undefined || cls.isEmpty ? null : classProfile(cls);
  };
  const units = sorted([...rosterIds, ...joinerIds]).map((unitId) => {
    const unit = unitById.get(unitId);
    const projection = projectionById.get(unitId);
    const availability = availabilityById.get(unitId);
    const tableClass = unit === undefined ? null : profile(unit.classId);
    const joinEvidence = entries.filter(
      (entry) => entry.unitId === unitId && entry.mapIndex === availability?.joinMapIndex,
    );
    const baselineIssues: string[] = [];
    if (unit === undefined) baselineIssues.push("missing-unit");
    if (projection === undefined) baselineIssues.push("missing-projection");
    if (unit !== undefined && tableClass === null) baselineIssues.push("missing-class");
    if (joiners.has(unitId) && joinEvidence.length === 0)
      baselineIssues.push("missing-join-evidence");
    if (unit !== undefined) {
      if (
        joinEvidence.some(
          (entry) => entry.placedClassId !== 0 && entry.placedClassId !== unit.classId,
        )
      )
        baselineIssues.push("class-override");
      if (joinEvidence.some((entry) => entry.placedLevel !== unit.level))
        baselineIssues.push("level-override");
    }
    if (joinEvidence.some((entry) => entry.placedAutolevel !== 0))
      baselineIssues.push("entry-autolevel");
    const plans =
      projection === undefined || unit === undefined || tableClass === null
        ? []
        : projection.maxedByBranch.length > 0
          ? projection.maxedByBranch.map((branch) => ({
              classId: branch.classId,
              stats: branch.stats,
              promotionSteps: 1,
            }))
          : [{ classId: unit.classId, stats: projection.maxed, promotionSteps: 0 }];
    return {
      unitId,
      name: unit?.name ?? availability?.name ?? "",
      inRoster: roster.has(unitId),
      availability:
        availability === undefined
          ? null
          : {
              joinState: availability.joinState,
              joinPosition: availability.joinPosition,
              joinMapIndex: availability.joinMapIndex,
              joinUnresolved: availability.joinUnresolved,
              availableCount: availability.availableCount,
              totalAfterJoin: availability.totalAfterJoin,
              windowRatio: availability.windowRatio,
              gaps: availability.gaps,
            },
      tableClass,
      tableLevel: unit?.level ?? null,
      growths: unit?.growths ?? null,
      tableStartingStats: tableClass === null ? null : (projection?.startingStats ?? null),
      joinEvidence,
      baselineIssues,
      plans: plans.map((plan) => ({
        ...plan,
        profile: profile(plan.classId),
        trainingLevels:
          unit === undefined
            ? null
            : trainingLevelsForProjection(unit.level, plan.promotionSteps > 0),
        hasFurtherPromotion: (graph.targetsAll.get(plan.classId)?.length ?? 0) > 0,
      })),
    };
  });
  return {
    audit: {
      rosterIds,
      joinerIds,
      joinRowCount: joinRows.length,
      joinStateIds,
      rosterWithoutJoinIds: rosterIds.filter((id) => !joiners.has(id)),
      joinersOutsideRosterIds: joinerIds.filter((id) => !roster.has(id)),
      joinIdsMissingFromAvailability: sorted([...joinRowIds].filter((id) => !joiners.has(id))),
      joinIdsMissingFromJoins: joinerIds.filter((id) => !joinRowIds.has(id)),
      missingUnitIds: joinerIds.filter((id) => !unitById.has(id)),
      missingProjectionIds: joinerIds.filter((id) => !projectionById.has(id)),
      baselineIssueIds: units
        .filter((unit) => unit.baselineIssues.length > 0)
        .map((unit) => unit.unitId),
    },
    playOrder: {
      steps: input.playOrder.steps,
      last: input.playOrder.steps.at(-1) ?? null,
      lastPlayable: input.playOrder.steps.findLast((step) => step.playable) ?? null,
    },
    units,
  };
}

export type CandidateFacts = ReturnType<typeof candidateFacts>;
