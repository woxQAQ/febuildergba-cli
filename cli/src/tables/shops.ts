/**
 * Shops.
 *
 * Every shop in FE8 — prep screen, village, secret — is the same shape: a flat
 * list of **2-byte entries**, `u8 itemId` then `u8 uses`, terminated by
 * `itemId == 0`. `uses == 0` means "sell it at full durability"; a non-zero
 * value is the durability the shop hands you (and, since the price field is a
 * *unit* price, the price scales with it).
 *
 * Two sources are wired up here, which between them cover everything this ROM
 * actually has:
 *
 * 1. **Prep-screen shop** (`item_shop_hensei_pointer`, 「編成準備店」). A single
 *    global list — the armoury you can always reach from the battle-prep menu.
 *
 * 2. **Per-map shops.** These are not in the map setting record; they hang off
 *    the map's event-condition table, in the `CONDTYPE.OBJECT` slot, as a list
 *    of 12-byte records - the *same* records that carry chests, villages and
 *    doors (see `tables/mapObjects.ts` for the full layout):
 *
 *    ```text
 *    +0  u16  trigger type; 0x0A means "shop"
 *    +4  u32  GBA pointer to the shop's 2-byte entry list
 *    +10 u8   shop object id -> weapon / item / secret (ROMFE8JP.get_shop_name)
 *    ```
 *
 *    This is `EventCondForm.MakeShopPointerListBox` (EventCondForm.cs:852).
 *
 * The object records themselves are read once by `readAllObjects`; this module
 * only turns the shop-typed ones into priced entry lists, so chest and shop
 * data cannot drift apart.
 *
 * A third source exists — **world-map point shops**, read from a 32-byte world
 * map point record at `+12` (weapon), `+16` (item), `+20` (secret) by
 * `WorldMapPointForm.GetShopAddr`. It is not wired up: `worldmap_point_pointer`
 * is not transcribed for FE8U and this hack is chapter-based, so the per-map
 * scan already finds those shops (several `@001F` encounter maps carry full
 * weapon/item lists).
 *
 * Reference: `ItemShopForm.MakeShopListLow`, `EventCondForm.MakeShopPointerListBox`,
 *            `ROMFE8JP.get_shop_name`, `WorldMapPointForm.GetShopAddr`.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import type { ShopLayout } from "../data/layouts.ts";
import type { ChapterObjects } from "./mapObjects.ts";
import type { Item } from "./items.ts";

export type ShopKind = "weapon" | "item" | "secret" | "prep";

export interface ShopEntry {
  itemId: number;
  /** Durability the shop sells at; 0 = full. */
  uses: number;
  /** `uses || item.uses` — the durability you actually receive. */
  effectiveUses: number;
  name: string;
  /** `effectiveUses x item.unitPrice`. */
  price: number;
}

export interface Shop {
  kind: ShopKind;
  /** Human label, e.g. `C7A: ... Into the Fire weapon`. */
  label: string;
  /** File offset of the 2-byte entry list. */
  addr: number;
  /** Map-setting index this shop belongs to; `null` for the prep shop. */
  mapIndex: number | null;
  /** Chapter number (`u16(+0x80)/2`), or `null` for the prep shop. */
  chapterNumber: number | null;
  chapterTitle: string | null;
  entries: ShopEntry[];
}

export interface ShopReadResult {
  prepShopAddress: number;
  shops: Shop[];
  /** Addresses that looked like a shop pointer but held no entries. */
  emptyCount: number;
}

function readEntryList(
  rom: RomBuffer,
  addr: number,
  entrySize: number,
  items: Map<number, Item>,
): ShopEntry[] {
  const out: ShopEntry[] = [];
  for (let i = 0; i < 0x200; i++) {
    const a = addr + i * entrySize;
    if (!rom.isSafeOffset(a + entrySize)) break;
    const itemId = rom.u8(a);
    if (itemId === 0) break;

    const uses = entrySize >= 2 ? rom.u8(a + 1) : 0;
    const item = items.get(itemId);
    const effectiveUses = uses !== 0 ? uses : (item?.uses ?? 0);
    out.push({
      itemId,
      uses,
      effectiveUses,
      name: item?.name ?? `item#${itemId}`,
      price: effectiveUses * (item?.unitPrice ?? 0),
    });
  }
  return out;
}

export function readShops(
  rom: RomBuffer,
  layout: ShopLayout,
  chapterObjects: readonly ChapterObjects[],
  items: Map<number, Item>,
): ShopReadResult {
  const shops: Shop[] = [];
  let emptyCount = 0;

  // ---- prep-screen shop -------------------------------------------------
  const prepShopAddress = rom.p32(layout.prepShopSlot);
  if (rom.isSafeOffset(prepShopAddress)) {
    const entries = readEntryList(rom, prepShopAddress, layout.entrySize, items);
    if (entries.length) {
      shops.push({
        kind: "prep",
        label: "Prep screen",
        addr: prepShopAddress,
        mapIndex: null,
        chapterNumber: null,
        chapterTitle: null,
        entries,
      });
    }
  }

  // ---- per-map shops ----------------------------------------------------
  for (const chapter of chapterObjects) {
    for (const object of chapter.objects) {
      if (object.kind !== "shop") continue;
      const kind = layout.shopObjects[object.objectType];
      if (kind === undefined) continue;
      if (object.shopAddr === 0) continue;

      const entries = readEntryList(rom, object.shopAddr, layout.entrySize, items);
      if (!entries.length) {
        emptyCount++;
        continue;
      }

      const title = chapter.title || `map#${chapter.chapterIndex}`;
      shops.push({
        kind: kind as ShopKind,
        label: `${title} ${kind}`,
        addr: object.shopAddr,
        mapIndex: chapter.chapterIndex,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.title || null,
        entries,
      });
    }
  }

  return { prepShopAddress, shops, emptyCount };
}

/** Index shops by the item ids they sell, for "where can I buy X?" queries. */
export function shopIndexByItem(shops: readonly Shop[]): Map<number, Shop[]> {
  const index = new Map<number, Shop[]>();
  for (const shop of shops) {
    for (const entry of shop.entries) {
      const list = index.get(entry.itemId);
      if (list) list.push(shop);
      else index.set(entry.itemId, [shop]);
    }
  }
  return index;
}
