import { affinityLabel } from './shared.ts';
import type { Command } from './types.ts';

export const roles: Command = {
  name: 'roles',
  summary: 'Team composition: weapon coverage, mobility, healers, affinities',
  description:
    'What the roster can actually field: which units cover each weapon type, ' +
    'who can heal or cast, and how many of them move at each speed.',
  run: ({ rom, flags }) => {
    // Every non-empty unit slot, independent of any flag. Counting `playable`
    // here made the field mean two different things depending on argv, and its
    // documented value (255 on FE8U) only ever appeared without the flag.
    const populated = rom.units.filter((u) => !u.isEmpty);

    const supportUnitIds = new Set(rom.supports.entries.map((e) => e.unitId));
    const playable = flags.playableOnly
      ? populated.filter((u) => supportUnitIds.has(u.id))
      : populated;

    // Which playable units can use each weapon type.
    const byWeapon = new Map<string, { id: number; name: string; className: string }[]>();
    const affinityCounts = new Map<string, number>();
    const mobilityCounts = new Map<string, number>();
    let withStaff = 0;
    let magicUsers = 0;

    for (const unit of playable) {
      const role = rom.classRoles.get(unit.classId);
      if (unit.attribute !== 0) {
        const name = affinityLabel(rom, unit.attribute);
        affinityCounts.set(name, (affinityCounts.get(name) ?? 0) + 1);
      }
      if (!role) continue;
      if (role.hasStaff) withStaff++;
      if (role.isMagic) magicUsers++;
      mobilityCounts.set(role.mobility, (mobilityCounts.get(role.mobility) ?? 0) + 1);
      for (const weapon of role.weapons) {
        const list = byWeapon.get(weapon) ?? [];
        list.push({ id: unit.id, name: unit.name, className: unit.className });
        byWeapon.set(weapon, list);
      }
    }

    const allRoles = [...rom.classRoles.values()];

    return {
      roster: {
        /**
         * Every populated unit slot - NOT the player roster. Enemies, bosses and
         * generic templates ("Priest", "Outlaw") are in here too. Fixed at 255
         * on an unmodified FE8U; `--playable-only` never changes it.
         */
        populatedUnitSlots: populated.length,
        withSupportData: supportUnitIds.size,
        filteredToPlayableOnly: flags.playableOnly,
        classesInUse: new Set(playable.map((u) => u.classId)).size,
        note: flags.playableOnly
          ? 'populatedUnitSlots counts every non-empty record, including enemies ' +
            'and generic templates; it is not narrowed by --playable-only. Only ' +
            'coverage / healers / magicUsers below are.'
          : 'populatedUnitSlots counts every non-empty record, including enemies ' +
            'and generic templates. Use --playable-only to narrow to units that ' +
            'carry support data.',
      },
      coverage: {
        weaponTypes: Object.fromEntries(
          [...byWeapon.entries()]
            .sort((x, y) => y[1].length - x[1].length)
            .map(([weapon, users]) => [weapon, users]),
        ),
        healers: {
          count: withStaff,
          units: playable
            .filter((u) => rom.classRoles.get(u.classId)?.hasStaff)
            .map((u) => ({ id: u.id, name: u.name, className: u.className })),
        },
        magicUsers: {
          count: magicUsers,
          units: playable
            .filter((u) => rom.classRoles.get(u.classId)?.isMagic)
            .map((u) => ({ id: u.id, name: u.name, className: u.className })),
        },
        mobility: {
          ...Object.fromEntries(mobilityCounts),
          note:
            'Labels come from the class ability flags when the ROM sets them; ' +
            'otherwise they are inferred from the terrain movement-cost table.',
        },
        specialActionClasses: allRoles
          .filter((r) => r.specialAction !== null)
          .map((r) => ({ classId: r.classId, className: r.className, role: r.specialAction })),
      },
      affinities: Object.fromEntries(
        [...affinityCounts.entries()].sort((x, y) => y[1] - x[1]),
      ),
      classRoles: allRoles
        .sort((x, y) => x.classId - y.classId)
        .map((r) => ({
          classId: r.classId,
          className: r.className,
          mobility: r.mobility,
          mount: r.mount,
          specialAction: r.specialAction,
          movement: r.movement,
          weapons: r.weapons,
          hasStaff: r.hasStaff,
          isMagic: r.isMagic,
        })),
    };
  },
};