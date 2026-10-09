/**
 * Per-game ROM pointer layouts, transcribed from FEBuilderGBA's `ROMFEINFO`
 * subclasses.
 *
 * ## The pointer-slot rule
 *
 * Every `*_pointer` value below is the file offset of a **4-byte slot that
 * holds a GBA pointer**, not the table's own offset. Reaching a table always
 * takes one dereference:
 *
 *     tableOffset = rom.p32(slotOffset)
 *
 * Proof in the C# source:
 *   - `PatchForm.cs:9372 ReplacePointerSub()` reads `u32(RomInfo.item_pointer)`
 *     and compares it against a raw GBA pointer.
 *   - `InputFormRef.cs:5792 Init()` does `BaseAddress = p32(BasePointer)`.
 *
 * Fields ending in `_address` are the exception: those are plain offsets and
 * must NOT be dereferenced.
 *
 * ## Fixed vs. searched slots
 *
 * FE7 and FE6 use fixed constants. FE8U/FE8J instead *search* a candidate list,
 * because the unit and class pointer slots moved between FE8 revisions. The
 * search (`U.FindROMPointer`) picks the first candidate that satisfies:
 *   1. the slot is a safe offset,
 *   2. the value there is a safe GBA pointer,
 *   3. `u32(table + checkPointer)` is also a safe GBA pointer.
 *
 * That third test is what makes the search reliable: for the unit table,
 * `checkPointer = 0x2c` (44) lands on the support-data pointer every unit has.
 *
 * Reference: FEBuilderGBA/FEBuilderGBA/ROMFE7U.cs, ROMFE7JP.cs, ROMFE8U.cs, ROMFE8JP.cs,
 *            ROMFE6JP.cs, and `U.FindROMPointer` (U.cs).
 */

import type { GameVersion } from "../rom/detect.ts";
import { RomBuffer } from "../rom/RomBuffer.ts";

export interface FixedSlot {
  kind: "fixed";
  slot: number;
}

export interface SearchSlot {
  kind: "search";
  /** Offset within a record that must itself hold a valid pointer. */
  checkPointer: number;
  candidates: readonly number[];
  /**
   * When set, the probe at `checkPointer` must instead be an integer *below*
   * this value. This mirrors the `Func<uint,bool>` overload of
   * `U.FindROMPointer`, which `map_setting_pointer` uses with the predicate
   * `rom.u32(a + 0x12) < 0xE` (the record's weather id must be a known id).
   *
   * Note the C# lambda literally reads `rom.u32(0x12)` - a constant, not
   * `addr + 0x12`. That looks like a bug upstream; we use the intended
   * `tableOffset + checkPointer` reading, which is what makes the search
   * meaningful at all. When the predicate fails for every candidate the
   * reference falls back to `candidates[0]`, and so do we.
   */
  checkBelow?: number;
  /**
   * When set, the probe at `checkPointer` must equal this value exactly.
   * This is the other `Func<uint,bool>` shape in `U.FindROMPointer`:
   * `item_pointer` is searched with `rom.u32(0xC) == 0x0` (an item record's
   * `+0x0C` is the stat-bonus pointer, null for a plain weapon).
   */
  checkEqual?: number;
}

export type SlotRef = FixedSlot | SearchSlot;

export interface TableLayout {
  slot: SlotRef;
  recordSize: number;
  maxCount: number;
}

export interface TextLayout {
  /** Huffman tree node base. Indirected once. */
  maskPointer: number;
  /** Huffman leaf-data base. Indirected twice. */
  maskPointBasePointer: number;
  /** Points at the text-id -> string-pointer table. Indirected once. */
  textPointer: number;
  /** Plain offset used when `textPointer` has been corrupted by a hack. NOT dereferenced. */
  textRecoverAddress: number;
  /** True for Japanese releases: decoded bytes are Shift-JIS, not Latin-1. */
  isMultibyte: boolean;
}

export interface SupportLayout {
  unitPointer: number;
  talkPointer: number;
  attributePointer: number;
}

/**
 * Item table (`ROMFE8U.cs:83 item_pointer`). 36-byte records; see
 * `tables/items.ts` for the field map.
 */
export interface ItemLayout {
  slot: SlotRef;
  recordSize: number;
  maxCount: number;
}

/**
 * Shops. Three independent sources feed the same 2-byte entry list
 * (`itemId`, `uses`), terminated by `itemId == 0`:
 *
 * 1. the **prep-screen shop** (`item_shop_hensei_pointer`, 「編成準備店」),
 * 2. **per-map shops**, which live in the map's event-condition OBJECT slot
 *    (`CONDTYPE.OBJECT`) as 12-byte records,
 * 3. world-map point shops (`WorldMapPointForm.GetShopAddr`: `+12` weapon,
 *    `+16` item, `+20` secret). FE8-only; not wired up here yet.
 *
 * Reference: `ItemShopForm.MakeShopListLow`, `EventCondForm.MakeShopPointerListBox`,
 *            `ROMFE8JP.get_shop_name` (shop object ids).
 */
export interface ShopLayout {
  /** `item_shop_hensei_pointer`: slot holding the prep-screen shop list. */
  prepShopSlot: number;
  /** Shop object id -> kind, from `get_shop_name`. */
  shopObjects: Readonly<Record<number, string>>;
  /** Condition-table slot index holding the OBJECT list. */
  objectCondSlot: number;
  /** Bytes per OBJECT record. */
  objectRecordSize: number;
  /** Offset inside an OBJECT record of the shop-list pointer. */
  objectShopPointer: number;
  /** Offset inside an OBJECT record of the shop object id. */
  objectKindOffset: number;
  /** Bytes per shop entry. */
  entrySize: number;
}

/**
 * Terrain-name table (`RomInfo.map_terrain_name_pointer`).
 *
 * This is the table `MoveCostForm` uses to label its cost columns `J_0..J_64`,
 * i.e. it is keyed by the **same terrain id** the movement-cost table uses.
 * There are two on-disk shapes and they are not interchangeable:
 *
 *   - **multibyte (JP) releases** — 4 bytes per record, the record *is* a GBA
 *     pointer to a plain (non-Huffman) string. Terminator:
 *     `U.isPointerOrNULL(u32(addr + 0))` is false.
 *     See `MapTerrainNameForm.Init`.
 *   - **non-multibyte (English) releases** — 2 bytes per record holding a
 *     **text id**, decoded through the normal Huffman text table. Terminator:
 *     `u16(addr + 0) == 0`. See `MapTerrainNameEngForm.Init`, which
 *     `MapTerrainNameForm.MakeList/GetName` delegate to when
 *     `RomInfo.is_multibyte` is false.
 *
 * Reference: FEBuilderGBA/FEBuilderGBA/MapTerrainNameForm.cs, MapTerrainNameEngForm.cs,
 *            ROMFE8U.cs:79, ROMFE7U.cs:79, ROMFE8JP.cs:79, ROMFE7JP.cs:79,
 *            ROMFE6JP.cs:90.
 */
export interface TerrainNameLayout {
  /** Slot holding the table pointer. Dereference it before reading records. */
  slot: number;
  /** 4 for multibyte (pointer per record), 2 for non-multibyte (text id). */
  recordSize: number;
  /** Upper bound on records; the table also stops at its terminator. */
  maxCount: number;
}

/**
 * Chapter ("map setting") layout. The chain this describes is:
 *
 *     mapSetting slot -> map-setting table (one record per map id)
 *       record +eventPlistPos (u8) -> index into the event plist table
 *         eventSlot -> event plist table (4-byte pointer entries)
 *           entry -> event-condition table (20 pointers, see condSlots)
 *             slot 10/11 -> player placement block (unitDataSize-byte records)
 *             slot 18/19 -> START_EVENT / END_EVENT script
 *             slots 0..7  -> small condition records, each holding a script ptr
 *
 * Reference: ROMFE8U.cs:50-65, MapSettingForm.cs:261/421, MapPointerForm.cs:413.
 */
export interface MapLayout {
  /** Slot holding the map-setting table pointer. */
  settingSlot: SlotRef;
  settingRecordSize: number;
  settingMaxCount: number;
  /** Byte offset inside a record holding the event-plist index. */
  eventPlistPos: number;
  /** Slot holding the event-plist table pointer (`RomInfo.map_event_pointer`). */
  eventSlot: number;
  /** Vanilla plist count; any index at or above this is out of range. */
  plistLimit: number;
  /** `eventcond_tern_size`: bytes per turn-condition record. */
  turnCondSize: number;
  /** `eventcond_talk_size`: bytes per talk-condition record. */
  talkCondSize: number;
  /** `eventunit_data_size`: bytes per unit-placement record. */
  unitDataSize: number;
}

/**
 * Forced-deployment ("強制出撃") table.
 *
 * This is the list the game consults through `IsCharacterForceDeployed`
 * (`0x080953F0` in FE8U, which tail-calls `IsCharacterForceDeployed_` at
 * `0x08084800`). Disassembling the inner function gives the record layout and
 * the two filters, byte for byte:
 *
 * ```asm
 * ldrh r0, [r2]        ; +0 unit id
 * cmp  r0, 0xFFFF      ; -> end of table
 * ldrb r0, [r2, #2]    ; +2 route filter
 * cmp  r0, #0xFF       ; 0xFF = "any route"
 * ldrb r1, [r3, #0x1b] ; else must equal ChapterData+0x1B (編指定)
 * ldrb r0, [r2, #3]    ; +3 map filter
 * cmp  r0, #0xFF       ; 0xFF = "any map"
 * ldrsb r0, [r3, #0x0e]; else must equal ChapterData+0x0E (current map id)
 * ldrh r0, [r2]        ; then the unit id must match
 * ```
 *
 * The map id is a **map setting index**, which is exactly what
 * `MapSettingForm.GetMapNameAndANYFF` is given in `EventForceSortieForm`.
 *
 * Reference: `ROMFE8U.cs:95 event_force_sortie_pointer = 0x8483C`,
 *            `EventForceSortieForm.cs` (record size 4, terminator `u16 == 0xFFFF`),
 *            `MainFormUtil.cs:2526` ("必ず出撃しなければいけないユニットを設定します。").
 */
export interface ForceSortieLayout {
  /** Slot holding the table pointer. Dereference once before reading records. */
  slot: number;
  recordSize: number;
  /**
   * `'terminator'` - the list ends at the first record whose `u16(+0)` is
   * `0xFFFF` (FE8). `'fixed'` - the table holds exactly `count` records, one per
   * map id starting at `mapIdBase` (FE7, whose editor hardcodes `i < 23`).
   */
  termination: "terminator" | "fixed";
  /** Only for `'fixed'`. */
  count?: number;
  /** Only for `'fixed'`: record `i` applies to map id `mapIdBase + i`. */
  mapIdBase?: number;
}

export interface GameLayout {
  version: GameVersion;
  /** FEBuilderGBA's `VersionToFilename` / `TitleToFilename`. */
  displayName: string;
  /** Whether this CLI can parse the game's data tables yet. */
  supported: boolean;
  unsupportedReason?: string;
  unit: TableLayout;
  unitClass: TableLayout;
  text: TextLayout;
  support: SupportLayout | null;
  terrainNames: TerrainNameLayout;
  map: MapLayout | null;
  /** Forced-deployment table, or `null` when the game has none / it is unknown. */
  forceSortie: ForceSortieLayout | null;
  /** Item table, or `null` when it has not been transcribed for this game. */
  item: ItemLayout | null;
  /** Shop sources, or `null` when unknown for this game. */
  shop: ShopLayout | null;
}

/** FE8U unit/class pointer slots moved between revisions, so they are searched. */
const FE8U: GameLayout = {
  version: "FE8U",
  displayName: "FE8U (The Sacred Stones, North America)",
  supported: true,
  unit: {
    slot: {
      kind: "search",
      checkPointer: 0x2c,
      candidates: [0x10108, 0x104ec, 0x10538, 0xa0b40, 0xa0bb8, 0xbe954],
    },
    recordSize: 52,
    maxCount: 255,
  },
  unitClass: {
    slot: {
      kind: "search",
      checkPointer: 0x88,
      candidates: [0x17ab8, 0x17dbc, 0x18dac, 0x19458],
    },
    recordSize: 84,
    maxCount: 0x100,
  },
  text: {
    maskPointer: 0x6e0,
    maskPointBasePointer: 0x6dc,
    textPointer: 0xa2a0,
    textRecoverAddress: 0x15d48c,
    isMultibyte: false,
  },
  support: {
    unitPointer: 0x803d90,
    talkPointer: 0x084784,
    attributePointer: 0x28534,
  },
  // FE8U is not multibyte, so records are 2-byte text ids (MapTerrainNameEngForm).
  terrainNames: { slot: 0x1a254, recordSize: 2, maxCount: 0x100 },
  map: {
    settingSlot: {
      kind: "search",
      checkPointer: 0x12,
      checkBelow: 0x0e,
      candidates: [0x0b5f98, 0x0b61c0, 0x0b6328, 0x0b6500, 0x03462c, 0xb5e68],
    },
    settingRecordSize: 148,
    settingMaxCount: 0x100,
    eventPlistPos: 116,
    eventSlot: 0x0346dc,
    plistLimit: 0xec,
    turnCondSize: 12,
    talkCondSize: 16,
    unitDataSize: 20,
  },
  forceSortie: { slot: 0x8483c, recordSize: 4, termination: "terminator" },
  item: {
    // `U.FindROMPointer(rom, addr => rom.u32(0xC) == 0, candidates)`.
    // All eight candidates resolve to the same table in this ROM, but the
    // search is kept so other FE8 revisions still work.
    slot: {
      kind: "search",
      checkPointer: 0x0c,
      checkEqual: 0,
      candidates: [0x177c0, 0x16570, 0x166d0, 0x1671c, 0x167e0, 0x16a10, 0x16b18, 0x16bb4],
    },
    recordSize: 36,
    maxCount: 0x100,
  },
  shop: {
    prepShopSlot: 0x99e64,
    // `ROMFE8JP.get_shop_name`.
    shopObjects: { 0x16: "weapon", 0x17: "item", 0x18: "secret" },
    objectCondSlot: 2, // CONDTYPE.OBJECT
    objectRecordSize: 12,
    objectShopPointer: 4,
    objectKindOffset: 10,
    entrySize: 2,
  },
};

const FE8J: GameLayout = {
  version: "FE8J",
  displayName: "FE8J (The Sacred Stones, Japan)",
  supported: false,
  unsupportedReason: "Shift-JIS text decoding is not implemented yet.",
  unit: {
    slot: {
      kind: "search",
      checkPointer: 0x2c,
      candidates: [
        0x010650, 0x010268, 0x1069c, 0xa3b64, 0xa3ce0, 0xa4928, 0xa49a0, 0xa4c3c, 0xa5458, 0xa56a8,
        0xa5860, 0xa595c, 0xa5bb0, 0xa5d28, 0xa61f8,
      ],
    },
    recordSize: 52,
    maxCount: 255,
  },
  unitClass: {
    slot: {
      kind: "search",
      checkPointer: 0x88,
      candidates: [0x017860, 0x17adc, 0x18ac0, 0x19130],
    },
    recordSize: 84,
    maxCount: 0x100,
  },
  text: {
    maskPointer: 0x6e0,
    maskPointBasePointer: 0x6dc,
    textPointer: 0xa000,
    textRecoverAddress: 0x14d08c,
    isMultibyte: true,
  },
  support: {
    unitPointer: 0x8582e8,
    // Both zero until `scripts/check-upstream.ts` caught it: ROMFE8JP.cs sets
    // them, the transcription just never carried them over. Nothing reads them
    // while FE8J is unsupported, which is exactly how it stayed wrong.
    talkPointer: 0x086a50,
    attributePointer: 0x284c8,
  },
  // Multibyte: 4-byte records, each a pointer to a raw Shift-JIS string.
  terrainNames: { slot: 0x19f24, recordSize: 4, maxCount: 0x100 },
  map: {
    settingSlot: {
      kind: "search",
      checkPointer: 0x12,
      checkBelow: 0x0e,
      candidates: [0x0bab1c, 0x34534, 0xba9ec, 0xbad44, 0xbaeac],
    },
    settingRecordSize: 148,
    settingMaxCount: 0x100,
    eventPlistPos: 116,
    eventSlot: 0x0345e4,
    plistLimit: 0xeb,
    turnCondSize: 12,
    talkCondSize: 16,
    unitDataSize: 20,
  },
  forceSortie: { slot: 0x86b08, recordSize: 4, termination: "terminator" },
  item: null,
  shop: null,
};

const FE7U: GameLayout = {
  version: "FE7U",
  displayName: "FE7U (The Blazing Blade, North America)",
  supported: true,
  unit: { slot: { kind: "fixed", slot: 0x9a274 }, recordSize: 52, maxCount: 253 },
  unitClass: { slot: { kind: "fixed", slot: 0x178f0 }, recordSize: 84, maxCount: 0x100 },
  text: {
    maskPointer: 0x6bc,
    maskPointBasePointer: 0x6b8,
    textPointer: 0x12cb8,
    textRecoverAddress: 0xb808ac,
    isMultibyte: false,
  },
  support: {
    unitPointer: 0xbdce78,
    talkPointer: 0x78a94,
    attributePointer: 0x26998,
  },
  terrainNames: { slot: 0x19b1c, recordSize: 2, maxCount: 0x100 },
  map: {
    settingSlot: { kind: "fixed", slot: 0x31580 },
    settingRecordSize: 152,
    settingMaxCount: 0x100,
    eventPlistPos: 120,
    eventSlot: 0x315d4,
    plistLimit: 0xf7,
    turnCondSize: 16,
    talkCondSize: 16,
    unitDataSize: 16,
  },
  // `EventForceSortieFE7Form.Init` hardcodes `i < 23` and labels record `i`
  // with `GetMapName(i + 0x17)`, i.e. the table is a dense array over map ids
  // 0x17..0x2D with no terminator. Not verified against a real FE7 ROM.
  forceSortie: { slot: 0x8ddcc, recordSize: 4, termination: "fixed", count: 23, mapIdBase: 0x17 },
  item: null,
  shop: null,
};

const FE7J: GameLayout = {
  version: "FE7J",
  displayName: "FE7J (The Blazing Blade, Japan)",
  supported: false,
  unsupportedReason: "Shift-JIS text decoding is not implemented yet.",
  unit: { slot: { kind: "fixed", slot: 0x9ac50 }, recordSize: 52, maxCount: 253 },
  unitClass: { slot: { kind: "fixed", slot: 0x17ce0 }, recordSize: 84, maxCount: 0x100 },
  text: {
    maskPointer: 0x6e0,
    maskPointBasePointer: 0x6dc,
    textPointer: 0x13370,
    textRecoverAddress: 0xbbb370,
    isMultibyte: true,
  },
  support: {
    unitPointer: 0xc4c184,
    talkPointer: 0x79264,
    attributePointer: 0x26e24,
  },
  terrainNames: { slot: 0x19efc, recordSize: 4, maxCount: 0x100 },
  map: {
    settingSlot: { kind: "fixed", slot: 0x31a6c },
    settingRecordSize: 148,
    settingMaxCount: 0x100,
    eventPlistPos: 116,
    eventSlot: 0x031b18,
    plistLimit: 0xfc,
    turnCondSize: 16,
    talkCondSize: 16,
    unitDataSize: 16,
  },
  forceSortie: { slot: 0x8e6f8, recordSize: 4, termination: "fixed", count: 23, mapIdBase: 0x17 },
  item: null,
  shop: null,
};

/**
 * FE6 has a genuinely different unit record (48 bytes, different field order)
 * and a 72-byte class record, and it has no support system. The numbers are
 * recorded here for reference but parsing is not wired up.
 */
const FE6J: GameLayout = {
  version: "FE6J",
  displayName: "FE6J (The Binding Blade, Japan)",
  supported: false,
  unsupportedReason:
    "FE6 uses a different unit record (48 bytes) and class record (72 bytes), " +
    "and has no support data. See UnitFE6Form.cs / ClassFE6Form.cs.",
  unit: { slot: { kind: "fixed", slot: 0x17680 }, recordSize: 48, maxCount: 226 },
  unitClass: { slot: { kind: "fixed", slot: 0x176e0 }, recordSize: 72, maxCount: 0x100 },
  text: {
    maskPointer: 0x6e0,
    maskPointBasePointer: 0x6dc,
    textPointer: 0x13b10,
    textRecoverAddress: 0xf635c,
    isMultibyte: true,
  },
  support: null,
  terrainNames: { slot: 0x192c0, recordSize: 4, maxCount: 0x100 },
  map: {
    settingSlot: { kind: "fixed", slot: 0x2bb20 },
    settingRecordSize: 72,
    settingMaxCount: 0x100,
    eventPlistPos: 58,
    eventSlot: 0x02bbcc,
    plistLimit: 0xe5,
    turnCondSize: 12,
    talkCondSize: 12,
    unitDataSize: 16,
  },
  // `ROMFE6JP.cs` sets `event_force_sortie_pointer = 0x0` - FE6 has no table.
  forceSortie: null,
  item: null,
  shop: null,
};

export const LAYOUTS: Readonly<Record<GameVersion, GameLayout>> = {
  FE6J,
  FE7J,
  FE7U,
  FE8J,
  FE8U,
};

export function getLayout(version: GameVersion): GameLayout {
  return LAYOUTS[version];
}

/**
 * Port of `U.FindROMPointer(rom, checkPointer, pointers)` and
 * `U.FindROMPointer(rom, func, pointers)` (U.cs:7667 / 7705).
 *
 * With `checkBelow` unset the predicate is "the probe is a safe pointer"
 * (the 2-argument overload). With `checkBelow` set it is "the probe is a
 * number below that limit" (the `Func<uint,bool>` overload).
 *
 * Both overloads fall back to `FindROMPointer(rom, pointers)`, which returns
 * the first candidate holding *any* safe pointer, and finally to
 * `candidates[0]`. All three steps are reproduced here.
 */
export function resolveTableSlot(rom: RomBuffer, ref: SlotRef): number {
  if (ref.kind === "fixed") {
    return ref.slot;
  }

  for (const slot of ref.candidates) {
    if (slot === 0xffff_ffff) continue;
    if (!rom.isSafeOffset(slot)) continue;

    const target = rom.u32(slot);
    if (!rom.isSafePointer(target)) continue;

    const tableOffset = rom.toOffset(target);
    if (!rom.isSafeOffset(tableOffset + ref.checkPointer + 4)) continue;

    const probe = rom.u32(tableOffset + ref.checkPointer);
    if (ref.checkEqual !== undefined) {
      if (probe !== ref.checkEqual) continue;
    } else if (ref.checkBelow !== undefined) {
      if (probe >= ref.checkBelow) continue;
    } else if (!rom.isSafePointer(probe)) {
      continue;
    }

    return slot;
  }

  // "判別不能なので最初のポインタを使う" - fall back to the first usable slot.
  for (const slot of ref.candidates) {
    if (!rom.isSafeOffset(slot)) continue;
    if (!rom.isSafePointer(rom.u32(slot))) continue;
    return slot;
  }

  throw new Error("Could not resolve table pointer: no candidate slot held a valid pointer.");
}
