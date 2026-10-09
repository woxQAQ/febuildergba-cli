/**
 * Item table.
 *
 * One record per item id, `RomInfo.item_datasize` = **36 bytes**, located by
 * dereferencing the `item_pointer` slot. The layout below is not guesswork: the
 * control names in `ItemForm.Designer.cs` carry the byte offset, and the labels
 * next to them carry the field name.
 *
 * | offset | control | label                        | meaning                     |
 * |--------|---------|------------------------------|-----------------------------|
 * | `+0`   | `W0`    | 名前                          | name text id                |
 * | `+2`   | `W2`    | 説明                          | description text id         |
 * | `+4`   | `W4`    | 使用画面                      | "use screen" text id        |
 * | `+6`   | `B6`    | ID                            | item id (self)              |
 * | `+7`   | `B7`    | 種別                          | type (see {@link ITEM_TYPES})|
 * | `+8`   | `B8`    | 特性1                         | ability flags 1             |
 * | `+9`   | `B9`    | 特性2                         | ability flags 2             |
 * | `+10`  | `B10`   | 特性3                         | ability flags 3             |
 * | `+11`  | `B11`   | 特性4                         | ability flags 4             |
 * | `+12`  | `P12`   | 能力補正                      | stat-bonus table pointer    |
 * | `+16`  | `P16`   | 特効                          | effectiveness pointer       |
 * | `+20`  | `B20`   | 耐久                          | uses                        |
 * | `+21`  | `B21`   | 攻撃                          | might                       |
 * | `+22`  | `B22`   | 命中                          | hit                         |
 * | `+23`  | `B23`   | 重さ                          | weight                      |
 * | `+24`  | `B24`   | 必殺                          | crit                        |
 * | `+25`  | `B25`   | 射程                          | range, `(max << 4) \| min`  |
 * | `+26`  | `W26`   | 単価                          | **price per use (u16)**     |
 * | `+28`  | `B28`   | レベル                        | weapon rank (1=E … 251=S)   |
 * | `+29`  | `B29`   | アイコン                      | icon id                     |
 * | `+30`  | `B30`   | —                             | staff/effect id             |
 * | `+31`  | `B31`   | ダメージ追加効果               | damage bonus                |
 * | `+32`  | `B32`   | 武器LV熟練度                   | weapon exp                  |
 *
 * ## `+26` is a unit price, not a price
 *
 * `ItemForm.cs:309` is explicit:
 *
 * ```csharp
 * X_VALUE_SHOP.Value          = B20.Value * W26.Value;           // buy
 * X_VALUE_SHINGEKI_SHOP.Value = (uint)(B20.Value * W26.Value * 1.5); // +50%
 * X_VALUE_SEL.Value           = (B20.Value * W26.Value) / 2;     // sell
 * ```
 *
 * So an Iron Sword is `50 uses x 10 = 500` gold, and it sells for 250. Reading
 * `+26` as "the price" would make every weapon in the game cost 10 gold.
 *
 * The field is a **u16**. Weapons leave the high byte at 0, so reading it as a
 * `u8` gives identical results for them, but gems and money bags would come out
 * wildly wrong: `3,000 Gold` is `B8 0B`, `Diamond Gem` is `20 4E` = 20000.
 *
 * ## `+7` is 0-based
 *
 * Unlike FE6/FE7 this ROM's type field counts swords from **0**. Verified
 * against the table: 0 sword, 1 lance, 2 axe, 3 bow, 4 staff, 5 anima, 6 light,
 * 9 consumable. See {@link ITEM_TYPES}.
 *
 * ## Names are not in the normal text encoding
 *
 * Item names in `dream-of-five.gba` are stored un-compressed in FE8's
 * **item-name font** code space, which is neither ASCII nor Huffman. FEBuilderGBA
 * prints them as `@008F@008C…`; {@link readItemName} decodes them properly via
 * `text/itemFont.ts`.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import type { ItemLayout } from "../data/layouts.ts";
import { resolveTableSlot } from "../data/layouts.ts";
import type { TextContext } from "../text/huffman.ts";
import {
  classifyTextPointer,
  decodeTextId,
  isUnHuffmanPatchPointer,
  convertUnHuffmanPatchToPointer,
  sanitizeText,
  stripAllCodes,
  unHuffmanRawBytes,
} from "../text/huffman.ts";
import { decodeItemFontBytes } from "../text/itemFont.ts";

/**
 * `+7` (`種別`), as this ROM stores it. **0-based**, unlike FE6/FE7.
 *
 * The labels are `ItemForm.Designer.cs:1404` `L_7_COMBO`, which lists the
 * values in **hex**: `0B` = 竜石・魔物専用, `0C` = 指輪, `11` = 火竜石,
 * `12` = 踊る用指輪. So the numbers here are decimal 11/12/17/18, not 0x0B/0x0C.
 */
export const ITEM_TYPES: Readonly<Record<number, string>> = {
  0: "sword", // 剣
  1: "lance", // 槍
  2: "axe", // 斧
  3: "bow", // 弓
  4: "staff", // 杖
  5: "anima", // 理
  6: "light", // 光
  7: "dark", // 闇
  8: "unused8",
  9: "item", // 道具
  10: "unused10",
  11: "monster", // 0x0B 竜石・魔物専用
  12: "ring", // 0x0C 指輪
  17: "firestone", // 0x11 火竜石
  18: "danceRing", // 0x12 踊る用指輪
};

/** Weapon rank field -> letter. Same thresholds the unit weapon levels use. */
export function weaponRankLetter(rank: number): string {
  if (rank <= 0) return "-";
  if (rank <= 30) return "E";
  if (rank <= 70) return "D";
  if (rank <= 120) return "C";
  if (rank <= 180) return "B";
  if (rank <= 250) return "A";
  return "S";
}

export interface Item {
  id: number;
  addr: number;
  /** Decoded name. See the module doc: this is the item-font path. */
  name: string;
  /** Name as the normal text decoder would render it (diagnostic). */
  nameRaw: string;
  nameTextId: number;
  descTextId: number;
  useDescTextId: number;
  /** Storage format of the name string: `huffman` | `unhuffman` | `direct`. */
  nameKind: string;
  /** Codes the item-font table has no mapping for (should stay empty). */
  nameUnknownCodes: number[];
  desc: string;
  type: number;
  typeName: string;
  /** `+8..+11`, four bytes of ability flags. */
  attributes: number[];
  statBonusPointer: number;
  effectivenessPointer: number;
  uses: number;
  might: number;
  hit: number;
  weight: number;
  crit: number;
  rangeMin: number;
  rangeMax: number;
  weaponRank: number;
  weaponRankLetter: string;
  iconId: number;
  staffEffect: number;
  damageBonus: number;
  wexp: number;
  /** `+26`: price **per use**. */
  unitPrice: number;
  /** `uses x unitPrice` — what a shop charges. */
  buyPrice: number;
  /** `buyPrice / 2` — `ItemForm.cs:311`. */
  sellPrice: number;
  /** True when the item is a weapon or staff (type 0..7). */
  isWeapon: boolean;
}

export interface ItemTable {
  slotOffset: number;
  tableOffset: number;
  recordSize: number;
  count: number;
}

export interface ItemReadResult {
  table: ItemTable | null;
  items: Item[];
}

/** Decode an item name, using the item-font alphabet for un-huffman strings. */
function readItemName(
  rom: RomBuffer,
  textId: number,
  text: TextContext,
): { name: string; raw: string; kind: string; unknown: number[] } {
  if (textId === 0) return { name: "", raw: "", kind: "invalid", unknown: [] };

  const entry = text.textBase + textId * 4;
  if (!rom.isSafeOffset(entry)) return { name: "", raw: "", kind: "invalid", unknown: [] };

  const pointer = rom.u32(entry);
  const kind = classifyTextPointer(pointer);

  if (isUnHuffmanPatchPointer(pointer)) {
    const addr = rom.toOffset(convertUnHuffmanPatchToPointer(pointer));
    const bytes = unHuffmanRawBytes(rom, addr);
    const { text: name, unknown } = decodeItemFontBytes(bytes);
    const raw = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return { name: name.trim(), raw, kind, unknown };
  }

  // Huffman path: some items added by a hack keep the compressed form.
  const decoded = decodeTextId(rom, textId, text);
  const name = stripAllCodes(sanitizeText(decoded));
  return { name, raw: decoded, kind, unknown: [] };
}

export function readItems(rom: RomBuffer, layout: ItemLayout, text: TextContext): ItemReadResult {
  const slotOffset = resolveTableSlot(rom, layout.slot);
  const tableOffset = rom.p32(slotOffset);
  if (!rom.isSafeOffset(tableOffset)) return { table: null, items: [] };

  const items: Item[] = [];
  for (let id = 0; id < layout.maxCount; id++) {
    const addr = tableOffset + id * layout.recordSize;
    if (!rom.isSafeOffset(addr + layout.recordSize)) break;

    const nameTextId = rom.u16(addr);
    // Record 0 is the empty slot; the table is a flat array, so a zero name id
    // anywhere else would be unusual - keep reading but do not stop, because
    // hack-injected items can sit at high ids with gaps in between.
    const descTextId = rom.u16(addr + 2);
    const useDescTextId = rom.u16(addr + 4);

    const range = rom.u8(addr + 25);
    const uses = rom.u8(addr + 20);
    // `+26` is a **u16**, not a byte. Plain weapons leave `+27` at 0, so `u8`
    // happens to be right for them, but gems and money bags use the high byte:
    // "3,000 Gold" is `B8 0B` = 3000, Diamond Gem `20 4E` = 20000.
    const unitPrice = rom.u16(addr + 26);
    const rank = rom.u8(addr + 28);
    const type = rom.u8(addr + 7);

    const nm = readItemName(rom, nameTextId, text);
    const desc =
      descTextId === 0 ? "" : stripAllCodes(sanitizeText(decodeTextId(rom, descTextId, text)));

    items.push({
      id,
      addr,
      name: nm.name,
      nameRaw: nm.raw,
      nameTextId,
      descTextId,
      useDescTextId,
      nameKind: nm.kind,
      nameUnknownCodes: nm.unknown,
      desc,
      type,
      typeName: ITEM_TYPES[type] ?? `type${type}`,
      attributes: [rom.u8(addr + 8), rom.u8(addr + 9), rom.u8(addr + 10), rom.u8(addr + 11)],
      statBonusPointer: rom.u32(addr + 12),
      effectivenessPointer: rom.u32(addr + 16),
      uses,
      might: rom.u8(addr + 21),
      hit: rom.u8(addr + 22),
      weight: rom.u8(addr + 23),
      crit: rom.u8(addr + 24),
      rangeMin: range & 0x0f,
      rangeMax: (range >> 4) & 0x0f,
      weaponRank: rank,
      weaponRankLetter: weaponRankLetter(rank),
      iconId: rom.u8(addr + 29),
      staffEffect: rom.u8(addr + 30),
      damageBonus: rom.u8(addr + 31),
      wexp: rom.u8(addr + 32),
      unitPrice,
      buyPrice: uses * unitPrice,
      sellPrice: Math.floor((uses * unitPrice) / 2),
      isWeapon: type <= 7,
    });
  }

  return {
    table: {
      slotOffset,
      tableOffset,
      recordSize: layout.recordSize,
      count: items.length,
    },
    items,
  };
}

/** id -> item, for callers that have an item id from a shop or a unit. */
export function buildItemMap(items: readonly Item[]): Map<number, Item> {
  return new Map(items.map((i) => [i.id, i]));
}

/**
 * The item id the game treats as "gold". `ROMFE8U.cs:374 item_gold_id = 0x77`:
 * giving this item is how events hand the player money, so the money bags
 * (`A bag full of money`, id 0x77 and its variants) are the currency.
 */
export const GOLD_ITEM_ID = 0x77;
