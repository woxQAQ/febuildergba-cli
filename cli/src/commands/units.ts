import { hex } from '../cli/hex.ts';
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
        mobility: role?.mobility ?? null,
        hasStaff: role?.hasStaff ?? null,
        supportAddress: u.hasSupportData ? hex(u.supportAddress) : null,
      };
    });
  },
};