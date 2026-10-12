/**
 * Chapter-to-chapter transitions, read from each map's END_EVENT script.
 *
 * The only reliable way to recover a hack's main path: `u16(mapSetting + 0x80)`
 * is the prep-screen number and **restarts at 1 in every act**. Vision Quest's
 * main path runs 0-11, 12-16, 18-19 numerically, yet threads map 16 -> 41 -> 42
 * -> 17, so grouping by consecutive chapter number invents act boundaries.
 *
 * The data is in the map-setting record's END_EVENT pointer (see `chapters.ts`);
 * on clear that script runs and its transition opcodes name the next chapter.
 * FE8 documents four:
 *     212AXXXX  MNCH  ワールドマップあり 次のマップへ
 *     222AXXXX  MNC2  ワールドマップなし 次のマップへ
 *     232AXXXX  MNC3  ワールドマップなし 次のマップへ (セーブなし)
 *     2025XXXX  LOMA  [XX:MAPCHAPTER:章ID]マップ切り替え
 * All four carry the `{MAP}` category token, a better signal than the
 * description text (FE6/FE7 spell the mnemonics differently, so searching
 * "マップ"/"JUMP" misses these).
 *
 * eventTrace owns byte decoding and termination. `model/storyPath.ts` walks
 * the decoded evidence; this module handles the chapter/ROM adapter.
 *
 * The table names each argument by a single letter from its pattern
 * (`222AXXXX` -> `symbol: "X"`), so match on the `MAPCHAPTER` type, not the name.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import type { Chapter } from "../model/snapshotRecords.ts";
import type { EventGraph, TracedInstruction } from "../model/events.ts";
import type { ChapterEdges } from "../model/storyPath.ts";
import { walkTransitions, traceTransitionSteps } from "../model/storyPath.ts";

/** Transitions over the same decoded evidence used by every event consumer. */
export function readAllTransitions(
  trace: EventGraph,
  chapters: readonly Chapter[],
): ChapterEdges[] {
  const byScript = new Map<number, TracedInstruction[]>();
  for (const instruction of trace.instructions) {
    const rows = byScript.get(instruction.scriptId);
    if (rows === undefined) byScript.set(instruction.scriptId, [instruction]);
    else rows.push(instruction);
  }
  const stepsOf = traceTransitionSteps(byScript);
  const scripts = new Map(trace.scripts.map((s) => [s.id, s]));
  const seeds = new Map<number, number>();
  for (const slot of trace.chapterSlots) {
    if (slot.slotKind === "END_EVENT" && slot.scriptId !== null && !seeds.has(slot.mapIndex)) {
      seeds.set(slot.mapIndex, slot.scriptId);
    }
  }
  return chapters.map((chapter) => {
    const seed = seeds.get(chapter.index);
    const script = seed === undefined ? undefined : scripts.get(seed);
    return {
      mapIndex: chapter.index,
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      endEventAddress: chapter.endEventAddr,
      instructionsDecoded: script?.instructionCount ?? 0,
      stopReason: script?.stopReason ?? (chapter.endEventAddr === 0 ? "no END_EVENT" : "unavailable"),
      transitions: seed === undefined ? [] : walkTransitions(seed, stepsOf),
    };
  });
}

/**
 * The map-id byte a map-setting row carries (`+0x0E`). A real map writes its own
 * slot index; unused rows leave 0, and authors who copy a row often forget to
 * update it - which separates Vision Quest's 14 padded rows from its 60 maps.
 */
export function mapIdByteOf(rom: RomBuffer, chapter: Chapter): number {
  return rom.u8(chapter.mapSettingAddr + 0x0e);
}

/**
 * Whether a map-setting row is a playable map rather than a padded slot. The
 * table has one row per map *id*, longer than the real maps; a row is real when
 * it claims its own id in the map-id byte (`+0x0E`) **and** deploys units. Hack
 * authors also register the same battle twice (identical events/conditions),
 * which this does not merge.
 */
export function isRealMap(rom: RomBuffer, chapter: Chapter): boolean {
  return mapIdByteOf(rom, chapter) === chapter.index && chapter.deploySlots > 0;
}
