/**
 * Facts derived from more than one table.
 *
 * Both functions here answer a question no single table can answer on its own,
 * which is why they are not in `tables/`.
 *
 * This file used to hold `buildReport` too - ~450 lines assembling an
 * all-in-one `dump` document. That is gone: `dump` was deleted because
 * everything in it already had a command that owned it, and having a second
 * projection of the same facts is how `isPromotedClass` ended up `undefined`
 * in `units` output while the dump had it wrong. Two code paths, one fact.
 */

import type { UnitClass } from '../tables/classes.ts';
import type { Chapter } from '../tables/chapters.ts';

/**
 * True when a map-setting row names a real map: it has a title, and that title
 * is not the world-map glyph. Unused slots (empty title) and skirmish maps
 * (`@001F`) fail; the prologue and named bonus maps pass.
 *
 * Do **not** test `chapterNumber` alone for this: the prologue legitimately
 * carries chapter number 0, the same value as an unused slot.
 */
export function isStoryTitle(title: string): boolean {
  return title !== '' && title !== '@001F';
}

export function isStoryChapter(chapter: Chapter | null): boolean | null {
  return chapter === null ? null : isStoryTitle(chapter.title);
}

/**
 * The class `id` promotes INTO - the forward direction.
 *
 * `promotesToClassId` links a base/promoted pair in BOTH directions, so the
 * link alone cannot tell you which side is promoted. `sortOrder` can: the
 * higher value in a pair is the promoted class (see `load.ts`).
 */
export function promotesForwardTarget(classes: readonly UnitClass[], id: number): number {
  const cls = classes.find((c) => c.id === id);
  if (!cls) return 0;
  const target = classes.find((c) => c.id === cls.promotesToClassId);
  return target && target.sortOrder > cls.sortOrder ? target.id : 0;
}