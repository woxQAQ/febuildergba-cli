/**
 * Chapter ("map setting") parsing and join-chapter derivation.
 *
 * ## Why this exists
 *
 * A unit's join chapter is not stored as a number anywhere. It has to be
 * inferred from the chapter's data, and there are exactly two ways a unit can
 * enter the player's army in FE8:
 *
 *   1. **Initial placement.** The map setting record's event plist points at an
 *      event-condition table; slots 10 and 11 of that table hold pointers to
 *      the normal-mode and hard-mode player placement blocks. Every unit in
 *      that block starts the chapter on the field.
 *   2. **Mid-chapter recruitment.** An event script executes
 *      `402C0100 XXXXXXXX 20300000` ("ユニット読込んで配置 自軍ユニットは仲間にする",
 *      `LOAD1`), whose 4-byte `POINTER_UNIT` argument points at a placement
 *      block. Those units are added to the player's army.
 *
 * Finding (2) requires the event-script disassembler, because the script is
 * opaque bytes until you know each opcode's length.
 *
 * ## The chain, step by step
 *
 *     mapSetting slot                 (0x0B5F98 for FE8U, searched)
 *       -> map-setting table          (148-byte records, one per map id)
 *         record + 116 (u8)           = event plist index
 *           -> event plist table      (4-byte pointer entries, `map_event_pointer`)
 *             entry                   = event-condition table
 *               20 pointer slots       (see `config/data/eventcond_<game>.txt`)
 *                 slot 10 / 11        = normal / hard player placement block
 *                 slot 18 / 19        = START_EVENT / END_EVENT script
 *                 slots 0..7          = small condition records, each with a script pointer
 *
 * ## Two deviations from the reference, both deliberate
 *
 * **Record count.** `MapSettingForm.IsMapSettingEnd` (MapSettingForm.cs:64)
 * treats a record as the end of the table as soon as `u32(addr + 0)` looks
 * like a GBA pointer. In vanilla ROMs `+0` holds a small integer, so that test
 * works. In the "Dream of Five" hack every record's `+0` was rewritten to a
 * pointer into a custom map-name table (0x081C32C8, +4 per record), so the
 * reference's own scan reports **zero** maps. We therefore run the reference's
 * test first and, only when it yields nothing while the first record passes
 * the structural checks, fall back to scanning on structure alone
 * (`countSource` records which path was taken).
 *
 * **Class overrides.** A placement record stores `unitId` at `+0` and `classId`
 * at `+1`. Hack authors reuse a single unit id as a generic template and vary
 * the class id - this ROM has 12 records of `unit 2 / class 13` in one chapter,
 * which cannot be twelve copies of the same character. A record therefore
 * counts as *the named character* only when `classId` is 0 (meaning "use the
 * unit's own class") or equals the unit's own class. Records that override the
 * class are still reported, flagged `classOverridden`, because a unit can
 * legitimately join already promoted.
 *
 * ## Chapter identity: the table index is not the chapter number
 *
 * The map-setting table has one 148-byte record per **map id**, not per story
 * chapter. A typical ROM therefore carries, interleaved with the real chapters,
 * a pile of rows that no player will ever see as "chapter N":
 *
 *   - **unused slots** - every field zero, `title` empty, `chapterNumber` 0.
 *     Often a run of them at the end of the table.
 *   - **world-map / skirmish maps** - `title` decodes to the same control-code
 *     glyph (`@001F`), and their `chapterNumber` duplicates the story chapter
 *     they are a variant of.
 *   - **bonus / debug / checkpoint maps** - `Lagdou Ruins`, `Castle Frelia`,
 *     `Act N Checkpoint`, or an author's own TODO note as the title.
 *
 * The authoritative "which chapter is this" field is `+0x80`
 * (`Chapter.chapterNumber`, see its doc comment). Report the index only as an
 * address-like handle, and never render it to a human as "chapter N".
 *
 * Reference: MapSettingForm.cs, MapPointerForm.cs, EventCondForm.cs:1564-1839,
 *            U.ParseUnitGrowLV (U.cs:1734), U.MakeFe8UnitPos (U.cs:1770),
 *            InputFormRef.cs:12097 ("@MAPSETTING_CHAPTOR_ID").
 */

import type { GameLayout, MapLayout } from "../data/layouts.ts";
import { resolveTableSlot } from "../data/layouts.ts";
import { RomBuffer } from "../rom/RomBuffer.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextId } from "../text/huffman.ts";
import type { CondSlot, EventCode, EventScriptTable } from "./eventScript.ts";
import { disassemble, isExitCode } from "./eventScript.ts";

// ---------------------------------------------------------------- condition slots

/** Kinds of entry in the event-condition table, matching `CONDTYPE`. */
export const COND_KINDS = [
  "TURN",
  "TALK",
  "OBJECT",
  "ALWAYS",
  "TUTORIAL",
  "TRAP",
  "PLAYER_UNIT",
  "ENEMY_UNIT",
  "FREEMAP_PLAYER_UNIT",
  "FREEMAP_ENEMY_UNIT",
  "START_EVENT",
  "END_EVENT",
  "UNKNOWN",
] as const;

export type CondKind = (typeof COND_KINDS)[number];

/**
 * A condition slot as described by `config/data/eventcond_<game>.txt`: a flag
 * on the left, a human-readable name on the right. FE8U has 20 of them.
 */
export interface CondSlotInfo extends CondSlot {
  index: number;
  kind: CondKind;
}

function toCondKind(flag: string): CondKind {
  const upper = flag.trim().toUpperCase();
  return (COND_KINDS as readonly string[]).includes(upper) ? (upper as CondKind) : "UNKNOWN";
}

export function describeCondSlots(slots: readonly CondSlot[]): CondSlotInfo[] {
  return slots.map((slot, index) => ({ ...slot, index, kind: toCondKind(slot.flag) }));
}

// ---------------------------------------------------------------- map settings

export interface MapSettingRecord {
  index: number;
  addr: number;
  /** `u16(addr + 4)`: the object (tile-set) plist index. */
  objectPlist: number;
  /** `u8(addr + 6..11)`: palette, config, map, anime1, anime2, mapchange plists. */
  plists: number[];
  /** `u8(addr + eventPlistPos)`: index into the event plist table. */
  eventPlist: number;
  /** `u8(addr + 12)`: weather id; `>= 0xE` means "not a map setting record". */
  weather: number;
}

export interface MapSettingTable {
  /** File offset of the 4-byte slot holding the table pointer. */
  slotOffset: number;
  /** File offset of the table itself. */
  tableOffset: number;
  recordSize: number;
  count: number;
  /** How `count` was determined. See the module doc comment. */
  countSource: "terminator" | "structural";
  records: MapSettingRecord[];
}

/**
 * Port of `MapSettingForm.IsMapSettingEnd` (MapSettingForm.cs:64).
 *
 * `textMax` is `TextForm.GetDataCount()`; pass `Infinity` to skip the four
 * text-id checks (they only ever make the scan stop *earlier*).
 */
export function isMapSettingEnd(
  rom: RomBuffer,
  addr: number,
  layout: MapLayout,
  textMax: number,
): boolean {
  if (rom.isSafePointer(rom.u32(addr + 0))) return true;

  const weather = rom.u8(addr + 12);
  if (weather >= 0x0e) return false;

  // "CPを0にしている人対策" - the plist field may be zeroed.
  let direct = rom.u32(addr + 4);
  if (direct === 0 || direct === 0xffff_ffff) {
    direct = rom.u32(addr + 8);
    if (direct === 0 || direct === 0xffff_ffff) return false;
  }

  for (const offset of [0x70, 0x72, 0x88, 0x8a]) {
    if (rom.u16(addr + offset) >= textMax) return false;
  }
  return true;
}

/**
 * Structural test used only when the reference's terminator test rejects
 * everything. It checks the fields `MapSettingForm.GetMapPListsWhereAddr`
 * actually reads, plus the weather id.
 */
export function looksLikeMapSetting(rom: RomBuffer, addr: number, layout: MapLayout): boolean {
  if (!rom.isSafeOffset(addr + layout.settingRecordSize)) return false;
  if (rom.u8(addr + 12) >= 0x0e) return false;

  const direct = rom.u32(addr + 4);
  if (direct === 0 || direct === 0xffff_ffff) return false;

  for (const offset of [6, 7, 8, 9, 10, 11, layout.eventPlistPos]) {
    if (rom.u8(addr + offset) >= layout.plistLimit) return false;
  }
  return true;
}

export function readMapSettingTable(
  rom: RomBuffer,
  layout: GameLayout,
  textMax = Number.POSITIVE_INFINITY,
): MapSettingTable | null {
  const map = layout.map;
  if (map === null) return null;

  const slotOffset = resolveTableSlot(rom, map.settingSlot);
  const tableOffset = rom.p32(slotOffset);
  if (!rom.isSafeOffset(tableOffset)) return null;

  const recordAt = (index: number): number => tableOffset + index * map.settingRecordSize;

  // Pass 1: the reference's own terminator test.
  let count = 0;
  while (count < map.settingMaxCount) {
    const addr = recordAt(count);
    if (!rom.isSafeOffset(addr + map.settingRecordSize)) break;
    if (isMapSettingEnd(rom, addr, map, textMax)) break;
    count++;
  }

  let countSource: MapSettingTable["countSource"] = "terminator";
  if (count === 0 && looksLikeMapSetting(rom, tableOffset, map)) {
    // This hack rewrote `+0` on every record, so the reference test fires
    // immediately. Scan on structure instead and stop at the first zeroed
    // record (the table is followed by padding).
    countSource = "structural";
    let seenBlank = 0;
    while (count < map.settingMaxCount) {
      const addr = recordAt(count);
      if (!rom.isSafeOffset(addr + map.settingRecordSize)) break;
      if (looksLikeMapSetting(rom, addr, map)) {
        seenBlank = 0;
        count++;
        continue;
      }
      seenBlank++;
      if (seenBlank >= 4) break;
      count++;
    }
    // Trim the trailing blanks we just walked over.
    while (count > 0 && !looksLikeMapSetting(rom, recordAt(count - 1), map)) count--;
  }

  const records: MapSettingRecord[] = [];
  for (let i = 0; i < count; i++) {
    const addr = recordAt(i);
    records.push({
      index: i,
      addr,
      objectPlist: rom.u16(addr + 4),
      plists: [6, 7, 8, 9, 10, 11].map((o) => rom.u8(addr + o)),
      eventPlist: rom.u8(addr + map.eventPlistPos),
      weather: rom.u8(addr + 12),
    });
  }

  return {
    slotOffset,
    tableOffset,
    recordSize: map.settingRecordSize,
    count,
    countSource,
    records,
  };
}

// ---------------------------------------------------------------- unit placement

/**
 * The `+3` byte of a placement record is a bitfield, not a growth rate:
 *
 *     bit  0      autolevel mode  - `L_3_UNITGROW_GROW`  ("成長させない" / "クラス依存")
 *     bits 1-2    allegiance      - `L_3_UNITGROW_ASSIGN` ("自軍" / "友軍" / "敵軍" / "消滅")
 *     bits 3-7    level           - `L_3_UNITGROW_LV`
 *
 * This is the whole reason an enemy is an enemy: FE8 has no enemy placement
 * table, so the only thing separating a red unit from a blue one is these two
 * bits inside a record that is otherwise identical. Reference:
 * `InputFormRef.cs:993-1094` (`linktype == "UNITGROW"`), which reads and writes
 * exactly these masks, and `EventUnitForm.Designer.cs:1255-1313` for the
 * combo-box item lists behind each name.
 */
export function parseUnitGrowLevel(grow: number): number {
  return (grow >> 3) & 0x1f;
}

/** `U.ParseUnitGrowAssign` (U.cs:1730). Returns 0..3, see {@link UNIT_SIDES}. */
export function parseUnitGrowAssign(grow: number): number {
  return (grow >> 1) & 0x3;
}

/** `L_3_UNITGROW_GROW` (bit 0). 0 = no autolevel, 1 = autolevel by class growths. */
export function parseUnitGrowAutolevel(grow: number): number {
  return grow & 0x1;
}

/**
 * Allegiance, indexed by {@link parseUnitGrowAssign}.
 *
 * The names come straight from the combo box `L_3_UNITGROW_ASSIGN`
 * (`EventUnitForm.Designer.cs:1259-1263`): 自軍 / 友軍 / 敵軍 / 消滅.
 *
 * `removed` is not a side: a unit marked 消滅 is deleted when the map loads
 * (it is how a hack removes a unit that would otherwise still be on the
 * roster), and its wait icon renders in the "gray" palette
 * (`ImageUnitWaitIconFrom.cs:173-176`).
 */
export type UnitSide = "player" | "ally" | "enemy" | "removed";

export const UNIT_SIDES: readonly UnitSide[] = ["player", "ally", "enemy", "removed"];

/** `U.ParseUnitGrowAssign` counterpart, for the allegiance field. */
export function unitSideOf(grow: number): UnitSide {
  return UNIT_SIDES[parseUnitGrowAssign(grow)] ?? "player";
}

/** `U.MakeFe8UnitPos` (U.cs:1770) decoded. Only FE8 packs the third field. */
export function decodeUnitPosition(
  packed: number,
  version: GameLayout["version"],
): { x: number; y: number; ext: number | null } {
  if (version === "FE8U" || version === "FE8J") {
    return { x: packed & 0x3f, y: (packed >> 6) & 0x3f, ext: (packed >> 12) & 0x7 };
  }
  return { x: packed & 0xff, y: (packed >> 8) & 0xff, ext: null };
}

export interface PlacedUnit {
  /** Byte offset of this record in the ROM. */
  addr: number;
  /** `+0`. Zero terminates the block and is never emitted. */
  unitId: number;
  /** `+1`. Zero means "use the unit's own class". */
  classId: number;
  /** `+2`. Unit id this unit acts after; 0 for none. */
  commander: number;
  /** Decoded from `+3` via `U.ParseUnitGrowLV`. */
  level: number;
  /**
   * Raw `+3`. This is the reference's `B3` and the only place a placement
   * records its allegiance - see {@link parseUnitGrowLevel}.
   */
  unitGrow: number;
  /** `+3` bits 1-2 (`U.ParseUnitGrowAssign`). */
  assign: number;
  /** `+3` bits 1-2 decoded: player / ally / enemy / removed. */
  side: UnitSide;
  /** `+3` bit 0: 0 = no autolevel, 1 = autolevel by class growths. */
  autolevel: number;
  /** `+4`, the packed pre-placement coordinate. */
  position: number;
  /**
   * Decoded `position`. For FE8 this is the coordinate the unit is *staged* at
   * before the placement script runs; the coordinates it actually ends up on
   * live in the array at `postPlacementAddr` (see `postPlacementCount`).
   */
  prePlacementCoord: { x: number; y: number; ext: number | null };
  /** `+7`: number of post-placement coordinates. */
  postPlacementCount: number;
  /** `+8`: file offset of the post-placement coordinate array (0 when absent). */
  postPlacementAddr: number;
  /** `+12..15`: starting items. */
  items: number[];
}

/**
 * Read a placement block. Records are `layout.map.unitDataSize` bytes and the
 * block ends at the first record whose `+0` byte is zero
 * (`EventUnitForm.Init`, EventUnitForm.cs:147).
 *
 * The same reader serves player, NPC and enemy blocks - that is not a
 * convenience, it is how the game works. See `docs/chapters-and-events.md` §3.19.
 */
export function readPlacements(
  rom: RomBuffer,
  addr: number,
  layout: GameLayout,
  max = 128,
): PlacedUnit[] {
  const map = layout.map;
  const out: PlacedUnit[] = [];
  if (map === null || !rom.isSafeOffset(addr)) return out;

  const size = map.unitDataSize;
  for (let i = 0; i < max; i++) {
    const a = addr + i * size;
    if (!rom.isSafeOffset(a + size)) break;
    if (rom.u8(a) === 0) break;

    // `+3` is a byte, not a u16: `+4` starts the packed position. Reading it as
    // a u16 (which the reference's `InputFormRef.Init` also does) still yields
    // the right level because bits 3-7 live in `+3`, but the raw value would be
    // a blend of two fields, so keep the byte.
    const unitGrow = rom.u8(a + 3);
    const position = rom.u16(a + 4);
    const post = rom.u32(a + 8);
    const items = [12, 13, 14, 15].map((o) => rom.u8(a + o));

    out.push({
      addr: a,
      unitId: rom.u8(a),
      classId: rom.u8(a + 1),
      commander: rom.u8(a + 2),
      unitGrow,
      level: parseUnitGrowLevel(unitGrow),
      assign: parseUnitGrowAssign(unitGrow),
      side: unitSideOf(unitGrow),
      autolevel: parseUnitGrowAutolevel(unitGrow),
      position,
      prePlacementCoord: decodeUnitPosition(position, layout.version),
      postPlacementCount: rom.u8(a + 7),
      postPlacementAddr: rom.isSafePointer(post) ? rom.toOffset(post) : 0,
      items,
    });
  }
  return out;
}

// ---------------------------------------------------------------- chapters

export interface Chapter {
  /**
   * Map setting index, i.e. the row number in the map-setting table.
   *
   * **This is NOT the chapter number.** The table has a row per map id, so it
   * also counts unused slots, world-map/skirmish maps and bonus maps. Use
   * `chapterNumber` when you mean "which chapter is this".
   */
  index: number;
  mapSettingAddr: number;
  /**
   * `u16(addr + 0x80) / 2`: the chapter number the game itself uses.
   *
   * The reference labels this field "Chapter Number" (`J_128`, offset 128 =
   * 0x80, `AccessibleDescription = "@MAPSETTING_CHAPTOR_ID"`), and describes it
   * as (InputFormRef.cs:12097) 「章の番号です。進撃準備画面の右上に表示されます。
   * また、エンディングに表示されるクリアターン数表示にも利用されます。」- the
   * number shown in the prep screen and used for the ending's turn count.
   *
   * It is stored **doubled** so that gaiden chapters can occupy half steps:
   * prologue = 0, `C1` = 2, … `C26` = 52, `Finale` = 54 (= 27), `Postscript` =
   * 55 (= 27.5), `C8x` = 17 (= 8.5). Zero means "no chapter number", which is
   * what every unused slot and every bonus map carries.
   */
  chapterNumber: number;
  /**
   * `u16(addr + 0x80)` before the halving, for callers that want to see the
   * raw field.
   */
  chapterNumberRaw: number;
  /**
   * `u16(addr + 0x70)`: the "map name 1" text id (the reference's `J_112_TEXT`,
   * 「マップ名1」). This is the chapter title shown on the prep screen. The
   * reference's `IsMapSettingEnd` treats it as one of four "is this really a
   * map setting record" probes.
   */
  titleTextId: number;
  /**
   * Decoded chapter title, e.g. `C7A: ... Into the ...`. Empty when no text
   * context was supplied, when the id is 0, or when the id does not decode.
   *
   * **This is what tells a real chapter from a placeholder**: unused slots have
   * id 0 or a blank title, while world-map encounter maps decode to the
   * placeholder glyph `@001F`.
   */
  title: string;
  /** Event plist index from the map setting record. */
  eventPlist: number;
  /** File offset of the event-condition table (0 when unresolved). */
  condTableAddr: number;
  /** The 20 raw pointer values from the condition table. */
  condPointers: number[];
  /** Normal-mode player placement block, or 0. */
  playerPlacementAddr: number;
  /** Hard-mode player placement block, or 0. */
  hardPlacementAddr: number;
  /** START_EVENT script, or 0. */
  startEventAddr: number;
  /** END_EVENT script, or 0. */
  endEventAddr: number;
  /**
   * How many units this map lets you field - the **deployment slot count**.
   *
   * This is `placements.length`, i.e. the number of records in the chapter's
   * player-unit block, and it is the same number the game itself computes:
   * `GetChapterAllyUnitCount` (`0x08012344`) calls `GetChapterAllyUnitDataPointer`
   * (`0x08083348`, which resolves condition slot 10 or 11 - normal vs hard - and
   * returns `p32(slot)`) and then counts records with a 20-byte stride until
   * `u8(+0) == 0`. That is byte-for-byte what {@link readPlacements} does.
   *
   * The block doubles as the slot list: chapters with a prep screen fill the
   * unused slots with a placeholder template (this ROM uses `unit 2 / Thief`,
   * one per distinct coordinate), which is why `placements` can hold twelve
   * records for what looks like one character. Read the count, not the names.
   */
  deploySlots: number;
  /**
   * Deployment slots on hard mode (condition slot 11). Equal to `deploySlots`
   * when slot 11 points at the same block, which is the case for every chapter
   * in this ROM **except `mapIndex 22` (`C10B: Needle's Eye`)**.
   *
   * That chapter's slot 11 is a 9-record block of *green allies*, not a
   * player block, and `GetChapterAllyUnitCount` does not filter on allegiance -
   * it counts records until `u8(+0) == 0` (`0x08012344`). So this field really
   * does come out as 9 there, and the prep screen on hard mode would offer 9
   * slots. The same block is *also* loaded by the chapter's start event
   * (`402C0100` at `0x14c2128`), so the greens get placed either way; the odd
   * part is only the slot count. Verify in-game before trusting it.
   */
  deploySlotsHard: number;
  /** Units on the field at the start of the chapter. */
  placements: PlacedUnit[];
  /** Hard-mode variant of {@link placements}, or `[]` when slot 11 is absent. */
  hardPlacements: PlacedUnit[];
}

export function readChapters(
  rom: RomBuffer,
  layout: GameLayout,
  table: MapSettingTable,
  condSlots: readonly CondSlotInfo[],
  text: TextContext | null = null,
): Chapter[] {
  const map = layout.map;
  if (map === null) return [];

  const plistTable = rom.p32(map.eventSlot);
  const chapters: Chapter[] = [];

  const slotIndexOf = (kind: CondKind): number => condSlots.findIndex((s) => s.kind === kind);

  for (const record of table.records) {
    const titleTextId = rom.u16(record.addr + 0x70);
    const chapterNumberRaw = rom.u16(record.addr + 0x80);
    const chapter: Chapter = {
      index: record.index,
      mapSettingAddr: record.addr,
      chapterNumberRaw,
      chapterNumber: chapterNumberRaw / 2,
      titleTextId,
      title: text === null ? "" : decodeTextId(rom, titleTextId, text),
      eventPlist: record.eventPlist,
      condTableAddr: 0,
      condPointers: [],
      playerPlacementAddr: 0,
      hardPlacementAddr: 0,
      startEventAddr: 0,
      endEventAddr: 0,
      deploySlots: 0,
      deploySlotsHard: 0,
      placements: [],
      hardPlacements: [],
    };

    if (record.eventPlist !== 0 && record.eventPlist < map.plistLimit) {
      const entry = plistTable + record.eventPlist * 4;
      if (rom.isSafeOffset(entry + 4)) {
        const cond = rom.p32(entry);
        if (rom.isSafeOffset(cond)) {
          chapter.condTableAddr = cond;
          for (let i = 0; i < condSlots.length; i++) {
            chapter.condPointers.push(rom.p32(cond + i * 4));
          }

          const at = (kind: CondKind): number => {
            const i = slotIndexOf(kind);
            return i < 0 ? 0 : (chapter.condPointers[i] ?? 0);
          };

          chapter.playerPlacementAddr = at("PLAYER_UNIT");
          // Slot 11 is the second PLAYER_UNIT entry (hard mode).
          const playerSlots = condSlots
            .map((s, i) => (s.kind === "PLAYER_UNIT" ? i : -1))
            .filter((i) => i >= 0);
          if (playerSlots.length > 1) {
            chapter.hardPlacementAddr = chapter.condPointers[playerSlots[1] as number] ?? 0;
          }
          chapter.startEventAddr = at("START_EVENT");
          chapter.endEventAddr = at("END_EVENT");
          chapter.placements = readPlacements(rom, chapter.playerPlacementAddr, layout);
          chapter.hardPlacements = readPlacements(rom, chapter.hardPlacementAddr, layout);
          // The deployment slot count is the size of the player-unit block, the
          // same quantity the game's own `GetChapterAllyUnitCount` returns.
          chapter.deploySlots = chapter.placements.length;
          chapter.deploySlotsHard =
            chapter.hardPlacements.length > 0 ? chapter.hardPlacements.length : chapter.deploySlots;
        }
      }
    }

    chapters.push(chapter);
  }
  return chapters;
}

// ---------------------------------------------------------------- script walking

/**
 * The three "load units" instructions, distinguished by the leading byte:
 *
 *   `402C....`  LOAD1 - "ユニット読込 自軍ユニットは仲間にする" - **recruits** them.
 *   `412C....`  LOAD2 - "ユニット読込"                          - loads an existing member.
 *   `422C....`  LOAD3 - "ユニット読込 自軍ユニットのカットシーン用" - cutscene only.
 *
 * All three carry a `POINTER_UNIT` argument, but so does `40050200...` (増援分岐,
 * a reinforcement branch), whose argument points at an **enemy** block. The
 * reference's `MakeUnitPointerEventScan` collects every `POINTER_UNIT` it sees
 * because it is drawing an icon overlay; we only want army membership, so we
 * classify each argument by the instruction that owns it.
 */
export type LoadKind = "recruit" | "load" | "cutscene" | "other";

/** The subset of `LoadKind` that actually names units to load. */
export type LoadSiteKind = Exclude<LoadKind, "other">;

/**
 * Classify the `POINTER_UNIT` argument at byte position `position` of an
 * opcode pattern. Every pattern in `event_FE8.txt` places the argument
 * immediately after its 2-byte opcode and 2-byte flags, so the opcode byte of
 * the owning instruction sits at `position - 3`.
 */
export function classifyUnitArg(pattern: string, position: number): LoadKind {
  const at = (position - 3) * 2;
  const opcode = Number.parseInt(pattern.slice(at, at + 2), 16);
  if (opcode !== 0x2c) return "other";
  const lead = Number.parseInt(pattern.slice(at - 2, at), 16);
  if (lead === 0x40) return "recruit";
  if (lead === 0x41) return "load";
  if (lead === 0x42) return "cutscene";
  return "other";
}

export interface UnitPointerHit {
  addr: number;
  blockAddr: number;
  instruction: string;
  kind: LoadKind;
}

/**
 * A literal "gain/lose gold" instruction. The event table spells them
 * `40050300XXXX000021370000` ("ゴールド[XXXX]入手") and `...22370000`
 * ("所持金からゴールド[XXXX]を失う"), with the amount as a u16 at `+4`.
 *
 * This is *not* the only way money enters the game - FE8 hands out money bags
 * as ordinary items (see {@link ItemGiveHit}) and gems are sold - but it is the
 * only instruction that writes gold directly.
 */
export interface GoldHit {
  addr: number;
  /** Signed: positive for gain, negative for lose. */
  delta: number;
  /** The literal the instruction matched, for diagnostics. */
  instruction: string;
}

/**
 * An instruction that hands an item to a unit, e.g.
 * `40050300XX0000002037YYYY` ("[YYYY]が[XX]を入手"). The item id is 1 byte.
 *
 * Money bags (`Gold`, `3,000 Gold`, ...) travel this path: FE8's
 * `item_gold_id = 0x77` means the bag is an item whose value is its price
 * field, so the caller can turn these into income.
 */
export interface ItemGiveHit {
  addr: number;
  itemId: number;
  /** `0xFFFF` means "the unit that is currently acting". */
  unitId: number;
  instruction: string;
}

export interface ScriptWalkResult {
  /** Every instruction that carried a `POINTER_UNIT` argument. */
  unitPointers: UnitPointerHit[];
  /** Direct gold writes, in the order the walk met them. */
  gold: GoldHit[];
  /** Item grants, in the order the walk met them. */
  itemsGiven: ItemGiveHit[];
  /** Instructions visited, for diagnostics. */
  visited: number;
  /** Why the walk stopped. */
  stopped: "exit" | "unknowns" | "end-of-rom" | "budget";
}

/** `40050300XXXX000021370000` - "gain gold". */
export const GOLD_GAIN_PATTERN = "40050300XXXX000021370000";
/** `40050300XXXX000022370000` - "lose gold". */
export const GOLD_LOSE_PATTERN = "40050300XXXX000022370000";

/** The 12-byte gold literal, with the amount left as a hole. */
const GOLD_LITERAL_HEAD = [0x40, 0x05, 0x03, 0x00];
const GOLD_OPCODE_GAIN = 0x21;
const GOLD_OPCODE_LOSE = 0x22;

/**
 * Find gold literals anywhere inside one instruction.
 *
 * Matching on the whole `pattern` string is not enough: the ROM also carries
 * 20-byte composite forms such as `400A0000<ptr>40050300XXXX000021370000`
 * ("call a sub-event, then pay out"), where the gold literal sits at offset 8
 * *inside* the instruction. The disassembler returns that composite as one
 * instruction, so the walker never visits the gold literal as its own step -
 * the bytes have to be searched instead.
 *
 * The literal is always 4-byte aligned, so only offsets 0/4/8/... are checked.
 */
export function findGoldLiteralsIn(code: EventCode): { offset: number; delta: number }[] {
  const b = code.bytes;
  const out: { offset: number; delta: number }[] = [];
  for (let off = 0; off + 12 <= b.length; off += 4) {
    if (b[off] !== GOLD_LITERAL_HEAD[0]) continue;
    if (b[off + 1] !== GOLD_LITERAL_HEAD[1]) continue;
    if (b[off + 2] !== GOLD_LITERAL_HEAD[2]) continue;
    if (b[off + 3] !== GOLD_LITERAL_HEAD[3]) continue;
    if (b[off + 6] !== 0 || b[off + 7] !== 0) continue;
    if (b[off + 9] !== 0x37 || b[off + 10] !== 0 || b[off + 11] !== 0) continue;
    const op = b[off + 8];
    if (op !== GOLD_OPCODE_GAIN && op !== GOLD_OPCODE_LOSE) continue;
    const amount = b.readUInt16LE(off + 4);
    out.push({ offset: off, delta: op === GOLD_OPCODE_GAIN ? amount : -amount });
  }
  return out;
}

/**
 * Port of `EventCondForm.MakeUnitPointerEventScan` (EventCondForm.cs:1743).
 *
 * Walks one event script, following `POINTER_EVENT` jumps and collecting
 * `POINTER_UNIT` targets. Stops on an exit code, or after more than ten
 * consecutive unrecognised instructions (the reference's own bail-out).
 *
 * `options.innerFailure` matters more than it looks. The reference aborts the
 * *caller* as soon as a sub-event ends in anything other than an exit code
 * (`if (inner !== 'exit') return inner`), which is fine when the only goal is
 * to draw icons for the unit pointers found so far. In this hack almost every
 * sub-event ends in the unknown-opcode bail-out, so the faithful mode stops a
 * script at its first `400A0000` call - which hides everything after it.
 * `'continue'` keeps walking the caller, and is what the economy pass needs.
 */
export interface WalkOptions {
  /** `'abort'` (default, reference-faithful) or `'continue'`. */
  innerFailure?: "abort" | "continue";
}

export function walkScript(
  rom: RomBuffer,
  scripts: EventScriptTable,
  startAddr: number,
  budget = 20_000,
  options: WalkOptions = {},
): ScriptWalkResult {
  const abortOnInnerFailure = (options.innerFailure ?? "abort") === "abort";
  const unitPointers: UnitPointerHit[] = [];
  const gold: GoldHit[] = [];
  const itemsGiven: ItemGiveHit[] = [];
  const visited = new Set<number>();
  let instructions = 0;

  const walk = (from: number): ScriptWalkResult["stopped"] => {
    let addr = from;
    let lastBranchAddr = 0;
    let unknownCount = 0;

    while (true) {
      if (instructions++ > budget) return "budget";
      if (!rom.isSafeOffset(addr)) return "end-of-rom";

      const code = disassemble(rom, addr, scripts);

      if (isExitCode(rom, code, lastBranchAddr)) return "exit";

      // Gold writes and item grants are collected before the UNKNOWN check,
      // because neither depends on the opcode table knowing the instruction.
      for (const hit of findGoldLiteralsIn(code)) {
        gold.push({ addr: addr + hit.offset, delta: hit.delta, instruction: code.script.pattern });
      }

      // Item grants: only the `{ITEM}`-category instructions hand an item over.
      // An `ITEM`-typed argument also appears in battle instructions ("which
      // weapon is used") and forced class changes ("item id, display only"), so
      // the category token is what separates a grant from those.
      if (code.script.category.includes("{ITEM}")) {
        for (const arg of code.script.args) {
          if (arg.type !== "ITEM") continue;
          const itemId = readArg(rom, code.addr, arg.position, arg.size);
          // `0xFFFF` in the unit slot means "the visiting/acting unit"; keep it.
          const unitArg = code.script.args.find((a) => a.type === "UNIT");
          const unitId = unitArg ? readArg(rom, code.addr, unitArg.position, unitArg.size) : 0;
          itemsGiven.push({ addr, itemId, unitId, instruction: code.script.pattern });
        }
      }

      if (code.script.has === "UNKNOWN") {
        unknownCount++;
        if (unknownCount > 10) return "unknowns";
      } else {
        unknownCount = 0;

        if (code.script.has === "IF_CONDITIONAL") {
          lastBranchAddr = addr;
        } else if (code.script.has === "LABEL_CONDITIONAL") {
          lastBranchAddr = 0;
        } else if (code.script.has === "POINTER_UNIT_OR_EVENT") {
          for (const arg of code.script.args) {
            if (arg.type === "POINTER_EVENT") {
              const raw = readArg(rom, code.addr, arg.position, arg.size);
              const target = rom.toOffset(raw);
              if (rom.isSafeOffset(target) && !visited.has(target)) {
                visited.add(target);
                const inner = walk(target);
                if (inner !== "exit" && abortOnInnerFailure) return inner;
              }
            } else if (arg.type === "POINTER_UNIT") {
              const raw = readArg(rom, code.addr, arg.position, arg.size);
              if (!rom.isSafePointer(raw)) continue;
              const target = rom.toOffset(raw);
              if (target === 0xff_ffff) continue; // INVALIDATE_UNIT_POINTER
              if (!rom.isSafeOffset(target)) continue;
              if (unitPointers.some((u) => u.addr === addr && u.blockAddr === target)) {
                continue;
              }
              unitPointers.push({
                addr,
                blockAddr: target,
                instruction: code.script.pattern,
                kind: classifyUnitArg(code.script.pattern, arg.position),
              });
            }
          }
        }
      }

      addr += code.script.size;
    }
  };

  const stopped = walk(startAddr);
  return { unitPointers, gold, itemsGiven, visited: instructions, stopped };
}

function readArg(rom: RomBuffer, base: number, position: number, size: number): number {
  const at = base + position;
  if (size === 1) return rom.u8(at);
  if (size === 2) return rom.u16(at);
  if (size === 4) return rom.u32(at);
  return 0;
}

// ---------------------------------------------------------------- placement scan

/** The condition slots whose payload is a table of 12-byte script records. */
const SLOT_TABLE_KINDS: readonly CondKind[] = ["TURN", "TALK", "OBJECT", "ALWAYS", "TUTORIAL"];

/**
 * One placement block the chapter's scripts point at, with its records read out.
 */
export interface PlacementSite {
  /** Condition slot the walk started from. */
  slotIndex: number;
  slotKind: CondKind;
  /** The instruction that carries the `POINTER_UNIT` argument. */
  addr: number;
  /** That instruction's opcode pattern, e.g. `40050200XXXXXXXX400A0000...`. */
  instruction: string;
  /**
   * `recruit` / `load` / `cutscene` for `402C` / `412C` / `422C`; **`other`**
   * for the reinforcement forms (`40050200...`), which is where most of a
   * chapter's enemies come from.
   */
  kind: LoadKind;
  /** File offset of the placement block. */
  blockAddr: number;
  units: PlacedUnit[];
}

/**
 * Every placement block reachable from one chapter's scripts.
 *
 * This is {@link scanChapter}'s walk **without** its `kind !== 'other'` filter,
 * so it also returns the reinforcement blocks - which is where the bulk of a
 * chapter's enemies live. Slot handling is the reference's
 * (`EventCondForm.MakeUnitPointer`, EventCondForm.cs:1577): TURN / TALK /
 * OBJECT / ALWAYS / TUTORIAL walk a table of 12-byte records each holding a
 * script pointer at `+4` and terminated by a zero byte; START_EVENT / END_EVENT
 * point straight at a script. The remaining slots (PLAYER_UNIT, FREEMAP_*,
 * TRAP) hold no script and are not walked.
 *
 * Blocks are deduplicated **within the chapter** - the same block can
 * legitimately be loaded by more than one slot. Callers that want a whole-ROM
 * census must dedupe across chapters themselves, because a block shared by two
 * chapters is genuinely present in both.
 */
export function collectPlacementSites(
  rom: RomBuffer,
  scripts: EventScriptTable,
  layout: GameLayout,
  chapter: Chapter,
  condSlots: readonly CondSlotInfo[],
): PlacementSite[] {
  const out: PlacementSite[] = [];
  if (layout.map === null || chapter.condTableAddr === 0) return out;
  const seen = new Set<string>();

  for (const slot of condSlots) {
    const p = chapter.condPointers[slot.index] ?? 0;
    if (p === 0) continue;

    const starts: number[] = [];
    if (SLOT_TABLE_KINDS.includes(slot.kind)) {
      for (let a = p, n = 0; n < 64; n++, a += 12) {
        if (!rom.isSafeOffset(a + 12)) break;
        if (rom.u8(a) === 0) break;
        const ev = rom.p32(a + 4);
        if (rom.isSafeOffset(ev)) starts.push(ev);
      }
    } else if (slot.kind === "START_EVENT" || slot.kind === "END_EVENT") {
      starts.push(p);
    }

    for (const s of starts) {
      const result = walkScript(rom, scripts, s, 20_000, { innerFailure: "continue" });
      for (const hit of result.unitPointers) {
        const key = `${hit.addr}:${hit.blockAddr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          slotIndex: slot.index,
          slotKind: slot.kind,
          addr: hit.addr,
          instruction: hit.instruction,
          kind: hit.kind,
          blockAddr: hit.blockAddr,
          units: readPlacements(rom, hit.blockAddr, layout),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- recruit scan

export interface RecruitSite {
  /** Address of the `LOAD*` instruction. */
  addr: number;
  /** Condition slot the walk started from, or -1 for a direct placement block. */
  slotIndex: number;
  slotKind: CondKind;
  /** The opcode pattern, e.g. `402C0100XXXXXXXX20300000`. */
  instruction: string;
  /** Which load instruction this is. `other` is filtered before this point. */
  kind: LoadSiteKind;
  /** File offset of the placement block the instruction points at. */
  blockAddr: number;
  /** Units named in that block. */
  units: PlacedUnit[];
}

export interface ChapterScan {
  chapterIndex: number;
  recruits: RecruitSite[];
  /** Direct gold writes reachable from this chapter's scripts. */
  gold: GoldHit[];
  /** Item grants reachable from this chapter's scripts. */
  itemsGiven: ItemGiveHit[];
  /** Script walks that hit the unknown-instruction bail-out. */
  truncatedWalks: number;
}

/**
 * Scan every condition slot of a chapter that carries an event script.
 *
 * Slot handling mirrors `EventCondForm.MakeUnitPointer` (EventCondForm.cs:1577):
 * TURN/TALK/OBJECT/ALWAYS walk a table of small records, each holding a script
 * pointer at `+4`; TUTORIAL walks a plain pointer array; START_EVENT and
 * END_EVENT point straight at a script. TRAP slots are not scanned by the
 * reference and are not scanned here.
 */
export function scanChapter(
  rom: RomBuffer,
  scripts: EventScriptTable,
  layout: GameLayout,
  chapter: Chapter,
  condSlots: readonly CondSlotInfo[],
): ChapterScan {
  const map = layout.map;
  const recruits: RecruitSite[] = [];
  const gold: GoldHit[] = [];
  const itemsGiven: ItemGiveHit[] = [];
  let truncatedWalks = 0;
  if (map === null || chapter.condTableAddr === 0) {
    return { chapterIndex: chapter.index, recruits, gold, itemsGiven, truncatedWalks };
  }

  const push = (slotIndex: number, slotKind: CondKind, result: ScriptWalkResult): void => {
    if (result.stopped === "unknowns") truncatedWalks++;
    for (const hit of result.unitPointers) {
      if (hit.kind === "other") continue; // reinforcement branch, not a load
      if (recruits.some((r) => r.addr === hit.addr && r.blockAddr === hit.blockAddr)) continue;
      recruits.push({
        addr: hit.addr,
        slotIndex,
        slotKind,
        instruction: hit.instruction,
        kind: hit.kind,
        blockAddr: hit.blockAddr,
        units: readPlacements(rom, hit.blockAddr, layout),
      });
    }
  };

  const isFe7 = layout.version === "FE7U" || layout.version === "FE7J";

  /**
   * Walk one script twice.
   *
   * Pass 1 is the reference-faithful walk and feeds the recruit scan - its
   * results are what the existing join-order output is built on, so it must not
   * change. Pass 2 uses `innerFailure: 'continue'` and feeds the economy
   * collections, which need to see instructions *after* the first sub-event
   * call. Both passes are deduplicated by address below.
   */
  const pushBoth = (slotIndex: number, slotKind: CondKind, scriptAddr: number): void => {
    push(slotIndex, slotKind, walkScript(rom, scripts, scriptAddr));
    const loose = walkScript(rom, scripts, scriptAddr, 20_000, { innerFailure: "continue" });
    for (const hit of loose.gold) {
      if (!gold.some((g) => g.addr === hit.addr)) gold.push(hit);
    }
    for (const hit of loose.itemsGiven) {
      if (!itemsGiven.some((g) => g.addr === hit.addr && g.itemId === hit.itemId)) {
        itemsGiven.push(hit);
      }
    }
  };

  for (const slot of condSlots) {
    const addr = chapter.condPointers[slot.index] ?? 0;
    if (!rom.isSafeOffset(addr)) continue;

    switch (slot.kind) {
      case "TURN": {
        for (let a = addr; ; a += map.turnCondSize) {
          if (!rom.isSafeOffset(a + map.turnCondSize)) break;
          const type = rom.u8(a);
          if (type === 0) break;
          const event = rom.p32(a + 4);
          if (rom.isSafeOffset(event)) pushBoth(slot.index, slot.kind, event);
          // "信じられないがFE7は12バイトの短いターンイベントが存在する"
          if (isFe7 && type === 1) a -= map.turnCondSize - 12;
        }
        break;
      }
      case "TALK": {
        for (let a = addr; ; a += map.talkCondSize) {
          if (!rom.isSafeOffset(a + map.talkCondSize)) break;
          if (rom.u8(a) === 0) break;
          const event = rom.p32(a + 4);
          if (rom.isSafeOffset(event)) pushBoth(slot.index, slot.kind, event);
        }
        break;
      }
      case "OBJECT":
      case "ALWAYS": {
        const endOnU32 = slot.kind === "ALWAYS";
        for (let a = addr; ; a += 12) {
          if (!rom.isSafeOffset(a + 12)) break;
          if (endOnU32 ? rom.u32(a) === 0 : rom.u8(a) === 0) break;
          const event = rom.p32(a + 4);
          if (rom.isSafeOffset(event)) pushBoth(slot.index, slot.kind, event);
        }
        break;
      }
      case "TUTORIAL": {
        for (let a = addr; ; a += 4) {
          if (!rom.isSafeOffset(a + 4)) break;
          if (!RomBuffer.isPointer(rom.u32(a))) break;
          const event = rom.p32(a);
          if (rom.isSafeOffset(event)) pushBoth(slot.index, slot.kind, event);
        }
        break;
      }
      case "START_EVENT":
      case "END_EVENT": {
        pushBoth(slot.index, slot.kind, addr);
        break;
      }
      default:
        // PLAYER_UNIT / ENEMY_UNIT / FREEMAP_* / TRAP: not scripts.
        break;
    }
  }

  return { chapterIndex: chapter.index, recruits, gold, itemsGiven, truncatedWalks };
}

// ---------------------------------------------------------------- join order

export type JoinSource = "placement" | "recruit" | "load" | "cutscene";

export interface JoinEvidence {
  unitId: number;
  /** Map setting index of the earliest chapter the unit is present in. */
  chapterIndex: number;
  /**
   * The chapter's position in the play order (see `buildPlayOrder`), or `null`
   * when it is off every known path.
   *
   * This, not `chapterIndex`, is what "earliest" means. `chapterIndex` is a row
   * number in the map-setting table and the game's chapter *number* restarts at
   * 1 in every act, so neither orders the game: Vision Quest's map 16 is
   * followed by 41, 42 and only then 17.
   */
  storyOrder: number | null;
  source: JoinSource;
  /** Where the evidence is: a placement record address, or a `LOAD*` address. */
  evidenceAddr: number;
  /** True when the placement overrode the unit's own class (generic template). */
  classOverridden: boolean;
  /** Class the unit was placed as, when known. */
  placedClassId: number;
}

export interface JoinDerivation {
  /**
   * Earliest chapter the unit is in the player's army: an initial placement, or
   * a `LOAD1` ("仲間にする") instruction.
   */
  joins: Map<number, JoinEvidence>;
  /**
   * Earliest chapter the unit is referenced by *any* load instruction,
   * including `LOAD2`/`LOAD3` cutscene loads. This is "first appearance", which
   * can predate the join when a unit is loaded as a guest.
   */
  appearances: Map<number, JoinEvidence>;
  /** Placement records whose class disagreed with the unit's own class. */
  classOverriddenPlacements: number;
  /** Total placement records examined. */
  placementsExamined: number;
  /** `LOAD*` sites found, by kind. */
  sitesByKind: Record<JoinSource, number>;
}

const EMPTY_SITES: Record<JoinSource, number> = {
  placement: 0,
  recruit: 0,
  load: 0,
  cutscene: 0,
};

/**
 * Combine initial placements and mid-chapter load sites into a per-unit
 * earliest chapter.
 *
 * A placement only counts as the named character when its class id is 0 or
 * matches the unit's own class. `LOAD*` blocks are always counted, because a
 * load target is by construction "this unit is on the field".
 *
 * `orderOf` supplies the play position of a map index and is what "earliest"
 * is decided on; a chapter off every known path has no position and therefore
 * never beats one that has. Pass the map index back when there is no play order
 * to speak of - the comparison then degenerates to map-table order, which is
 * what this used to do.
 */
export function deriveJoins(
  chapters: readonly Chapter[],
  scans: readonly ChapterScan[],
  ownClassOf: ReadonlyMap<number, number>,
  orderOf: (mapIndex: number) => number | null = () => null,
): JoinDerivation {
  const joins = new Map<number, JoinEvidence>();
  const appearances = new Map<number, JoinEvidence>();
  const scansByChapter = new Map(scans.map((s) => [s.chapterIndex, s]));
  const sitesByKind: Record<JoinSource, number> = { ...EMPTY_SITES };
  let placementsExamined = 0;
  let classOverriddenPlacements = 0;

  /** Off-path chapters sort after every placed one, then by table order. */
  const rankOf = (record: JoinEvidence): number => record.storyOrder ?? Number.MAX_SAFE_INTEGER;

  const earliest = (into: Map<number, JoinEvidence>, record: JoinEvidence): void => {
    const existing = into.get(record.unitId);
    if (
      existing === undefined ||
      rankOf(record) < rankOf(existing) ||
      (rankOf(record) === rankOf(existing) && record.chapterIndex < existing.chapterIndex)
    ) {
      into.set(record.unitId, record);
    }
  };

  for (const chapter of chapters) {
    for (const placed of chapter.placements) {
      placementsExamined++;
      const own = ownClassOf.get(placed.unitId);
      const overridden = placed.classId !== 0 && own !== undefined && placed.classId !== own;
      if (overridden) {
        classOverriddenPlacements++;
        continue;
      }

      const record: JoinEvidence = {
        unitId: placed.unitId,
        chapterIndex: chapter.index,
        storyOrder: orderOf(chapter.index),
        source: "placement",
        evidenceAddr: placed.addr,
        classOverridden: false,
        placedClassId: placed.classId,
      };
      sitesByKind.placement++;
      earliest(joins, record);
      earliest(appearances, record);
    }

    const scan = scansByChapter.get(chapter.index);
    if (scan === undefined) continue;

    for (const site of scan.recruits) {
      const source: JoinSource = site.kind;
      sitesByKind[source]++;
      for (const unit of site.units) {
        const record: JoinEvidence = {
          unitId: unit.unitId,
          chapterIndex: chapter.index,
          storyOrder: orderOf(chapter.index),
          source,
          evidenceAddr: site.addr,
          classOverridden: false,
          placedClassId: unit.classId,
        };
        if (source === "recruit") earliest(joins, record);
        earliest(appearances, record);
      }
    }
  }

  return {
    joins,
    appearances,
    classOverriddenPlacements,
    placementsExamined,
    sitesByKind,
  };
}
