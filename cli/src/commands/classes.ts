import { terrainHint } from '../tables/terrainNames.ts';
import type { Command } from './types.ts';

export const classes: Command = {
  name: 'classes',
  summary: 'Class table: bases, caps, movement, promotion targets',
  description:
    'One row per class. `bases` are the class\'s own stat floors; add a unit\'s ' +
    '`stats` delta to get what that unit actually starts with. `impassableTerrains` ' +
    'is resolved to names from the terrain-name table.',
  run: ({ rom, flags }) => {
    const rows = flags.all ? rom.classes : rom.classes.filter((c) => !c.isEmpty);
    const terrainName = new Map(rom.terrainNames.names.map((n) => [n.id, n.name]));
    const isMultibyte = rom.terrainNames.table?.isMultibyte ?? false;
    // Ids 0x00, 0x2C and 0x2E have no name in this ROM, so fall back to hex
    // rather than emitting an empty label. For those, append the reference's own
    // hint if it has one - 0x2E is "fliers may pass", which is the whole reason a
    // ground class lists it as impassable.
    const label = (id: number): string => {
      const name = terrainName.get(id);
      if (name !== undefined && name !== '') return name;
      const hint = terrainHint(id, isMultibyte);
      return `terrain 0x${id.toString(16)}${hint === '' ? '' : ` ${hint}`}`;
    };

    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      movement: c.movementRange,
      promotesToClassId: c.promotesToClassId,
      promotesTo:
        c.promotesToClassId === 0
          ? null
          : (rom.classNames.get(c.promotesToClassId) ?? `class ${c.promotesToClassId}`),
      bases: c.bases,
      caps: c.caps,
      promotionBonuses: c.promotionBonuses,
      weaponLevels: c.weaponLevels,
      /**
       * Terrain this class cannot enter at all (`cost == 0xFF`), named from the
       * terrain-name table - the cost columns and the name ids are the same
       * index space (see `tables/terrainNames.ts`). A flier's list is short.
       */
      impassableTerrains: c.movementCosts
        .map((cost, id) => (cost === 0xff ? label(id) : null))
        .filter((n): n is string => n !== null),
    }));
  },
};