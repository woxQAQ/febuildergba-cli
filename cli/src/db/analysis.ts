/**
 * The bridge between an open extract db and the analysis modules: each function
 * here pairs an analysis entry point with the queries that feed it.
 *
 * This is why the pairing lives on the db side rather than in `analysis/`: the
 * modules stay pure (they take plain rows and return conclusions, no db type in
 * sight) and the knowledge of *which* tables an analysis needs sits next to the
 * code that can fetch them. A command therefore calls one function and pays for
 * exactly the rows its analysis reads - `roles` never loads unit stats, and
 * `expcurve` never loads the event layer.
 *
 * The adapters are async because the queries are; the analysis functions
 * themselves are synchronous, which is the shape that makes them testable over
 * hand-built rows.
 */

import { computeAvailability } from "../analysis/availability.ts";
import type { UnitAvailability } from "../analysis/availability.ts";
import { computeExpCurve } from "../analysis/expcurve.ts";
import type { ExpCurveOptions, ExpCurveResult } from "../analysis/expcurve.ts";
import { projectUnits } from "../analysis/projection.ts";
import type { ProjectionOptions, UnitProjection } from "../analysis/projection.ts";
import type { ExtractHandle } from "./queries.ts";

/** `availability`: units, chapters, the play order, force-sortie and the trace. */
export async function availabilityOf(x: ExtractHandle): Promise<UnitAvailability[]> {
  return computeAvailability({
    units: await x.units(),
    chapters: await x.chapters(),
    playOrder: await x.playOrder(),
    forceSortie: await x.forceSortie(),
    trace: await x.trace(),
  });
}

/** `expcurve`: the stat rows the budget counts, plus classes, game and order. */
export async function expCurveOf(x: ExtractHandle, opts: ExpCurveOptions = {}): Promise<ExpCurveResult> {
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
 * `projection`: the exp curve's rows plus the roster. It reads `units` and
 * `trace` where `expcurve` does not, because the projection is the half that
 * projects people and ranks their joins.
 */
export async function projectionOf(
  x: ExtractHandle,
  opts: ProjectionOptions = {},
): Promise<UnitProjection[]> {
  return projectUnits(
    {
      game: await x.game(),
      classes: await x.classes(),
      unitStats: await x.unitStats(),
      playOrder: await x.playOrder(),
      units: await x.units(),
      chapters: await x.chapters(),
      trace: await x.trace(),
    },
    opts,
  );
}
