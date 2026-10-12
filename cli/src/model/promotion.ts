export interface PromotionClass {
  id: number;
  promotesToClassId: number;
  sortOrder: number;
}

export interface PromotionGraph<T extends PromotionClass> {
  /** Class ids that are the promoted half of a pair, with a promotion left. */
  readonly promoted: ReadonlySet<number>;
  /** Base class id -> the class it promotes into. Absent when it has none. */
  readonly targets: ReadonlyMap<number, T>;
}

/**
 * Three-tier chains exist (trainee -> base -> promoted) and `+5` names each
 * class's *own* base, so a promoted class whose reverse link points at another
 * promoted class still yields a correct base -> promoted edge.
 */
export function buildPromotionGraph<T extends PromotionClass>(classes: readonly T[]): PromotionGraph<T> {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const promoted = new Set<number>();
  for (const c of classes) {
    const target = byId.get(c.promotesToClassId);
    if (target && target.sortOrder < c.sortOrder) promoted.add(c.id);
  }

  const targets = new Map<number, T>();
  for (const c of classes) {
    if (!promoted.has(c.id)) continue;
    const base = byId.get(c.promotesToClassId);
    if (base !== undefined && base.id !== c.id) targets.set(base.id, c);
  }

  return { promoted, targets };
}
