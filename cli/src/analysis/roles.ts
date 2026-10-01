/**
 * Class role profiles, for team-composition analysis.
 *
 * ## Two sources, in priority order
 *
 * 1. **Ability flags** (class record `+40`..`+43`) - authoritative. The bit
 *    names come from `config/data/unitclass_checkbox_<game>.txt`; see
 *    `tables/classFlags.ts`. This is what distinguishes horse from wyvern from
 *    pegasus from armour, and what identifies dancers / bards / thieves.
 *
 * 2. **Terrain movement costs** (pointer at `+56`) - a fallback for when
 *    `config/data` is unavailable, and a cross-check when it is. See
 *    {@link classifyMobilityByCosts}.
 *
 * An earlier revision of this file claimed the flag names were unavailable and
 * that mounted/armour could not be told apart. That was wrong - the config tree
 * is present in the repository's build output. The flag path is now primary and
 * the cost heuristic is kept only because the two agreeing is real evidence.
 *
 * | Field | Source |
 * |---|---|
 * | `weapons` | class weapon levels (+44..+51), level > 0 |
 * | `hasStaff` | same, staff level > 0 |
 * | `isMagic` | same, anima / light / dark level > 0 |
 * | `mount` | ability flags 13/14/15/27 |
 * | `specialAction` | ability flags 05/06/03/04 |
 * | `mobility` | `mount` when known, else movement costs |
 */

import type { UnitClass } from '../tables/classes.ts';
import { IMPASSABLE_COST } from '../tables/classes.ts';
import type { MountKind } from '../tables/classFlags.ts';
import type { WeaponType } from '../tables/common.ts';
import { WEAPON_TYPES } from '../tables/common.ts';

/**
 * Terrain mobility, normalised across both sources.
 *
 * `'mounted'` and `'armour'` come from the ability flags when the ROM sets
 * them. When it does not - `dream-of-five.gba` leaves `鎧△` (the armour flag)
 * clear on its Armour classes - `'armour'` is inferred from the cost table
 * instead, and {@link ClassRole.mobilitySource} says which happened.
 */
export type Mobility = 'flying' | 'mounted' | 'armour' | 'normal';

/** `Mobility` values in a stable order, for iteration and output. */
export const MOBILITY_KINDS: readonly Mobility[] = ['flying', 'mounted', 'armour', 'normal'];

/** Where a mobility label came from. `'costs'` means it is inferred, not stated. */
export type MobilitySource = 'flags' | 'costs';

export interface ClassRole {
  classId: number;
  className: string;
  mobility: Mobility;
  /** `'flags'` when the ROM stated it, `'costs'` when we inferred it. */
  mobilitySource: MobilitySource;
  /** Mount category from the ability flags; `null` for foot units. */
  mount: MountKind;
  /** Dancer / bard / thief, from the action flags. `null` otherwise. */
  specialAction: 'dancer' | 'bard' | 'thief' | null;
  /** Weapon types this class can use, in ROM order. */
  weapons: WeaponType[];
  /** Can use staves - i.e. can heal and repair. */
  hasStaff: boolean;
  /** Can use anima / light / dark tomes. */
  isMagic: boolean;
  /** Movement range in tiles. */
  movement: number;
  /** Decoded ability-flag ids. Empty when `config/data` was unavailable. */
  flags: string[];
  /**
   * What the terrain-cost heuristic concluded, independent of the flags.
   * `null` when the class has no readable cost table (immobile classes).
   * Disagreement with `mobility` is worth investigating.
   */
  mobilityByCosts: Mobility | null;
}

const STAFF: WeaponType = 'staff';
const MAGIC_TYPES: readonly WeaponType[] = ['anima', 'light', 'dark'];

/** Serialise a cost table so identical tables can be counted. */
function signature(costs: readonly number[]): string {
  return costs.join(',');
}

/**
 * The cost table most classes share - the infantry baseline. Returns `null`
 * when no class has a readable table.
 */
export function findInfantryBaseline(classes: readonly UnitClass[]): number[] | null {
  const counts = new Map<string, { n: number; costs: number[] }>();
  for (const cls of classes) {
    if (cls.isEmpty || cls.movementCosts.length === 0) continue;
    const key = signature(cls.movementCosts);
    const entry = counts.get(key);
    if (entry) entry.n++;
    else counts.set(key, { n: 1, costs: cls.movementCosts });
  }

  let best: { n: number; costs: number[] } | null = null;
  for (const entry of counts.values()) {
    if (best === null || entry.n > best.n) best = entry;
  }
  return best?.costs ?? null;
}

function rank(cost: number): number {
  // Impassable is worse than any positive cost.
  return cost === IMPASSABLE_COST ? Number.POSITIVE_INFINITY : cost;
}

/**
 * Fallback classification from terrain costs alone.
 *
 * Returns `'armour'` for the "never cheaper than infantry, more expensive
 * somewhere" signature. That is the armour / dismounted-knight shape; the
 * caller records that it was inferred rather than stated.
 */
export function classifyMobilityByCosts(
  costs: readonly number[],
  baseline: readonly number[] | null,
): Mobility | null {
  if (costs.length === 0) return null;

  const passable = costs.filter((v) => v !== IMPASSABLE_COST);
  if (passable.length > 0 && new Set(passable).size === 1) return 'flying';
  if (baseline === null || costs.length !== baseline.length) return 'normal';

  let worse = false;
  let better = false;
  for (let i = 0; i < costs.length; i++) {
    const a = rank(costs[i] as number);
    const b = rank(baseline[i] as number);
    if (a > b) worse = true;
    else if (a < b) better = true;
  }

  return worse && !better ? 'armour' : 'normal';
}

/** Map a mount category onto the normalised mobility label. */
function mobilityFromMount(
  mount: MountKind,
  byCosts: Mobility | null,
): { mobility: Mobility; source: MobilitySource } {
  switch (mount) {
    case 'wyvern':
    case 'pegasus':
      return { mobility: 'flying', source: 'flags' };
    case 'horse':
      return { mobility: 'mounted', source: 'flags' };
    case 'armour':
      return { mobility: 'armour', source: 'flags' };
    default:
      // No mount flag. Fall back to the cost table - it still separates fliers
      // from armour, and a hack may simply leave the icon flags unset.
      return { mobility: byCosts ?? 'normal', source: 'costs' };
  }
}

export function deriveClassRole(cls: UnitClass, baseline: readonly number[] | null): ClassRole {
  const weapons = WEAPON_TYPES.filter((t) => cls.weaponLevels[t] > 0);
  const mobilityByCosts = classifyMobilityByCosts(cls.movementCosts, baseline);
  const { mobility, source } = mobilityFromMount(cls.mount, mobilityByCosts);

  return {
    classId: cls.id,
    className: cls.name,
    mobility,
    mobilitySource: source,
    mount: cls.mount,
    specialAction: cls.specialAction,
    weapons: [...weapons],
    hasStaff: cls.weaponLevels[STAFF] > 0,
    isMagic: MAGIC_TYPES.some((t) => cls.weaponLevels[t] > 0),
    movement: cls.movementRange,
    flags: [...cls.abilityFlagIds],
    mobilityByCosts,
  };
}

/** Role profile for every non-empty class, keyed by class id. */
export function deriveClassRoles(classes: readonly UnitClass[]): Map<number, ClassRole> {
  const baseline = findInfantryBaseline(classes);
  const roles = new Map<number, ClassRole>();
  for (const cls of classes) {
    if (cls.isEmpty) continue;
    roles.set(cls.id, deriveClassRole(cls, baseline));
  }
  return roles;
}

/** How many classes got each mobility label - useful as a sanity check. */
export function summariseMobility(roles: ReadonlyMap<number, ClassRole>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of MOBILITY_KINDS) out[kind] = 0;
  for (const role of roles.values()) out[role.mobility] = (out[role.mobility] ?? 0) + 1;
  return out;
}

/**
 * Classes where the flag-derived label and the cost-derived label disagree.
 *
 * A non-empty result is not automatically a bug - hacks set icon flags
 * inconsistently - but it is the cheapest way to catch a mis-parsed `+40`
 * offset, so it is surfaced rather than swallowed.
 *
 * `mounted` legitimately shows as `armour` from the costs (both are "slower
 * than infantry on rough terrain"), so that pair is not reported.
 */
export function mobilityDisagreements(
  roles: ReadonlyMap<number, ClassRole>,
): { classId: number; className: string; fromFlags: Mobility; fromCosts: Mobility }[] {
  const out: { classId: number; className: string; fromFlags: Mobility; fromCosts: Mobility }[] = [];
  for (const role of roles.values()) {
    if (role.mount === null || role.mobilityByCosts === null) continue;
    if (role.mobility === role.mobilityByCosts) continue;

    // Both mounted and armour look like the "restricted" cost signature; the
    // costs cannot separate them, so only the flying / not-flying axis and
    // restricted-vs-normal are meaningful comparisons.
    const coarse = (m: Mobility): string => (m === 'flying' ? 'flying' : m === 'normal' ? 'normal' : 'restricted');
    if (coarse(role.mobility) === coarse(role.mobilityByCosts)) continue;

    out.push({
      classId: role.classId,
      className: role.className,
      fromFlags: role.mobility,
      fromCosts: role.mobilityByCosts,
    });
  }
  return out;
}
