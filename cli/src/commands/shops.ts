import type { Command } from './types.ts';

/** `shops` — prep-screen shop plus every per-map shop, grouped by chapter. */
export const shops: Command = {
  name: 'shops',
  summary: 'Shops: the prep-screen armoury and every per-map shop',
  description:
    'Every shop the ROM declares, with its price list already resolved against ' +
    'the item table. A game layout without a shop section returns an empty list.',
  run: ({ rom }) => {
    const shopData = rom.shopData;
    if (shopData === null) {
      return { shops: [], notes: ['This game layout has no shop section.'] };
    }

    const rows = shopData.shops;

    return {
      shopCount: rows.length,
      emptyShopPointers: shopData.emptyCount,
      shops: rows.map((s) => ({
        label: s.label,
        kind: s.kind,
        mapIndex: s.mapIndex,
        chapterNumber: s.chapterNumber,
        entries: s.entries.map((e) => ({
          itemId: e.itemId,
          name: e.name,
          uses: e.effectiveUses,
          price: e.price,
        })),
      })),
      limitations: [
        'World-map point shops (`WorldMapPointForm.GetShopAddr`: +12 weapon, ' +
          '+16 item, +20 secret) are not read; `worldmap_point_pointer` is not ' +
          'transcribed for FE8U. In this chapter-based hack the per-map scan ' +
          'finds those lists anyway.',
        'A shop entry\'s second byte is the durability it sells at; 0 means ' +
          'full, and the price is scaled accordingly.',
      ],
    };
  },
};