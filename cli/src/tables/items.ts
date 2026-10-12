/**
 * Item table: one record per item id, `RomInfo.item_datasize` = **36 bytes**,
 * reached by dereferencing `item_pointer` (`data/layouts.ts`). Offsets come from
 * `ItemForm.Designer.cs` control names, fields from their labels.
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
 * `+26` is a **unit price**, not a price (`ItemForm.cs:309`):
 *     buy  = B20.Value * W26.Value
 *     +50% = (uint)(B20.Value * W26.Value * 1.5)
 *     sell = (B20.Value * W26.Value) / 2
 * Iron Sword = `50 x 10 = 500`, sells 250. It is a **u16**: weapons leave the
 * high byte 0 so a `u8` read looks fine, but `3,000 Gold` is `B8 0B` and
 * `Diamond Gem` `20 4E` = 20000.
 *
 * `+7` (種別) is **0-based** unlike FE6/FE7: 0 sword, 1 lance, 2 axe, 3 bow,
 * 4 staff, 5 anima, 6 light, 9 consumable ({@link ITEM_TYPES}).
 *
 * Item names in `dream-of-five.gba` are un-compressed in FE8's **item-name
 * font** code space (neither ASCII nor Huffman); FEBuilderGBA prints them as
 * `@008F@008C…`. {@link readItemName} decodes via `text/itemFont.ts`.
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import type { ItemLayout, PromotionItemLayout } from "../data/layouts.ts";
import { resolveTableSlot } from "../data/layouts.ts";
import { parseKeyedTable, readTextFile, resolveDataFile } from "../config/data.ts";
import type { TextContext } from "../text/huffman.ts";
import type { TextPointerKind, ItemStatBonuses, Item, ItemReadResult } from "../model/snapshotRecords.ts";
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

/**
 * The use-effect codes the game itself treats as promotions.
 *
 * Verbatim from `ItemForm.IsPromotionItemFE8` (ItemForm.cs:954):
 *
 * ```csharp
 * if (itemEffectID >= 0x19 && itemEffectID <= 0x1D) return true;
 * if (itemEffectID >= 0x2F && itemEffectID <= 0x32) return true;
 * if (itemEffectID == 0x2D) return true;
 * ```
 */
export const PROMOTION_EFFECT_CODES: ReadonlySet<number> = new Set([
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x2d, 0x2f, 0x30, 0x31, 0x32,
]);

/** effect code -> class ids that item promotes. */
export type PromotionTables = ReadonlyMap<number, readonly number[]>;

/** Longest promotion list we will read; the terminator is a 0 byte. */
const PROMOTION_LIMIT = 0x100;

/**
 * Resolve every promotion item's class list.
 *
 * Each {@link PromotionItemLayout} names a slot holding a GBA pointer; the
 * pointed-to data is a `0`-terminated `u8` list of class ids. A slot whose
 * value does not resolve yields no entry, so a missing table degrades to
 * "this effect promotes nobody" rather than to a wrong answer.
 */
export function readPromotionTables(
  rom: RomBuffer,
  promotion: readonly PromotionItemLayout[],
): PromotionTables {
  const out = new Map<number, readonly number[]>();
  for (const entry of promotion) {
    if (!rom.isSafeOffset(entry.slot + 4)) continue;
    const offset = rom.p32(entry.slot);
    if (!rom.isSafeOffset(offset)) continue;
    const classes: number[] = [];
    for (let i = 0; i < PROMOTION_LIMIT && offset + i < rom.length; i++) {
      const classId = rom.u8(offset + i);
      if (classId === 0) break;
      classes.push(classId);
    }
    out.set(entry.effectId, classes);
  }
  return out;
}

/** Decode an item name, using the item-font alphabet for un-huffman strings. */
function readItemName(
  rom: RomBuffer,
  textId: number,
  text: TextContext,
): { name: string; raw: string; kind: TextPointerKind; unknown: number[] } {
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

export function readItems(
  rom: RomBuffer,
  layout: ItemLayout,
  text: TextContext,
  /**
   * `staff_effect` code -> display name, from the `item_staff_use_effect_*`
   * resource. `null` leaves every {@link Item.staffEffectName} empty.
   */
  effectNames: ReadonlyMap<number, string> | null = null,
  /**
   * Promotion class lists by effect code, from {@link readPromotionTables}.
   * `null` leaves every {@link Item.promotionClasses} empty.
   */
  promotions: PromotionTables | null = null,
): ItemReadResult {
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
    const unitPrice = rom.u16(addr + 26);
    const rank = rom.u8(addr + 28);
    const type = rom.u8(addr + 7);
    const staffEffect = rom.u8(addr + 30);

    const nm = readItemName(rom, nameTextId, text);
    const desc =
      descTextId === 0 ? "" : stripAllCodes(sanitizeText(decodeTextId(rom, descTextId, text)));
    const statBonuses = readStatBonuses(rom, rom.u32(addr + 12));
    const effectiveness = readEffectiveness(rom, rom.u32(addr + 16));

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
      statBonuses,
      effectiveness,
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
      staffEffect,
      staffEffectName: effectNames?.get(staffEffect) ?? "",
      isPromotionItem: PROMOTION_EFFECT_CODES.has(staffEffect),
      promotionClasses: promotions?.get(staffEffect) ?? null,
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

/** The nine stat-bonus bytes, or `null` when the pointer does not resolve. */
function readStatBonuses(rom: RomBuffer, pointer: number): ItemStatBonuses | null {
  if (!RomBuffer.isPointer(pointer)) return null;
  const offset = rom.toOffset(pointer);
  if (!rom.isSafeOffset(offset) || offset + 9 > rom.length) return null;
  return {
    hp: rom.u8(offset + 0),
    str: rom.u8(offset + 1),
    skl: rom.u8(offset + 2),
    spd: rom.u8(offset + 3),
    def: rom.u8(offset + 4),
    res: rom.u8(offset + 5),
    lck: rom.u8(offset + 6),
    mov: rom.u8(offset + 7),
    con: rom.u8(offset + 8),
  };
}

/** Longest effectiveness list we will read; the terminator is a 0 byte. */
const EFFECTIVENESS_LIMIT = 0x100;

/** The 0-terminated class-id list at `+16`, or `null` when unusable. */
function readEffectiveness(rom: RomBuffer, pointer: number): number[] | null {
  if (!RomBuffer.isPointer(pointer)) return null;
  const offset = rom.toOffset(pointer);
  if (!rom.isSafeOffset(offset)) return null;
  const out: number[] = [];
  for (let i = 0; i < EFFECTIVENESS_LIMIT && offset + i < rom.length; i++) {
    const classId = rom.u8(offset + i);
    if (classId === 0) break;
    out.push(classId);
  }
  return out;
}

/**
 * The `+30` use-effect code table, from the vendored
 * `item_staff_use_effect_<game>*.txt` resource.
 *
 * `ItemForm` feeds its `L_30_COMBO` from the same file
 * (`InputFormRef.LoadComboResource(L_30_COMBO, g_item_staff_use_effect_List)`),
 * and the keys are hex: `0A` = ワープ, `19` = 英雄の証, `2D` = マスタープルフ.
 * Codes the file does not name stay unnamed rather than becoming "unknown".
 */
export function loadItemEffectNames(
  configDir: string,
  game: string,
  language?: string,
): Map<number, string> {
  const path = resolveDataFile(configDir, "item_staff_use_effect_", game, language);
  const out = new Map<number, string>();
  if (path === null) return out;
  for (const entry of parseKeyedTable(readTextFile(path))) {
    const code = Number.parseInt(entry.key, 16);
    if (Number.isNaN(code)) continue;
    out.set(code, entry.name);
  }
  return out;
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
