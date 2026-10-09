/**
 * Chapter-to-chapter transitions, read out of each map's END_EVENT script.
 *
 * This is the only reliable way to recover a hack's main path. Chapter numbers
 * cannot answer the question: `u16(mapSetting + 0x80)` is the number the prep
 * screen shows, and it **restarts at 1 in every act**. Vision Quest's main path
 * runs 0-11, 12-16, then 18-19 as far as the numbers are concerned, yet the
 * real path threads map 16 -> 41 -> 42 -> 17 between them, so a reader that
 * groups by consecutive chapter number invents act boundaries that do not exist.
 *
 * ## Where the information lives
 *
 * Every map-setting record has an END_EVENT pointer in its condition table
 * (see `chapters.ts`). When a chapter is cleared that script runs, and the
 * chapter-transition opcodes inside it name the next chapter directly. FE8's
 * table documents four:
 *
 * ```txt
 * 212AXXXX  MNCH  ワールドマップあり 次のマップへ   (world map, next chapter)
 * 222AXXXX  MNC2  ワールドマップなし 次のマップへ (no world map, next chapter)
 * 232AXXXX  MNC3  ワールドマップなし 次のマップへ (セーブなし / no save)
 * 2025XXXX  LOMA  [XX:MAPCHAPTER:章ID]マップ切り替え  (switch to a map)
 * ```
 *
 * All four carry the `{MAP}` category token, which is a better signal than the
 * description text - the mnemonics are spelled differently from FE6/FE7, so a
 * search for "マップ" or "JUMP" in the description column finds FE6/FE7's
 * entries and misses these.
 *
 * ## Why this module walks the script instead of scanning bytes
 *
 * `EventScript.DisAseemble` matches patterns **longest first** and returns the
 * first hit. An ad-hoc byte scan desynchronises on the first variable-length
 * operand, and every instruction after that decodes to noise - an earlier
 * attempt at this produced target values of 0 for every map while still
 * "finding" plausible-looking opcodes. So the walk here goes through
 * {@link disassemble} and {@link isExitCode} exactly as the reference does.
 *
 * ## Reading the operand
 *
 * The table names each argument after a single letter taken from its pattern:
 * `222AXXXX` yields `symbol: "X"`, not `"XXXX"`. Matching on the argument's
 * `MAPCHAPTER` type is therefore more robust than on its name.
 */

import type { RomBuffer } from '../rom/RomBuffer.ts';
import {
  argValue,
  disassemble,
  isExitCode,
  type EventCode,
  type EventScriptTable,
} from './eventScript.ts';
import type { Chapter } from './chapters.ts';
import { hex } from '../cli/hex.ts';

/** Category token the opcode table puts on every map-moving instruction. */
const MAP_CATEGORY = 'MAP';

/**
 * Opcodes that name a destination chapter.
 *
 * Keyed by the mnemonic in parentheses at the end of the table's description
 * column. Anything else tagged `{MAP}` is a graphics or timing instruction
 * whose operand coincidentally lands in the map-id range, so membership here is
 * what makes a transition trustworthy.
 */
export const TRANSITION_OPCODES: ReadonlySet<string> = new Set([
  'MNCH', // next chapter, world map
  'MNC2', // next chapter, no world map
  'MNC3', // next chapter, no save
  'LOMA', // switch to a specific map
]);

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

/** Instruction ceiling per script, matching the reference's own sanity bound. */
const MAX_STEPS = 4000;

/** The mnemonic in parentheses at the end of a description, e.g. `(MNC2)`. */
function mnemonicOf(description: string): string {
  const m = description.match(/\(([A-Z][A-Z0-9_+]*)\)/);
  return m?.[1] ?? '';
}

/**
 * The destination of a map-moving instruction.
 *
 * Prefers the argument typed `MAPCHAPTER` and falls back to the last
 * non-fixed one, because the pointer-shaped instructions use different letters
 * again.
 */
function destinationOf(rom: RomBuffer, code: EventCode): number {
  const typed = code.script.args.find((a) => a.type === 'MAPCHAPTER');
  if (typed !== undefined) return argValue(rom, code, typed.symbol);
  const vars = code.script.args.filter((a) => a.type !== 'FIXED');
  const last = vars[vars.length - 1];
  return last === undefined ? 0 : argValue(rom, code, last.symbol);
}

/** The script pointer of a `CALL`, whatever letter the table gave it. */
function callTargetOf(rom: RomBuffer, code: EventCode): number {
  const typed = code.script.args.find((a) => a.type === 'POINTER_EVENT');
  if (typed !== undefined) return argValue(rom, code, typed.symbol);
  const vars = code.script.args.filter((a) => a.type !== 'FIXED');
  const last = vars[vars.length - 1];
  return last === undefined ? 0 : argValue(rom, code, last.symbol);
}

/**
 * Decode one chapter's END_EVENT into its outgoing transitions.
 *
 * `CALL`s are followed so a transition written into a shared helper event is
 * still attributed to the chapters that use it. The walk stops at the
 * terminating opcode, at the reference's step ceiling, or at an opcode the
 * table does not recognise - and records which, because "no transitions found"
 * and "the walk fell off a cliff" are different answers.
 */
export function readChapterTransitions(
  rom: RomBuffer,
  table: EventScriptTable,
  chapter: Chapter,
): ChapterEdges {
  const edges: ChapterTransition[] = [];
  const visited = new Set<number>();

  const walk = (start: number, depth: number): { decoded: number; stop: string } => {
    if (start === 0 || visited.has(start) || depth > MAX_CALL_DEPTH) {
      return { decoded: 0, stop: 'depth limit or loop' };
    }
    visited.add(start);

    let addr = start;
    let decoded = 0;
    let lastBranch = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const code = disassemble(rom, addr, table);

      if (code.script.description === 'UNKNOWN') {
        return { decoded, stop: `unrecognised opcode at ${hex(addr)}` };
      }

      const mnemonic = mnemonicOf(code.script.description);

      if (
        code.script.category.includes(MAP_CATEGORY) &&
        TRANSITION_OPCODES.has(mnemonic)
      ) {
        edges.push({
          opcode: mnemonic,
          targetMap: destinationOf(rom, code),
          scriptAddress: addr,
          callDepth: depth,
        });
      }

      if (mnemonic === 'CALL') {
        const ptr = callTargetOf(rom, code);
        if (ptr !== 0 && rom.isSafePointer(ptr)) {
          walk(rom.toOffset(ptr), depth + 1);
        }
      }

      decoded++;
      addr += code.bytes.length;

      if (mnemonic === 'IF_CONDITIONAL' || mnemonic === 'IF_CANCEL') lastBranch = addr;

      if (isExitCode(rom, code, lastBranch)) {
        return { decoded, stop: `terminated at ${hex(addr)}` };
      }
    }
    return { decoded, stop: 'step limit' };
  };

  if (chapter.endEventAddr === 0) {
    return {
      mapIndex: chapter.index,
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      endEventAddress: 0,
      instructionsDecoded: 0,
      stopReason: 'no END_EVENT',
      transitions: [],
    };
  }

  const { decoded, stop } = walk(chapter.endEventAddr, 0);
  return {
    mapIndex: chapter.index,
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    endEventAddress: chapter.endEventAddr,
    instructionsDecoded: decoded,
    stopReason: stop,
    transitions: edges,
  };
}

/** Transitions for every chapter, in map-setting order. */
export function readAllTransitions(
  rom: RomBuffer,
  table: EventScriptTable,
  chapters: readonly Chapter[],
): ChapterEdges[] {
  return chapters.map((c) => readChapterTransitions(rom, table, c));
}

/**
 * The destinations a chapter's END_EVENT advances the story to.
 *
 * Two things are dropped. `LOMA` moves a battle around inside one map rather
 * than between chapters. A destination equal to the chapter itself is a
 * self-transition - Dream of Five's map 18 "Crossroads" names itself before the
 * chapter it actually leads to - and treating it as an edge makes the walk
 * believe it closed a loop one chapter in.
 */
export function steppingDestinations(edge: ChapterEdges): number[] {
  return [
    ...new Set(
      edge.transitions
        .filter((t) => t.opcode !== 'LOMA' && t.targetMap !== edge.mapIndex)
        .map((t) => t.targetMap),
    ),
  ];
}

/**
 * The map-id byte a map-setting row carries (`+0x0E`).
 *
 * A real map writes its own slot index here. Unused rows leave it 0, and hack
 * authors who copy a row to duplicate it forget to update it - which is what
 * separates the 14 padded rows in Vision Quest from its 60 real maps.
 */
export function mapIdByteOf(rom: RomBuffer, chapter: Chapter): number {
  return rom.u8(chapter.mapSettingAddr + 0x0e);
}

/** The chapter-route byte (`+0x0C`), mirrored to the runtime `ChapterData+0x1B`. */
export function chapterRouteOf(rom: RomBuffer, chapter: Chapter): number {
  return rom.u8(chapter.mapSettingAddr + 0x0c);
}

/**
 * Whether a map-setting row is a playable map rather than a padded slot.
 *
 * The table has one row per map *id*, so it is longer than the number of real
 * maps. A row is real when it claims its own id in the map-id byte **and**
 * deploys units. Hack authors also register the same battle twice - identical
 * start event, end event and condition table - which this does not merge; see
 * {@link duplicateRegistrations}.
 */
export function isRealMap(rom: RomBuffer, chapter: Chapter): boolean {
  return mapIdByteOf(rom, chapter) === chapter.index && chapter.deploySlots > 0;
}

/**
 * Maps that register one battle more than once.
 *
 * Two rows with the same start event, end event and condition table are the
 * same battle entered twice - Vision Quest registers Castle Frelia under both
 * map 56 and map 63. Keying on the END_EVENT pointer alone is not enough,
 * because the padded rows also share one.
 */
export function duplicateRegistrations(
  rom: RomBuffer,
  chapters: readonly Chapter[],
): number[][] {
  const bySignature = new Map<string, number[]>();
  for (const c of chapters) {
    if (c.startEventAddr === 0 || c.endEventAddr === 0) continue;
    const key = `${c.startEventAddr}:${c.endEventAddr}:${c.condTableAddr}`;
    const list = bySignature.get(key);
    if (list === undefined) bySignature.set(key, [c.index]);
    else list.push(c.index);
  }
  return [...bySignature.values()].filter((v) => v.length > 1);
}

/**
 * Order the chapters into a main path by following the transitions.
 *
 * `chain` follows a branch's **first** destination. Which destination a
 * playthrough actually takes depends on flag conditions inside the branch, not
 * on the opcode, so `branches` reports all of them and
 * {@link buildPlayOrder} is what puts the other ones back in sequence.
 *
 * See {@link walkMainPath} for how the opening chapter is chosen.
 */
export interface StoryPath {
  /** The linear run of chapters, in play order. */
  readonly chain: readonly ChapterEdges[];
  /**
   * Maps with more than one story-advancing destination. Each is where the path
   * splices in a side chapter and comes back, or genuinely forks. The first
   * destination is the one the chain followed; the rest are only reachable on
   * some playthroughs.
   */
  readonly branches: readonly PathBranch[];
  /**
   * Maps the chain reached whose single story-advancing destination it did not
   * follow, because the chain had already visited it - i.e. where the walk
   * closed its loop, not where the story ends. An empty list means the chain ran
   * to a chapter with no advancing transition at all.
   */
  readonly closedLoop: readonly number[];
  /** How the starting map was chosen, for the caller to report. */
  readonly startReason: string;
  /** Every chapter-numbered map that could have started a path. */
  readonly startCandidates: readonly number[];
  /**
   * Every chapter reachable from the start, `chain` and `branches` combined.
   * Larger than `chain.length` whenever a side chapter is spliced in.
   */
  readonly reachable: readonly number[];
  /** True when a start was found and the chain is non-empty. */
  readonly found: boolean;
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
  readonly role: 'main' | 'side';
  /**
   * False for a row the walk passed through that is not a playable map - a row
   * that claims its own slot id but deploys no units, which is how a chain ends
   * rather than where. Vision Quest has one, at the very end.
   */
  readonly playable: boolean;
}

/**
 * The order the chapters are played in, main path and side chapters together.
 *
 * `chain` answers "what is the shortest route through the game"; this answers
 * "what is the sequence of maps a playthrough sees", which is what a question
 * about unit availability actually needs. The two differ by the side chapters:
 * Vision Quest's chain is 41 maps and its order is 49 rows, of which 48 are
 * playable and the last is the row its final transition stops on.
 *
 * ## Why a side chapter goes where it does
 *
 * At a branch the script names the next main chapter and a side chapter, and
 * the side chapter's own END_EVENT leads back into the next main chapter - so
 * the detour is played between the two. The ROM agrees: it numbers gaiden
 * chapters `N.5` (`u16(+0x80) / 2`, so the half steps are real data), and map
 * 36 "Old Habits" is chapter 5.5, i.e. it sits between 5 and 6, which is
 * exactly where the map 16 branch puts it.
 *
 * A side chapter can branch again - Vision Quest's map 63 leads either back to
 * the main path or on to map 60 - so the walk is recursive, not one level deep.
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
 * Order the chapters into the sequence a playthrough sees.
 *
 * The main path is the first-destination walk. Every *other* destination a
 * chapter names is a detour, and a detour is emitted where it hangs off the
 * main path - which is exactly where it gets played, because its own END_EVENT
 * leads back into the chapter after. Destinations already on the main path are
 * not detours: Dream of Five's map 22 names both the next chapter and the one
 * after it, and treating the second as a detour would move a main chapter to
 * the end of the game.
 *
 * Destinations that are not map rows are skipped rather than ending the walk -
 * an END_EVENT also carries `LOMA` and warp targets that name no chapter.
 *
 * Rows that cannot be played are kept in the order but marked `playable: false`
 * rather than dropped, so `steps.filter((s) => s.playable)` is the chapter list
 * while `order` stays a rank every map can be compared on.
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
  const push = (mapIndex: number, role: 'main' | 'side'): void => {
    if (placed.has(mapIndex)) return;
    placed.add(mapIndex);
    steps.push({ order: steps.length + 1, mapIndex, role, playable: isReal(mapIndex) });
  };

  /** A detour and everything behind it, walking until it rejoins the main path. */
  const walkDetour = (root: number): void => {
    if (placed.has(root) || onMainPath.has(root)) return;
    const edge = byMap.get(root);
    if (edge === undefined) return;
    push(root, 'side');
    for (const dest of steppingDestinations(edge)) walkDetour(dest);
  };

  for (const edge of walk.chain) {
    push(edge.mapIndex, 'main');
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
        ? 'no map numbered 1 that no real numbered chapter leads into'
        : 'map-table order among the maps numbered 1 that no real numbered ' +
          `chapter leads into (chose map ${walk.candidates[0].mapIndex})`,
  };
}

/**
 * Every chapter reachable from the start, chain and branches together.
 *
 * `chain` is the path with no detours, so a gaiden chapter spliced into the
 * middle of it is **not** in `chain` - only in `branches`. A caller asking
 * "which chapters does this game have" wants this set; one asking "what order
 * do I play them" wants `buildPlayOrder`.
 */
export function reachableFrom(edges: readonly ChapterEdges[], startMap: number): Set<number> {
  const byMap = new Map(edges.map((e) => [e.mapIndex, e]));
  const seen = new Set<number>();
  const queue = [startMap];
  while (queue.length > 0) {
    const m = queue.pop() as number;
    if (seen.has(m)) continue;
    seen.add(m);
    const e = byMap.get(m);
    if (e === undefined) continue;
    for (const t of e.transitions) {
      // LOMA is an in-chapter teleport; following it would pull in maps the
      // player never transitions to as a chapter.
      if (t.opcode === 'LOMA') continue;
      if (!seen.has(t.targetMap)) queue.push(t.targetMap);
    }
  }
  return seen;
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
 * ## Picking the start
 *
 * The obvious rule - "a map with an outgoing transition and no incoming one" -
 * picks the wrong map on real data. Vision Quest's true opening chapter, map 0
 * "A Forced Hand", *does* have an incoming edge: map 57, an unnumbered map
 * reached only after the ending, redirects to it. Requiring no incoming edge at
 * all therefore fails to find any start.
 *
 * So an incoming edge only counts when it comes from a **real, numbered**
 * chapter. Two things are filtered out:
 *
 *   - **Padded map-table rows.** Their transitions are copies of a real map's,
 *     so treating them as predecessors invents a cycle at the opening chapter.
 *   - **Unnumbered chapters.** `chapterNumber === 0` marks post-battle maps,
 *     bonus maps and skirmish-style maps, which no playthrough walks through to
 *     reach the start.
 *
 * The remaining candidates are the maps the prep screen calls chapter 1. Vision
 * Quest has four (map 0, 12, 18, 21) because its four acts each open at chapter
 * 1; the first in map-table order is the real one, and `startReason` reports the
 * choice so the caller can see it was made rather than proven.
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
    ...new Set(e.transitions.filter((t) => t.opcode === 'LOMA').map((t) => t.targetMap)),
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
    if (next === undefined) break;             // destination is not a map row
    if (seen.has(next.mapIndex)) {
      closedLoop.push(next.mapIndex);          // walked into the chain again
      break;
    }
    cur = next;
  }
  return { chain, branches, closedLoop, candidates };
}

export function traceStoryPath(
  edges: readonly ChapterEdges[],
  isReal: (mapIndex: number) => boolean = () => true,
): StoryPath {
  const walk = walkMainPath(edges, isReal);
  const first = walk.candidates[0];
  return {
    chain: walk.chain,
    branches: walk.branches,
    closedLoop: walk.closedLoop,
    startReason:
      first === undefined
        ? 'no map numbered 1 that no real numbered chapter leads into'
        : 'map-table order among the maps numbered 1 that no real numbered ' +
          `chapter leads into (chose map ${first.mapIndex}; ` +
          `candidates ${walk.candidates.map((c) => c.mapIndex).join(', ')})`,
    startCandidates: walk.candidates.map((c) => c.mapIndex),
    reachable:
      first === undefined
        ? []
        : [...reachableFrom(edges, first.mapIndex)].sort((a, b) => a - b),
    found: walk.chain.length > 0,
  };
}