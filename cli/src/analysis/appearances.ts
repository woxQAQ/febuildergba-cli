/**
 * Unit appearances: every `(unit, chapter)` record the ROM carries, from
 * initial placement blocks and from unit blocks reachable through chapter
 * event scripts. This is the shared input of every "when does this unit show
 * up" derivation - the `joins` command, `availability.ts`, `projection.ts` -
 * so the two non-obvious collection rules live here exactly once:
 *
 *   - **A class override filters the record out.** A placement whose class id
 *     is neither 0 nor the unit's own class is a stand-in (a boss cameo, a
 *     disguised NPC), not the unit itself. Event loads carry no such filter:
 *     their class id is what the unit spawns as, which says nothing about
 *     identity.
 *   - **Empty unit slots are dropped from placements** (`isEmpty`: no name,
 *     class or level), so padded placement records do not invent appearances.
 *     Event loads are kept verbatim: a reachable unit block is already a
 *     deliberate load, and the old `unit_joins` view reported them without a
 *     unit-table join - filtering here would lose parity for no gain.
 *
 * What counts as a *join* is deliberately not decided here: the consumers
 * disagree (off-path maps rank last but still count for `joins`, while
 * `projection` has nothing to project from without a play-order position),
 * and forcing one policy on all three would hide that.
 */

import type { ParsedRom } from "../load.ts";
import type { UnitSide } from "../tables/chapters.ts";
import type { EventTrace } from "../tables/eventTrace.ts";
import { reachedLoadSites } from "../tables/eventTrace.ts";

export interface UnitAppearance {
  unitId: number;
  mapIndex: number;
  side: UnitSide;
  /** "placement" for the initial deployment blocks, else the load site's kind. */
  source: "placement" | "recruit" | "load" | "cutscene";
  /** Class override of the record; 0 means the unit's own class. */
  placedClassId: number;
}

/**
 * Every appearance, deduplicated: the normal and hard placement blocks can
 * list the same unit twice, and a shared unit block is reached once per
 * calling script. Ordering is collection order (placements first, then event
 * loads) - consumers that rank appearances apply their own sort.
 */
export function collectAppearances(parsed: ParsedRom, trace: EventTrace): UnitAppearance[] {
  const unitById = new Map(parsed.units.filter((u) => !u.isEmpty).map((u) => [u.id, u]));
  const out: UnitAppearance[] = [];
  const seen = new Set<string>();

  const push = (a: UnitAppearance): void => {
    const key = `${a.unitId}|${a.mapIndex}|${a.side}|${a.source}|${a.placedClassId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };

  for (const chapter of parsed.chapters) {
    for (const block of [chapter.placements, chapter.hardPlacements]) {
      for (const p of block) {
        const unit = unitById.get(p.unitId);
        if (unit === undefined) continue;
        if (p.classId !== 0 && p.classId !== unit.classId) continue;
        push({
          unitId: p.unitId,
          mapIndex: chapter.index,
          side: p.side,
          source: "placement",
          placedClassId: p.classId,
        });
      }
    }
  }

  for (const site of reachedLoadSites(trace)) {
    for (const u of site.units) {
      push({
        unitId: u.unitId,
        mapIndex: site.mapIndex,
        side: u.side,
        source: site.kind,
        placedClassId: u.classId,
      });
    }
  }
  return out;
}
