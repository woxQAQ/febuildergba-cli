/**
 * Map objects - the `CONDTYPE.OBJECT` list. Every chest, village, door, seize
 * point and shop is one entry in the same list: **12-byte records** off
 * condition slot 2 of the chapter's event-condition table, terminated by a
 * record whose first `u32` is zero (`EventCondForm.MakePointerListBox`).
 *
 * ```text
 * +0  u16  発生タイプ  5 = 制圧ポイントと民家, 6 = 訪問村, 7 = 宝箱,
 *                      8 = 扉, 0x0A = 店
 * +2  u16  達成フラグ  0 = repeatable, else the event's achievement flag
 * +4  u32  overloaded:
 *            type 0x0A (shop)  -> GBA pointer to the 2-byte shop entry list
 *            type 0x07 (chest) -> item id in the LOW BYTE, gold in +6
 *            otherwise         -> GBA pointer to the object's event script
 * +6  u16  (chest) gold amount
 * +8  u8   x
 * +9  u8   y
 * +10 u8   種類 0x14 chest, 0x16 armory, 0x17 vendor, 0x18 secret shop,
 *               0x10 house, 0x12 door, 0x20 town centre
 * +11 u8   unused
 * ```
 *
 * Chest/village contents are the main source of money and weapons and are
 * **not** in the event scripts: a village points at a script whose `{ITEM}`
 * instructions carry the item, while a chest has no script - the engine reads
 * the item id and gold straight from the record, which is why `ItemForm` gives
 * the gold item (`item_gold_id`) price 0. `EventCondForm.cs`: 「ゴールドが入って
 * いる宝箱を作るには、アイテムを「Gold」にしないといけません。逆に、ゴールド
 * ではなくアイテムが入っている宝箱の場合は、ゴールドの欄は0にしてください。」
 *
 * Reference: `EventCondForm.cs` (FELint CONDTYPE.OBJECT branch), `MakePointerListBox`.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import { hex } from "../format.ts";
import type { GameLayout } from "../data/layouts.ts";
import type { Chapter } from "./chapters.ts";

/** `発生タイプ` (`u16` at `+0`). */
export const OBJECT_TRIGGER_TYPES: Readonly<Record<number, string>> = {
  0x05: "seizeOrHouse", // 制圧ポイントと民家
  0x06: "village", // 訪問村
  0x07: "chest", // 宝箱
  0x08: "door", // 扉
  0x0a: "shop", // 店
};

/** `種類` (`u8` at `+10`), FE8 values. FE7 shifts these down by 2. */
export const OBJECT_TYPE_NAMES: Readonly<Record<number, string>> = {
  0x07: "chestFE7",
  0x10: "house",
  0x12: "door",
  0x14: "chest",
  0x16: "armory",
  0x17: "vendor",
  0x18: "secret",
  0x20: "townCentre",
};

export interface MapObject {
  addr: number;
  /** `u16(+0)` trigger type. */
  type: number;
  kind: string;
  /** `u16(+2)` achievement flag; 0 means the object can be used repeatedly. */
  flag: number;
  /** `u8(+10)` object type. */
  objectType: number;
  objectTypeName: string;
  x: number;
  y: number;
  /** Chest only: item id, `u8(+4)`. */
  itemId: number | null;
  /** Chest only: gold, `u16(+6)`. */
  gold: number;
  /** Chest only: the chest pays gold instead of an item. */
  isGoldChest: boolean;
  /** Non-chest: file offset of the object's event script, or 0. */
  eventAddr: number;
  /** Shop only: file offset of the 2-byte shop entry list, or 0. */
  shopAddr: number;
}

export interface ChapterObjects {
  chapterIndex: number;
  chapterNumber: number;
  title: string;
  objects: MapObject[];
}

/**
 * Read every object record of one chapter. Returns an empty list when the
 * chapter has no condition table.
 */
export function readChapterObjects(
  rom: RomBuffer,
  layout: GameLayout,
  chapter: Chapter,
): MapObject[] {
  const shop = layout.shop;
  const slot = shop?.objectCondSlot ?? 2;
  const recordSize = shop?.objectRecordSize ?? 12;
  const listAddr = chapter.condPointers[slot] ?? 0;
  if (!rom.isSafeOffset(listAddr)) return [];

  const isFe8 = layout.version === "FE8U" || layout.version === "FE8J";
  const out: MapObject[] = [];

  for (let n = 0; n < 0x400; n++) {
    const addr = listAddr + n * recordSize;
    if (!rom.isSafeOffset(addr + recordSize)) break;
    if (rom.u32(addr) === 0) break; // terminator

    const type = rom.u16(addr);
    const flag = rom.u16(addr + 2);
    const payload = rom.u32(addr + 4);
    const objectType = rom.u8(addr + 10);
    const kind = OBJECT_TRIGGER_TYPES[type] ?? `type${hex(type)}`;

    const isChest = type === 0x07;
    const isShop = type === 0x0a;
    const shopAddr = isShop ? rom.p32(addr + 4) : 0;

    // A chest overloads `+4`: the item id lives in its low byte and the gold
    // amount in `+6`. FE7 shifted every object type down by two.
    const chestType = isFe8 ? 0x14 : 0x12;
    const itemId = isChest ? rom.u8(addr + 4) : null;
    const gold = isChest ? rom.u16(addr + 6) : 0;

    out.push({
      addr,
      type,
      kind,
      flag,
      objectType,
      objectTypeName:
        OBJECT_TYPE_NAMES[objectType] ??
        (isChest && objectType === chestType ? "chest" : hex(objectType)),
      x: rom.u8(addr + 8),
      y: rom.u8(addr + 9),
      itemId,
      gold,
      isGoldChest: isChest && itemId !== null && itemId === 0x77 && gold > 0,
      eventAddr: isChest || isShop ? 0 : rom.p32(addr + 4),
      shopAddr: rom.isSafeOffset(shopAddr) ? shopAddr : 0,
    });
  }

  return out;
}

/** Read the object list of every chapter. */
export function readAllObjects(
  rom: RomBuffer,
  layout: GameLayout,
  chapters: readonly Chapter[],
): ChapterObjects[] {
  return chapters.map((chapter) => ({
    chapterIndex: chapter.index,
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    objects: readChapterObjects(rom, layout, chapter),
  }));
}
