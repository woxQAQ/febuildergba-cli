import { hex } from '../cli/hex.ts';
import type { Command } from './types.ts';

export const objects: Command = {
  name: 'objects',
  summary: 'Map objects: chests (and their loot), villages, doors, shops',
  description:
    'Every map object grouped by chapter. Chests carry the item inside and what ' +
    'it would sell for; a gold chest names item 0x77 (price 0) and carries its ' +
    'value at `+6`, which is why `goldChestTotal` is worth reading separately.',
  run: ({ rom, flags }) => {
    const byKind: Record<string, number> = {};
    for (const o of rom.mapObjects) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;

    const chapterRows = rom.chapterObjects
      .filter((c) => (flags.all ? true : c.objects.length > 0))
      .map((c) => ({
        mapIndex: c.chapterIndex,
        chapterNumber: c.chapterNumber,
        title: c.title,
        objects: c.objects.map((o) => {
          const item = o.itemId === null ? undefined : rom.itemMap.get(o.itemId);
          return {
            kind: o.kind,
            triggerType: hex(o.type),
            objectType: hex(o.objectType),
            objectTypeName: o.objectTypeName,
            /** Achievement flag; 0 means the object can be used more than once. */
            flag: o.flag,
            x: o.x,
            y: o.y,
            address: hex(o.addr),
            /** Chests only: the item inside, and what it would sell for. */
            ...(o.kind === 'chest'
              ? {
                  itemId: o.itemId,
                  itemName: o.isGoldChest ? 'Gold' : (item?.name ?? `item#${o.itemId}`),
                  /** Chests store gold in `+6`, and mark a gold chest with item 0x77. */
                  gold: o.gold,
                  isGoldChest: o.isGoldChest,
                  sellPrice: o.isGoldChest ? 0 : (item?.sellPrice ?? 0),
                }
              : {}),
            /** Villages and houses: the script the object runs. */
            ...(o.eventAddr ? { event: hex(o.eventAddr) } : {}),
            /** Shops: the 2-byte entry list (see the `shops` command). */
            ...(o.shopAddr ? { shopList: hex(o.shopAddr) } : {}),
          };
        }),
      }));

    const goldChests = chapterRows
      .flatMap((c) =>
        c.objects
          .filter((o) => 'isGoldChest' in o && o.isGoldChest)
          .map((o) => ({ ...o, title: c.title, mapIndex: c.mapIndex })),
      )
      .map((o) => ({ mapIndex: o.mapIndex, title: o.title, amount: (o as { gold: number }).gold }));

    return {
      objectCount: rom.mapObjects.length,
      byKind,
      /** Chests that pay gold. FE8 stores the amount at `+6`, not in the item table. */
      goldChestTotal: goldChests.reduce((s, g) => s + g.amount, 0),
      goldChests,
      chapters: chapterRows,
      limitations: [
        'All five object kinds share one 12-byte record. `+4` is overloaded: a ' +
          'shop stores a pointer to its entry list there, a chest stores the item ' +
          'id in the low byte and the gold amount at `+6`, and everything else ' +
          'stores a pointer to its event script.',
        'Chest and village contents are the ROM\'s main source of money and free ' +
          'weapons, and neither is in the item table\'s price column: a gold chest ' +
          'names item 0x77 (Gold, price 0) and carries its value at `+6`.',
        'Most chests in this hack have achievement flag 0, which normally means ' +
          'the object can be triggered repeatedly. That is what the ROM says; it ' +
          'is reported as-is.',
        'Doors are listed but carry no loot.',
      ],
    };
  },
};