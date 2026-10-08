import { hex } from '../cli/hex.ts';
import { promotesForwardTarget } from '../analysis/crossTable.ts';
import { affinityLabel } from './shared.ts';
import type { Command } from './types.ts';

export const units: Command = {
  name: 'units',
  summary: 'Unit table: stats, growth rates, weapon levels, class',
  description:
    'One row per unit slot. By default only populated slots are emitted; ' +
    '`--all` includes the empty ones and `--playable-only` narrows to units ' +
    'that carry support data.',
  run: ({ rom, flags }) => {
    const supportUnitIds = new Set(rom.supports.entries.map((e) => e.unitId));
    let rows = flags.all ? rom.units : rom.units.filter((u) => !u.isEmpty);
    if (flags.playableOnly) rows = rows.filter((u) => supportUnitIds.has(u.id));

    return rows.map((u) => {
      const role = rom.classRoles.get(u.classId);
      return {
        id: u.id,
        name: u.name,
        /**
         * The decoded name with `@XXXX` text escapes left in. Differs from `name`
         * only where the ROM put a glyph code inside the name field.
         */
        nameRaw: u.nameRaw,
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
          const chapterOf = (c: typeof join | undefined): Record<string, unknown> | null => {
            if (!c) return null;
            const ch = rom.chapters.find((x) => x.index === c.chapterIndex);
            return ch
              ? {
                  mapIndex: ch.index,
                  chapterNumber: ch.chapterNumber,
                  title: ch.title,
                  source: c.source,
                  evidenceAddr: hex(c.evidenceAddr),
                  /** The placement put this unit in a different class than its own. */
                  classOverridden: c.classOverridden,
                }
              : null;
          };
          return {
            join: chapterOf(join),
            earliestAppearance: chapterOf(appearance),
            /** The appearance may predate the join when a unit loads as a guest. */
            mayAppearEarlier:
              appearance !== undefined &&
              join !== undefined &&
              appearance.chapterIndex < join.chapterIndex,
          };
        })(),
        /** How many support partners this unit has, or 0 when it has no support data. */
        supportPartnerCount:
          rom.supports.entries.find((e) => e.unitId === u.id)?.partners.length ?? 0,
        supportAddress: u.hasSupportData ? hex(u.supportAddress) : null,
      };
    });
  },
};