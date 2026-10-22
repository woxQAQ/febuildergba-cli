/**
 * Debug (developer) maps: chapter rows the story never visits and that never
 * advance the story. A hack author leaves a jump-chapter menu, a unit test
 * bench or an old draft behind; the data is real, so the extractors read it,
 * but no playthrough ever sets foot there.
 *
 * dream-of-five carries one: map 60, unnumbered and untitled, deploys 34
 * level-20 units from its START_EVENT, its OBJECT event is a
 * CHECK_EVBIT -> LOMA -> chapter-name menu that jumps to ~34 chapters, and its
 * END_EVENT is a bare `MNCH` back to itself. Every appearance-based analysis
 * (`joins`, `availability`, `projection`) used to rank that block as the
 * earliest player-army appearance of 17 roster units - "joined on map 60" with
 * a null play-order position and zero available chapters, i.e. the static data
 * claimed they never join at all.
 *
 * ## Rule
 *
 * A map is debug content when **all** of these hold:
 *
 *  1. **Unnumbered and untitled** - story content carries a prep-screen number
 *     (every act restarts at 1, never 0) and a chapter title. Chapter 0 with an
 *     empty title is the author's scratch space.
 *  2. **Self-looping END_EVENT** - at least one chapter-advance transition
 *     (`MNCH`/`MNC2`/`MNC3`; `LOMA` only switches battles within one map and
 *     does not count) and **every** transition targets the map itself. A
 *     chapter whose END_EVENT only reloads itself cannot advance a playthrough,
 *     whatever enters it.
 *  3. **Nothing leads in** - no other chapter's END_EVENT transitions to it.
 *     A map the story walks into is story content even when it self-loops.
 *
 * ## Why map-id bytes and deploy slots are not consulted
 *
 * They look like the natural "is this a real map" guard, and using them loses:
 * map 60 is a copied row whose map-id byte was never updated (it reads 0, so
 * `isRealMap` rejects it) while deploying 34 units and carrying the whole debug
 * menu - exactly the case `tables/storyPath.ts` warns about. Padded rows need
 * no guard either: they either have no END_EVENT at all or point at a shared
 * terminator script with no transitions, which condition 2 already excludes.
 * Across both shipped fixtures the only self-looping chapter in either ROM is
 * dream-of-five's map 60, so condition 2 is doing the real work; 1 and 3 keep
 * legit content out. Vision Quest's chapter-0 trial maps are unnumbered and
 * often untitled, but their END_EVENTs step forward to another chapter, and
 * dream-of-five's route-A chapters are entered through a world-map node, which
 * leaves no END_EVENT edge either - they are numbered and titled, so the
 * self-loop condition is what separates them.
 *
 * The rule is deliberately narrow: a map that merely sits off the linearized
 * play order (an orphaned draft chapter, a route branch) is *not* debug
 * content and stays visible as a sighting.
 *
 * Only the END_EVENT walk feeds this, the same evidence `readAllTransitions`
 * collects: OBJECT-slot menus (the chapter select above) are not chapter
 * transitions and must not count as "advances somewhere".
 */

import type { ChapterEdges } from "./storyPath.ts";

/** One detected debug map, with the reason it was classified as one. */
export interface DebugMapRecord {
  /** Map-setting row index. */
  readonly mapIndex: number;
  /** Human-readable justification, surfaced as an analysis diagnostic. */
  readonly reason: string;
}

/**
 * Detect debug maps among the chapter rows. Takes only the END_EVENT edges -
 * the same evidence the play-order walk consumes - so "transition" means
 * exactly one thing across the model.
 */
export function detectDebugMaps(edges: readonly ChapterEdges[]): DebugMapRecord[] {
  const ledInto = new Set<number>();
  for (const e of edges) {
    for (const t of e.transitions) {
      if (t.targetMap !== e.mapIndex) ledInto.add(t.targetMap);
    }
  }

  const out: DebugMapRecord[] = [];
  for (const e of edges) {
    if (e.chapterNumber !== 0 || e.title !== "") continue;
    if (!e.transitions.some((t) => t.opcode !== "LOMA")) continue;
    if (!e.transitions.every((t) => t.targetMap === e.mapIndex)) continue;
    if (ledInto.has(e.mapIndex)) continue;
    out.push({
      mapIndex: e.mapIndex,
      reason:
        "unnumbered, untitled map whose END_EVENT loops only to itself and "
        + "that no chapter leads into",
    });
  }
  return out;
}
