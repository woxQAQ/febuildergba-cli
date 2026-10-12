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
 * eventTrace owns byte decoding and termination. This module walks that
 * evidence, unchanged whether it came from load() or an extract database.
 *
 * The table names each argument by a single letter from its pattern
 * (`222AXXXX` -> `symbol: "X"`), so match on the `MAPCHAPTER` type, not the name.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import type { Chapter } from "./chapters.ts";
import type { EventGraph, TracedInstruction } from "./eventTrace.ts";

/** One decoded "this chapter goes to that chapter" edge. */
export interface ChapterTransition {
  /** The opcode that carried it. */
  readonly opcode: string;
  /** Destination chapter id: a map-setting index. */
  readonly targetMap: number;
  /** Where in the source chapter's END_EVENT the instruction sat. */
  readonly scriptAddress: number;
  /**
   * 0 when the instruction is in the chapter's own END_EVENT, higher when it
   * was reached through `CALL`s. A transition found at depth > 0 sits in a
   * shared helper, so it fires for every chapter that calls that helper.
   */
  readonly callDepth: number;
}

export interface ChapterEdges {
  /** The map-setting row this belongs to. **Not** the chapter number. */
  readonly mapIndex: number;
  /** The game's own chapter number, for display next to the title. */
  readonly chapterNumber: number;
  /** Chapter title as decoded from the map-setting record. */
  readonly title: string;
  /** The chapter's END_EVENT pointer, or 0 when it has none. */
  readonly endEventAddress: number;
  /** Instructions decoded before the walk ended. */
  readonly instructionsDecoded: number;
  /** Why the walk stopped - a table that ran out is not a chapter with no exit. */
  readonly stopReason: string;
  readonly transitions: readonly ChapterTransition[];
}

/** Maximum `CALL` nesting followed. Deeper helpers are shared boilerplate. */
const MAX_CALL_DEPTH = 4;

/**
 * One instruction of an event script, reduced to what the transition walk
 * reads: the transition it carries (opcode + destination + where it sat) and
 * the sub-event it references. Both in-memory and persisted evidence use
 * event script ids, and feed the same walk implementation.
 */
export interface TransitionStep {
  transition: { opcode: string; targetMap: number; scriptAddress: number } | null;
  call: number | null;
}

/**
 * The END_EVENT walk, shared by extraction and db queries: depth-first
 * from the seed script, CALLs followed to depth {@link MAX_CALL_DEPTH}, each
 * script entered at most once per walk (a shared helper's transitions are
 * attributed at the depth it was first reached). Transitions come out in
 * encounter order: a CALLed helper's edges sit at the CALL instruction, before
 * the caller's remaining ones.
 */
export function walkTransitions(
  seed: number,
  instructionsOf: (script: number) => Iterable<TransitionStep>,
): ChapterTransition[] {
  const transitions: ChapterTransition[] = [];
  const visited = new Set<number>();
  const walk = (script: number, depth: number): void => {
    if (visited.has(script) || depth > MAX_CALL_DEPTH) return;
    visited.add(script);
    for (const step of instructionsOf(script)) {
      if (step.transition !== null) {
        transitions.push({ ...step.transition, callDepth: depth });
      }
      if (step.call !== null) walk(step.call, depth + 1);
    }
  };
  walk(seed, 0);
  return transitions;
}

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
 * Transition steps over decoded instructions. Decode termination belongs to
 * eventTrace, not to this adapter; composite sub-event references are followed
 * just like ordinary CALL operands.
 */
export function traceTransitionSteps(
  instructionsByScript: ReadonlyMap<number, readonly TracedInstruction[]>,
): (scriptId: number) => Iterable<TransitionStep> {
  return function* steps(scriptId: number): Generator<TransitionStep> {
    for (const i of instructionsByScript.get(scriptId) ?? []) {
      yield {
        transition:
          i.targetMap === null
            ? null
            : { opcode: i.opcode, targetMap: i.targetMap, scriptAddress: i.address },
        call: null,
      };
      for (const call of i.calls) yield { transition: null, call: call.scriptId };
    }
  };
}

/**
 * The destinations a chapter's END_EVENT advances the story to. `LOMA` is
 * dropped (moves a battle within one map); a self-destination is dropped too -
 * Dream of Five's map 18 names itself before the chapter it leads to, and
 * treating it as an edge makes the walk believe it closed a loop one chapter in.
 */
export function steppingDestinations(edge: ChapterEdges): number[] {
  return [
    ...new Set(
      edge.transitions
        .filter((t) => t.opcode !== "LOMA" && t.targetMap !== edge.mapIndex)
        .map((t) => t.targetMap),
    ),
  ];
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

/** One map in play order. */
export interface PlayOrderStep {
  /** 1-based position, no gaps. */
  readonly order: number;
  /** Map-setting row index. **Not** a chapter number. */
  readonly mapIndex: number;
  /**
   * `main` for a chapter on the no-detour path, `side` for one spliced in at a
   * branch. A side chapter is optional content, but it still occupies a slot in
   * the order because a playthrough that takes it plays it at that point.
   */
  readonly role: "main" | "side";
  /**
   * False for a row the walk passed through that is not a playable map - a row
   * that claims its own slot id but deploys no units, which is how a chain ends
   * rather than where. Vision Quest has one, at the very end.
   */
  readonly playable: boolean;
}

/**
 * The order the chapters are played in, main path and side chapters together.
 * `chain` answers "shortest route"; this answers "sequence a playthrough sees",
 * which unit-availability questions need. They differ by side chapters: Vision
 * Quest's chain is 41 maps, its order 49 rows (48 playable + the final
 * transition's non-playable stop).
 *
 * A side chapter is played between the two main chapters a branch names, because
 * its own END_EVENT leads back into the next main chapter. The ROM agrees: gaiden
 * chapters are numbered `N.5` (`u16(+0x80) / 2`), and map 36 "Old Habits" is
 * 5.5, exactly where the map 16 branch puts it. Side chapters can branch again
 * (map 63 -> main path or map 60), so the walk is recursive.
 */
export interface PlayOrder {
  /** Every map on a known path, in play order, playable rows included. */
  readonly steps: readonly PlayOrderStep[];
  /** `mapIndex` -> 1-based position. A map absent from this is off every path. */
  readonly position: ReadonlyMap<number, number>;
  /** The no-detour path, in order - the map indices `chain` holds. */
  readonly mainPath: readonly number[];
  /**
   * Maps with more than one story-advancing destination, each naming the side
   * chapter that gets spliced in there.
   */
  readonly branches: readonly PathBranch[];
  /**
   * Maps the main walk re-entered - where it stopped because it looped, not
   * where the story ends. Empty when the path ran to a dead end.
   */
  readonly closedLoop: readonly number[];
  /** Maps numbered 1 that no real numbered chapter leads into. */
  readonly startCandidates: readonly number[];
  /** How the opening chapter was chosen, for the caller to report. */
  readonly startReason: string;
}

/**
 * Order the chapters into the sequence a playthrough sees. The main path is the
 * first-destination walk; every other destination is a detour, emitted where it
 * hangs off the main path (where it is played, since its END_EVENT leads back
 * into the chapter after). Destinations already on the main path are not detours
 * - Dream of Five's map 22 names the next chapter and the one after it, and
 * treating the second as a detour would move a main chapter to the end.
 *
 * Destinations that are not map rows (LOMA, warp targets) are skipped, not
 * fatal. Non-playable rows stay in the order as `playable: false`, so
 * `steps.filter((s) => s.playable)` is the chapter list while `order` stays a
 * comparable rank.
 */
export function buildPlayOrder(
  edges: readonly ChapterEdges[],
  isReal: (mapIndex: number) => boolean = () => true,
): PlayOrder {
  const byMap = new Map(edges.map((e) => [e.mapIndex, e]));
  const walk = walkMainPath(edges, isReal);
  const onMainPath = new Set(walk.chain.map((e) => e.mapIndex));

  const steps: PlayOrderStep[] = [];
  const placed = new Set<number>();
  const push = (mapIndex: number, role: "main" | "side"): void => {
    if (placed.has(mapIndex)) return;
    placed.add(mapIndex);
    steps.push({ order: steps.length + 1, mapIndex, role, playable: isReal(mapIndex) });
  };

  /** A detour and everything behind it, walking until it rejoins the main path. */
  const walkDetour = (root: number): void => {
    if (placed.has(root) || onMainPath.has(root)) return;
    const edge = byMap.get(root);
    if (edge === undefined) return;
    push(root, "side");
    for (const dest of steppingDestinations(edge)) walkDetour(dest);
  };

  for (const edge of walk.chain) {
    push(edge.mapIndex, "main");
    for (const dest of steppingDestinations(edge)) {
      if (onMainPath.has(dest)) continue;
      walkDetour(dest);
    }
  }

  return {
    steps,
    position: new Map(steps.map((s) => [s.mapIndex, s.order])),
    mainPath: walk.chain.map((e) => e.mapIndex),
    branches: walk.branches,
    closedLoop: walk.closedLoop,
    startCandidates: walk.candidates.map((c) => c.mapIndex),
    startReason:
      walk.candidates[0] === undefined
        ? "no map numbered 1 that no real numbered chapter leads into"
        : "map-table order among the maps numbered 1 that no real numbered " +
          `chapter leads into (chose map ${walk.candidates[0].mapIndex})`,
  };
}

/** Branch point of the main path: a map whose END_EVENT names several next chapters. */
export interface PathBranch {
  readonly mapIndex: number;
  readonly to: readonly number[];
  readonly viaLoma: readonly number[];
}

/** The main path and everything the walk learned on the way. */
interface MainWalk {
  /** The first-destination path, in order. */
  readonly chain: readonly ChapterEdges[];
  readonly branches: readonly PathBranch[];
  /** Maps the walk re-entered - where it stopped because it looped. */
  readonly closedLoop: readonly number[];
  /** Maps numbered 1 that no real numbered chapter leads into. */
  readonly candidates: readonly ChapterEdges[];
}

/**
 * Walk the no-detour path by always taking a branch's *first* destination.
 *
 * The obvious start rule - "a map with an outgoing transition and no incoming
 * one" - picks the wrong map: Vision Quest's true opening, map 0 "A Forced
 * Hand", *has* an incoming edge (map 57, unnumbered, reached only after the
 * ending, redirects to it). So an incoming edge counts only from a **real,
 * numbered** chapter. Two things are filtered out:
 *   - padded map-table rows (their transitions copy a real map's, inventing a
 *     cycle at the opening);
 *   - unnumbered chapters (`chapterNumber === 0`: post-battle, bonus, skirmish),
 *     which no playthrough walks through to the start.
 * The remaining candidates are what the prep screen calls chapter 1; Vision
 * Quest has four (map 0, 12, 18, 21), one per act. The first in map-table order
 * is the real one, and `startReason` reports the choice.
 */
function walkMainPath(
  edges: readonly ChapterEdges[],
  isReal: (mapIndex: number) => boolean,
): MainWalk {
  const byMap = new Map(edges.map((e) => [e.mapIndex, e]));

  const reachedFromRealChapter = new Set<number>();
  for (const e of edges) {
    if (!isReal(e.mapIndex) || e.chapterNumber === 0) continue;
    for (const t of e.transitions) reachedFromRealChapter.add(t.targetMap);
  }

  const candidates = edges.filter(
    (e) =>
      e.chapterNumber === 1 &&
      steppingDestinations(e).length > 0 &&
      !reachedFromRealChapter.has(e.mapIndex),
  );

  const chain: ChapterEdges[] = [];
  const branches: PathBranch[] = [];
  const closedLoop: number[] = [];
  if (candidates.length === 0) return { chain, branches, closedLoop, candidates };

  const lomaOf = (e: ChapterEdges): number[] => [
    ...new Set(e.transitions.filter((t) => t.opcode === "LOMA").map((t) => t.targetMap)),
  ];

  const seen = new Set<number>();
  let cur: ChapterEdges | undefined = candidates[0];
  while (cur !== undefined && !seen.has(cur.mapIndex)) {
    seen.add(cur.mapIndex);
    chain.push(cur);

    const advancing = steppingDestinations(cur);
    if (advancing.length > 1) {
      branches.push({ mapIndex: cur.mapIndex, to: advancing, viaLoma: lomaOf(cur) });
    }

    const next = byMap.get(advancing[0] ?? -1);
    if (next === undefined) break; // destination is not a map row
    if (seen.has(next.mapIndex)) {
      closedLoop.push(next.mapIndex); // walked into the chain again
      break;
    }
    cur = next;
  }
  return { chain, branches, closedLoop, candidates };
}
