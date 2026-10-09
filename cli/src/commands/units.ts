import { promotesForwardTarget } from '../analysis/crossTable.ts';
import { affinityLabel } from './shared.ts';
import type { Command } from './types.ts';

export const units: Command = {
  name: 'units',
  summary: 'Unit table: stats, growth rates, weapon levels, class',
  description:
    'One row per unit. By default only the **roster** is emitted - the units ' +
    'that carry support data, which is the closest thing to a real roster this ' +
    'parse can offer. `--all` emits every slot instead, empty slots and the ' +
    'enemy / generic-template rows a hack keeps in the same table included. ' +
    '`--playable-only` is the explicit spelling of the default.',
  run: ({ rom, flags }) => {
    const supportUnitIds = new Set(rom.supports.entries.map((e) => e.unitId));
    /**
     * Default is the roster, not "every populated slot".
     *
     * A hack's unit table is mostly enemy and generic-template rows. On Vision
     * Quest 193 of the 255 populated slots carry no support data, and those
     * rows were 288 KB - 74% - of this command's output while no consumer read
     * them: `analyze.py` feeds every row in, then reports the count as
     * "playable units". `chapters` has defaulted its `joinOrder` to the roster
     * since it was written; this makes `units` agree with it.
     *
     * `--all` is the escape hatch and keeps the old behaviour.
     */
    const rosterOnly = !flags.all || flags.playableOnly;
    const rows = rosterOnly ? rom.units.filter((u) => supportUnitIds.has(u.id)) : rom.units;

    return rows.map((u) => {
      const role = rom.classRoles.get(u.classId);
      return {
        id: u.id,
        name: u.name,
        className: u.className,
        classId: u.classId,
        /**
         * Already in the promoted half of a base/promoted pair, i.e. no
         * promotion left. Hack rosters skew heavily this way (Vision Quest
         * starts 74% of its playable units promoted), so whether a unit can
         * still promote is a real question rather than a formality.
         */
        isPromotedClass: u.isPromotedClass,
        /**
         * The class this one promotes INTO, or `null` when it is already
         * promoted. `classes[].promotesToClassId` links a pair both ways, so
         * this resolves the direction via `sortOrder`; see `load.ts`.
         */
        promotesTo: (() => {
          const target = promotesForwardTarget(rom.classes, u.classId);
          return target === 0 ? null : (rom.classNames.get(target) ?? `class ${target}`);
        })(),
        level: u.level,
        /** Per-unit deltas, signed - NOT the stats the unit starts with. */
        stats: u.stats,
        /** `class base + stats`: what the unit actually starts with. Compare with this. */
        startingStats: u.startingStats,
        growths: u.growths,
        growthTotal: u.growthTotal,
        weaponLevels: u.weaponLevels,
        affinity: u.attribute === 0 ? null : affinityLabel(rom, u.attribute),
        /**
         * Raw affinity id, kept alongside the name because ids past the
         * reference's seven have no name to show - `"-"` alone would leave the
         * reader unable to tell which of several unnamed affinities this is.
         */
        affinityId: u.attribute === 0 ? null : u.attribute,
        /**
         * Affinity name resolved from the ROM's own text table, or `null` when
         * the unit has no affinity (id 0). Hack-added affinities past the
         * reference's seven have no name; those show `affinity: "-"` above.
         */
        affinityName: u.attribute === 0 ? null : (rom.affinityNames.get(u.attribute) ?? null),
        /**
         * Everything the class can do, from the class's ability flags and
         * weapon levels. `roles` aggregates this over the whole roster;
         * per-unit it is what answers "what is this one actually able to use".
         */
        role: role
          ? {
              mobility: role.mobility,
              weapons: role.weapons,
              hasStaff: role.hasStaff,
              isMagic: role.isMagic,
            }
          : null,
        /** Movement range, copied from the class. */
        movement: rom.classes.find((c) => c.id === u.classId)?.movementRange ?? null,
        /**
         * Earliest chapter this unit is in the player's army, from an initial
         * placement or a `LOAD1` ("仲間にする") instruction. `chapters` reports
         * the same evidence as `joinOrder`; it is repeated here because "when
         * can I use this unit" is a per-unit question.
         */
        availability: (() => {
          const join = rom.joins.joins.get(u.id);
          const appearance = rom.joins.appearances.get(u.id);
          if (!join && !appearance) return null;
          const position = rom.playOrder.position;
          const orderOf = (c: typeof join | undefined): number | null =>
            c === undefined ? null : (position.get(c.chapterIndex) ?? null);
          const chapterOf = (c: typeof join | undefined): Record<string, unknown> | null => {
            if (!c) return null;
            const ch = rom.chapters.find((x) => x.index === c.chapterIndex);
            return ch
              ? {
                  mapIndex: ch.index,
                  /**
                   * 1-based play position, or `null` when the main path never
                   * reaches this map. **Order on this** - see the `chapters`
                   * command; `chapterNumber` restarts at 1 in every act.
                   */
                  storyOrder: c.storyOrder,
                  /** The prep screen's numbering. Display only. */
                  chapterNumber: ch.chapterNumber,
                  title: ch.title,
                  source: c.source,
                  /** The placement put this unit in a different class than its own. */
                  classOverridden: c.classOverridden,
                }
              : null;
          };
          /** Off-path chapters sort last, then by table order. */
          const rank = (c: typeof join | undefined): number =>
            orderOf(c) ?? Number.MAX_SAFE_INTEGER;
          return {
            join: chapterOf(join),
            earliestAppearance: chapterOf(appearance),
            /**
             * The appearance may predate the join when a unit loads as a guest
             * before it can be recruited. Compared by play position, so a load
             * on a side chapter counts as earlier than a recruit later in the
             * main path even though the side chapter has the lower map index.
             */
            mayAppearEarlier:
              appearance !== undefined &&
              join !== undefined &&
              (rank(appearance) < rank(join) ||
                (rank(appearance) === rank(join) &&
                  appearance.chapterIndex < join.chapterIndex)),
          };
        })(),
        /** How many support partners this unit has, or 0 when it has no support data. */
        supportPartnerCount:
          rom.supports.entries.find((e) => e.unitId === u.id)?.partners.length ?? 0,
      };
    });
  },
};