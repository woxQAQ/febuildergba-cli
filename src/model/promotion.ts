export interface PromotionClass {
  id: number;
  promotesToClassId: number;
  sortOrder: number;
}

/** One row of the CC branch table; see `tables/classBranch.ts`. */
export interface PromotionBranch {
  classId: number;
  branch1: number;
  branch2: number;
}

export interface PromotionGraph<T extends PromotionClass> {
  /** Class ids that are the promoted half of a pair, with a promotion left. */
  readonly promoted: ReadonlySet<number>;
  /** Base class id -> the class it promotes into. Absent when it has none. */
  readonly targets: ReadonlyMap<number, T>;
  /** Base class id -> every class it promotes into, in branch-table order. */
  readonly targetsAll: ReadonlyMap<number, readonly T[]>;
}

/**
 * The promotion graph, built from **both** sources of truth.
 *
 * `tables/classBranch.ts` states the contract: the class record's `+5` byte is
 * the main-chain target only, the CC branch table is what the menu offers, and
 * "a hack can have `+5` links the menu never shows and branch targets `+5`
 * never mentions - both are stored, neither is derived from the other."
 *
 * Direction is the hard part, and the two sources rank differently:
 *
 *   - The branch table names children directly (`classId -> branch1/branch2`),
 *     so an edge read from it needs no inference. It is the primary source.
 *   - `+5` is **not** directional in practice. On both fixtures it is packed
 *     as pairs that name each other (`Brawler 1.+5 = 3` and `Great Chief
 *     3.+5 = 1`; 39 of 101 links point at a lower-ranked class and 28 at a
 *     higher one), so the field alone does not say which end is the base.
 *     `sortOrder` breaks the tie, which is what the original code relied on -
 *     but a hack may leave `sortOrder` 0 on either side (Vision Quest: 51 of
 *     127 classes), and two zeros can never be ordered.
 *
 * So `+5` contributes an edge only when `sortOrder` can order the pair; a pair
 * the ranking cannot separate is resolved by the branch table instead. Treating
 * an unranked class as "the promoted one" reads a hack's newly added base class
 * (`Bow Scout 82`, `sortOrder` 0, pointing at `Forrest Knight 29`) as its own
 * promotion target.
 *
 * Three-tier chains exist (trainee -> base -> promoted) and `+5` names each
 * class's *own* base, so a promoted class whose link points at another promoted
 * class still yields a correct base -> promoted edge.
 *
 * {@link PromotionGraph.targets} keeps one target per base class for the
 * callers that need a single answer, choosing the lowest class id among the
 * candidates so the pick is stable and does not depend on row order.
 * {@link PromotionGraph.targetsAll} keeps every target, which is what a caller
 * asking "what can this unit become" needs.
 */
export function buildPromotionGraph<T extends PromotionClass>(
  classes: readonly T[],
  branches: readonly PromotionBranch[] = [],
): PromotionGraph<T> {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const promoted = new Set<number>();
  const collected = new Map<number, T[]>();

  const link = (baseId: number, target: T): void => {
    if (baseId === target.id) return;
    promoted.add(target.id);
    const list = collected.get(baseId);
    if (list === undefined) collected.set(baseId, [target]);
    else if (!list.includes(target)) list.push(target);
  };

  /** Base ids the branch table names, so `+5` cannot claim them as a target. */
  const branchBases = new Set(branches.filter((b) => b.branch1 !== 0 || b.branch2 !== 0).map((b) => b.classId));

  // The CC branch table: the class names its own children directly.
  for (const b of branches) {
    for (const childId of [b.branch1, b.branch2]) {
      if (childId === 0) continue;
      const child = byId.get(childId);
      if (child === undefined) continue;
      link(b.classId, child);
    }
  }

  // `+5`, only where the ranking can order the pair *and* the branch table has
  // not already spoken for the base. A class the branch table lists as a base
  // is a base; `+5` naming it is that pair's other half.
  for (const c of classes) {
    const base = byId.get(c.promotesToClassId);
    if (base === undefined) continue;
    if (base.sortOrder === 0 || c.sortOrder === 0) continue;
    if (base.sortOrder >= c.sortOrder) continue;
    if (branchBases.has(c.id)) continue;
    link(base.id, c);
  }

  const targetsAll = new Map<number, readonly T[]>();
  const targets = new Map<number, T>();
  for (const [baseId, list] of collected) {
    const sorted = [...list].sort((a, b) => a.id - b.id);
    targetsAll.set(baseId, sorted);
    targets.set(baseId, sorted[0] as T);
  }

  return { promoted, targets, targetsAll };
}
