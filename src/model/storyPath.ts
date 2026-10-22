import type { TracedInstruction } from "./events.ts";

/** One decoded "this chapter goes to that chapter" edge. */
export interface ChapterTransition {
  readonly opcode: string;
  /** Destination chapter id: a map-setting index. */
  readonly targetMap: number;
  /** Where in the source chapter's END_EVENT the instruction sat. */
  readonly scriptAddress: number;
  /** 0 in the chapter's own END_EVENT, higher when reached through CALLs. */
  readonly callDepth: number;
}

export interface ChapterEdges {
  /** Map-setting row index, not the chapter number. */
  readonly mapIndex: number;
  readonly chapterNumber: number;
  readonly title: string;
  readonly endEventAddress: number;
  readonly instructionsDecoded: number;
  readonly stopReason: string;
  readonly transitions: readonly ChapterTransition[];
}

/** Maximum `CALL` nesting followed. Deeper helpers are shared boilerplate. */
const MAX_CALL_DEPTH = 4;

/** Reduced decoded instruction consumed by the transition walk. */
export interface TransitionStep {
  transition: { opcode: string; targetMap: number; scriptAddress: number } | null;
  call: number | null;
}

/**
 * Depth-first END_EVENT walk. Each script is entered once, at the first
 * encountered depth; CALLed transitions precede the caller's remaining ones.
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

/** Composite sub-event references are followed just like ordinary CALL operands. */
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
 * Story-advancing destinations exclude LOMA (moves a battle within one map)
 * and self-destinations, which do not advance to another chapter.
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

/** One map in play order. */
export interface PlayOrderStep {
  /** 1-based position, no gaps. */
  readonly order: number;
  /** Map-setting row index, not a chapter number. */
  readonly mapIndex: number;
  readonly role: "main" | "side";
  /** Non-playable transition rows remain in the sequence. */
  readonly playable: boolean;
}

/** Main path and recursively spliced side chapters in playthrough order. */
export interface PlayOrder {
  readonly steps: readonly PlayOrderStep[];
  readonly position: ReadonlyMap<number, number>;
  readonly mainPath: readonly number[];
  readonly branches: readonly PathBranch[];
  readonly closedLoop: readonly number[];
  readonly startCandidates: readonly number[];
  readonly startReason: string;
}

/**
 * The first destination defines the main path. Other destinations are detours,
 * emitted at their branch; destinations already on the main path stay there.
 * Non-map destinations are skipped and non-playable rows retain their rank.
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
        ? "no opening map: nothing numbered 1, and no chapter-0 prologue "
          + "leading into one, that no real numbered chapter leads into"
        : "lowest map id among the opening candidates - a chapter numbered 1, "
          + "or a chapter-0 prologue leading into one - that no real numbered "
          + `chapter leads into (chose map ${walk.candidates[0].mapIndex})`,
  };
}

/** Branch point of the main path. */
export interface PathBranch {
  readonly mapIndex: number;
  readonly to: readonly number[];
  readonly viaLoma: readonly number[];
}

interface MainWalk {
  readonly chain: readonly ChapterEdges[];
  readonly branches: readonly PathBranch[];
  readonly closedLoop: readonly number[];
  readonly candidates: readonly ChapterEdges[];
}

/**
 * Incoming edges count only from real, numbered chapters. Padded rows and
 * unnumbered post-battle/bonus/skirmish maps cannot disqualify an opening map.
 * The opening is the lowest map id that no real chapter leads into: a chapter
 * numbered 1 (acts restart their numbering at 1), or a chapter numbered 0 that
 * steps into one (FE8 numbers its prologue 0).
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

  /**
   * Opening candidates. A chapter numbered 1 qualifies on its own. A chapter
   * numbered 0 qualifies only when it steps into a numbered chapter - that is
   * the prologue signature (FE8: map 0 numbered 0, stepping into chapter 1).
   * Chapter 0 otherwise means unnumbered bonus content: Vision Quest's
   * chapter-0 trial maps are all roots too, and any of them seeding the walk
   * would replace the real opening. Among candidates the lowest map id wins,
   * because the map-setting table is ordered by map id and a prologue precedes
   * the chapter it leads into.
   */
  const candidates = edges
    .filter((e) => {
      if (steppingDestinations(e).length === 0) return false;
      if (reachedFromRealChapter.has(e.mapIndex)) return false;
      if (e.chapterNumber === 1) return true;
      return (
        e.chapterNumber === 0
        && steppingDestinations(e).some((d) => byMap.get(d)?.chapterNumber === 1)
      );
    })
    .sort((a, b) => a.mapIndex - b.mapIndex);

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
