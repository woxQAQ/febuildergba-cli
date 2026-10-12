/**
 * Chapter ("map setting") parsing: map-setting records, the event-condition
 * tables they point at, and the placement blocks those tables name. "Which
 * chapter does a unit join in" is a query over this plus the raw event layer
 * (`analysis/joins.ts`), not computed here.
 *
 *     mapSetting slot                 (0x0B5F98 FE8U, searched)
 *       -> map-setting table          (148-byte records, one per map id)
 *         record +116 (u8)            = event plist index
 *           -> event plist table      (4-byte pointer entries, `map_event_pointer`)
 *             entry                   = event-condition table
 *               20 pointer slots       (see config/data/eventcond_<game>.txt)
 *                 slot 10 / 11        = normal / hard player placement block
 *                 slot 18 / 19        = START_EVENT / END_EVENT script
 *                 slots 0..7          = small condition records, each with a script ptr
 *
 * Two deliberate deviations from the reference:
 *   - Record count. `MapSettingForm.IsMapSettingEnd` (MapSettingForm.cs:64) ends
 *     the table at the first record whose `u32(addr)` looks like a GBA pointer.
 *     Vanilla `+0` is a small integer; the "Dream of Five" hack rewrote every
 *     `+0` to a pointer into a custom map-name table (0x081C32C8, +4/record), so
 *     the reference scan reports zero maps. We try it first, then fall back to
 *     scanning on structure when it yields nothing and the first record passes
 *     the structural checks (`countSource` records the path).
 *   - Class overrides. A placement stores `unitId` at `+0`, `classId` at `+1`;
 *     hack authors reuse one unit id as a template and vary the class (this ROM
 *     has 12 records of `unit 2 / class 13` in one chapter). A record is *the
 *     named character* only when `classId` is 0 (own class) or equals the
 *     unit's class. Overrides are still reported, flagged `classOverridden`,
 *     since a unit can legitimately join promoted.
 *
 * The table index is not the chapter number: one 148-byte record per map id,
 * interleaved with rows no player sees as "chapter N" - unused slots (all
 * zero), world-map/skirmish maps (`title` = the placeholder glyph `@001F`,
 * `chapterNumber` duplicating the story chapter), bonus/debug/checkpoint maps.
 * The authoritative number is `+0x80` (`Chapter.chapterNumber`); report the
 * index only as an address-like handle, never as "chapter N".
 *
 * Reference: `MapSettingForm.cs`, `MapPointerForm.cs`,
 * `EventCondForm.cs:1564-1839`, `U.ParseUnitGrowLV` (U.cs:1734),
 * `U.MakeFe8UnitPos` (U.cs:1770), `InputFormRef.cs:12097`.
 */

import type { GameLayout, MapLayout } from "../data/layouts.ts";
import { resolveTableSlot } from "../data/layouts.ts";
import { RomBuffer } from "../rom/RomBuffer.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextId } from "../text/huffman.ts";
import type {
  CondSlot,
  CondSlotInfo,
  PostPlacement,
  PlacedUnit,
  Chapter,
} from "../model/snapshotRecords.ts";
import type { CondKind, UnitSide } from "../model/game.ts";
import { COND_KINDS, UNIT_SIDES } from "../model/game.ts";

// ---------------------------------------------------------------- condition slots

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

/**
 * Read a placement block: `layout.map.unitDataSize`-byte records, ending at the
 * first `+0 == 0` (`EventUnitForm.Init`, EventUnitForm.cs:147). The same reader
 * serves player, NPC and enemy blocks - that mirrors the game, not convenience:
 * FE8 has no enemy placement table, so allegiance is a bitfield inside the
 * record (`docs/chapters-and-events.md` §3.19).
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
    const postAddr = rom.isSafePointer(post) ? rom.toOffset(post) : 0;
    const postCount = rom.u8(a + 7);

    const postPlacements: PostPlacement[] = [];
    for (let s = 0; s < postCount; s++) {
      const pa = postAddr + s * 8;
      if (postAddr === 0 || !rom.isSafeOffset(pa + 8)) break;
      const coord = decodeUnitPosition(rom.u16(pa), layout.version);
      postPlacements.push({
        x: coord.x,
        y: coord.y,
        ext: coord.ext,
        speed: rom.u8(pa + 2),
        unitId: rom.u8(pa + 3),
        wait: rom.u16(pa + 6),
      });
    }

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
      postPlacementCount: postCount,
      postPlacementAddr: postAddr,
      postPlacements,
      items,
    });
  }
  return out;
}

// ---------------------------------------------------------------- chapters

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
    // `MapSettingDifficultyForm`: bits 0-3 easy penalty, 4-7 hard boost,
    // 8-11 normal penalty. All three are enemy **level** deltas.
    const difficultyRaw = map.difficultyPos === null ? 0 : rom.u16(record.addr + map.difficultyPos);
    const chapter: Chapter = {
      index: record.index,
      mapSettingAddr: record.addr,
      chapterNumberRaw,
      chapterNumber: chapterNumberRaw / 2,
      titleTextId,
      title: text === null ? "" : decodeTextId(rom, titleTextId, text),
      eventPlist: record.eventPlist,
      weatherId: record.weather,
      difficultyRaw,
      hardBoost: (difficultyRaw & 0xf0) >> 4,
      normalPenalty: (difficultyRaw & 0xf00) >> 8,
      easyPenalty: difficultyRaw & 0x0f,
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
            // `condPointers` was filled with exactly `condSlots.length` entries
            // above, so a resolved slot index always lands inside it.
            return i < 0 ? 0 : (chapter.condPointers[i] as number);
          };

          chapter.playerPlacementAddr = at("PLAYER_UNIT");
          // Slot 11 is the second PLAYER_UNIT entry (hard mode).
          const playerSlots = condSlots
            .map((s, i) => (s.kind === "PLAYER_UNIT" ? i : -1))
            .filter((i) => i >= 0);
          if (playerSlots.length > 1) {
            chapter.hardPlacementAddr = chapter.condPointers[playerSlots[1] as number] as number;
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
