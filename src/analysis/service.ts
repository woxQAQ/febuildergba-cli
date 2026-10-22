/**
 * Analysis service: choose evidence, assemble algorithm inputs and interpret
 * snapshot quality. Repository methods return stored records; game rules and
 * analysis policy run here. Diagnostics are returned, never printed.
 */

import { computeAvailability } from "./availability.ts";
import type { UnitAvailability } from "./availability.ts";
import { computeExpCurve } from "./expcurve.ts";
import type { ExpCurveOptions, ExpCurveResult } from "./expcurve.ts";
import { computeJoins } from "./joins.ts";
import type { UnitJoin } from "./joins.ts";
import { projectUnits } from "./projection.ts";
import type { UnitProjection } from "./projection.ts";
import type { AnalysisUnit } from "./data.ts";
import type { ExtractHandle } from "../repository/read.ts";
import { combineStartingStats } from "../model/stats.ts";
import { eventDecodeWarning } from "../model/events.ts";
import { collectAppearances } from "./appearances.ts";
import { candidateFacts, type CandidateFacts } from "./candidates.ts";
import type { ChapterWindow } from "../model/chapterWindow.ts";

/** A lazy analysis session: only the evidence actually requested is checked. */
export type AnalysisSource = Omit<ExtractHandle, "close"> & {
  diagnostics(): readonly string[];
};

export function prepareAnalysis(repository: ExtractHandle, path: string): AnalysisSource {
  const diagnostics: string[] = [];
  let eventQuality: Promise<void> | undefined;
  let debugMapsWarned = false;
  const requireAvailable = async (kind: "chapters" | "events"): Promise<void> => {
    if (!(await repository.availability())[kind]) {
      throw new Error(
        `${path}: ${kind} data is unavailable, not empty - `
          + "re-run extract with the canonical data resources and a readable chapter table",
      );
    }
  };
  const requireEvents = (): Promise<void> =>
    (eventQuality ??= (async () => {
      await requireAvailable("events");
      const warning = eventDecodeWarning(await repository.scripts());
      if (warning !== null) diagnostics.push(warning);
    })());

  return {
    availability: () => repository.availability(),
    extractionDiagnostics: () => repository.extractionDiagnostics(),
    game: () => repository.game(),
    units: () => repository.units(),
    classes: () => repository.classes(),
    scripts: () => repository.scripts(),
    forceSortie: () => repository.forceSortie(),
    supportPartners: () => repository.supportPartners(),
    classBranches: () => repository.classBranches(),
    debugMaps: async () => {
      // The exclusion is a fact about the ROM, but a silent one changes every
      // join ranking, so say it once per session.
      await requireEvents();
      const records = await repository.debugMaps();
      if (records.length > 0 && !debugMapsWarned) {
        debugMapsWarned = true;
        const list = records.map((r) => `map ${r.mapIndex} (${r.reason})`).join("; ");
        diagnostics.push(
          `excluded ${records.length} debug map(s) from joins/availability/candidates: ${list}`,
        );
      }
      return records;
    },
    chapters: async () => {
      await requireAvailable("chapters");
      return repository.chapters();
    },
    playOrder: async () => {
      await requireEvents();
      return repository.playOrder();
    },
    trace: async () => {
      await requireEvents();
      return repository.trace();
    },
    unitStats: async () => {
      await requireEvents();
      return repository.unitStats();
    },
    diagnostics: () => [...diagnostics],
  };
}

/** Starting stats are a game rule, assembled from stored deltas and class bases. */
export async function unitsOf(
  x: Pick<AnalysisSource, "units" | "classes">,
): Promise<AnalysisUnit[]> {
  const units = await x.units();
  const bases = new Map((await x.classes()).map((c) => [c.id, c.bases]));
  return units.map((u) => ({
    ...u,
    startingStats: combineStartingStats(u.stats, bases.get(u.classId)),
  }));
}

/** `joins`: witnessed appearances and the play-order positions that rank them. */
export async function joinsOf(x: AnalysisSource): Promise<UnitJoin[]> {
  return computeJoins({
    units: await unitsOf(x),
    chapters: await x.chapters(),
    trace: await x.trace(),
    debugMaps: new Set((await x.debugMaps()).map((r) => r.mapIndex)),
    position: (await x.playOrder()).position,
  });
}

/** `availability`: units, chapters, the play order, force-sortie and the trace. */
export async function availabilityOf(
  x: AnalysisSource,
  window?: ChapterWindow,
): Promise<UnitAvailability[]> {
  return computeAvailability(
    {
      units: await unitsOf(x),
      chapters: await x.chapters(),
      playOrder: await x.playOrder(),
      forceSortie: await x.forceSortie(),
      trace: await x.trace(),
      debugMaps: new Set((await x.debugMaps()).map((r) => r.mapIndex)),
    },
    window,
  );
}

/** `expcurve`: the stat rows the budget counts, plus classes, game and order. */
export async function expCurveOf(
  x: AnalysisSource,
  opts: ExpCurveOptions = {},
): Promise<ExpCurveResult> {
  return computeExpCurve(
    {
      game: await x.game(),
      classes: await x.classes(),
      unitStats: await x.unitStats(),
      playOrder: await x.playOrder(),
    },
    opts,
  );
}

/**
 * Unit-table baselines and branch projections consumed by candidates.
 * Entry evidence ranks joins; actual saved-game training is not reconstructed.
 */
export async function projectionOf(x: AnalysisSource): Promise<UnitProjection[]> {
  return projectUnits({
    game: await x.game(),
    classes: await x.classes(),
    classBranches: await x.classBranches(),
    unitStats: await x.unitStats(),
    playOrder: await x.playOrder(),
    units: await unitsOf(x),
    chapters: await x.chapters(),
    trace: await x.trace(),
    debugMaps: new Set((await x.debugMaps()).map((r) => r.mapIndex)),
  });
}

/** Assemble existing analyses for a complete, strategy-free candidate audit. */
export async function candidatesOf(
  x: AnalysisSource,
  window?: ChapterWindow,
): Promise<CandidateFacts> {
  const appearances = {
    units: await unitsOf(x),
    chapters: await x.chapters(),
    trace: await x.trace(),
    debugMaps: new Set((await x.debugMaps()).map((row) => row.mapIndex)),
  };
  return candidateFacts({
    ...appearances,
    classes: await x.classes(),
    classBranches: await x.classBranches(),
    playOrder: await x.playOrder(),
    availability: await availabilityOf(x, window),
    projections: await projectionOf(x),
    joins: await joinsOf(x),
    appearances: collectAppearances(appearances),
  });
}
