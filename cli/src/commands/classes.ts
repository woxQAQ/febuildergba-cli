import { terrainHint } from '../tables/terrainNames.ts';
import { promotesForwardTarget } from '../analysis/crossTable.ts';
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
      /**
       * The class this one promotes INTO, or `null` when it is already
       * promoted.
       *
       * `promotesToClassId` links a base/promoted pair in **both** directions
       * (`Brawler` stores 3 and `Great Chief` stores 1), so it cannot tell you
       * the direction by itself. `sortOrder` can: within a pair the promoted
       * half has the higher value.
       */
      promotesTo: (() => {
        const target = promotesForwardTarget(rom.classes, c.id);
        return target === 0 ? null : (rom.classNames.get(target) ?? `class ${target}`);
      })(),
      /**
       * Promotion tier; the base and promoted halves of a pair share one value
       * (Brawler=1, Great Chief=2). Together with `promotesToClassId` this is
       * what identifies a promotion pair at all.
       */
      sortOrder: c.sortOrder,
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