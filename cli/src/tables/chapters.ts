/**
 * Chapter ("map setting") parsing: map-setting records, the event-condition
 * tables they point at, and the placement blocks those tables name. "Which
 * chapter does a unit join in" is a query over this plus the raw event layer
 * (`unit_joins` view, `db/ddl.ts`), not computed here.
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
 * Allegiance, indexed by {@link parseUnitGrowAssign}. Names from the combo box
 * `L_3_UNITGROW_ASSIGN` (`EventUnitForm.Designer.cs:1259-1263`): 自軍 / 友軍 /
 * 敵軍 / 消滅. `removed` is not a side - a 消滅 unit is deleted on map load (how
 * a hack removes a roster unit), its wait icon rendering in the gray palette
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

export interface PostPlacement {
  /** Decoded packed FE8 coordinate at `+0`. */
  x: number;
  y: number;
  ext: number | null;
  /** `+2`: movement speed override for the approach (0 = default). */
  speed: number;
  /** `+3`: unit id this step belongs to (0 = the placed unit itself). */
  unitId: number;
  /** `+6`: frames to wait before this step. */
  wait: number;
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
   * Raw `+3` (the reference's `B3`): the only place a placement records its
   * allegiance - see {@link parseUnitGrowLevel}.
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
  /**
   * The post-placement steps, decoded from the 8-byte records at
   * `postPlacementAddr` (u16 packed pos, u8 speed, u8 unit id, u16 wait -
   * `EventUnitForm.cs` writes them at `8 * i`). Empty when absent.
   */
  postPlacements: PostPlacement[];
  /** `+12..15`: starting items. */
  items: number[];
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
   * `u16(addr + 0x80) / 2`: the number the game shows in the prep screen and
   * uses for the ending's turn count (`J_128`,
   * `AccessibleDescription = "@MAPSETTING_CHAPTOR_ID"`,
   * `InputFormRef.cs:12097`). Stored doubled so gaiden chapters can occupy half
   * steps: prologue 0, `C1` 2, `C26` 52, `Finale` 54 (27), `Postscript` 55
   * (27.5). Zero = no chapter number (every unused slot and bonus map).
   */
  chapterNumber: number;
  /** `u16(addr + 0x80)` before halving. */
  chapterNumberRaw: number;
  /**
   * `u16(addr + 0x70)`: "map name 1" text id (`J_112_TEXT`, マップ名1) - the prep
   * screen title. One of the four "is this a map setting record" probes in
   * `IsMapSettingEnd`.
   */
  titleTextId: number;
  /**
   * Decoded chapter title, e.g. `C7A: ... Into the ...`. Empty when there is no
   * text context, the id is 0, or the id does not decode. Distinguishes a real
   * chapter from a placeholder: unused slots are blank, world-map encounter maps
   * decode to `@001F`.
   */
  title: string;
  /** Event plist index from the map setting record. */
  eventPlist: number;
  /** `u8(addr + 12)`; 0 = none, else the game's rain/snow/sandstorm id. */
  weatherId: number;
  /** Raw `u16` at `layout.map.difficultyPos` (+0x14); 0 when not transcribed. */
  difficultyRaw: number;
  /**
   * Enemy level bonus on hard: `(difficultyRaw & 0xF0) >> 4`. Effective enemy
   * level is `level + hardBoost` before autolevel and class bases.
   */
  hardBoost: number;
  /** Enemy level penalty on normal: `(difficultyRaw >> 8) & 0xF`. */
  normalPenalty: number;
  /** Enemy level penalty on easy: `difficultyRaw & 0xF`. */
  easyPenalty: number;
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
   * Deployment slot count = `placements.length`, the same number the game
   * computes: `GetChapterAllyUnitCount` (`0x08012344`) resolves slot 10/11 via
   * `GetChapterAllyUnitDataPointer` (`0x08083348`) and counts 20-byte records
   * until `u8(+0) == 0` - byte-for-byte what {@link readPlacements} does. The
   * block doubles as the slot list: prep-screen chapters fill unused slots with
   * a placeholder template (this ROM: `unit 2 / Thief`, one per coordinate), so
   * `placements` can hold twelve records for one character. Read the count.
   */
  deploySlots: number;
  /**
   * Hard-mode slots (condition slot 11), equal to `deploySlots` unless slot 11
   * points elsewhere - here only `mapIndex 22` (`C10B: Needle's Eye`), whose
   * slot 11 is a 9-record block of green allies. `GetChapterAllyUnitCount`
   * (`0x08012344`) does not filter allegiance, so it counts 9, and the hard prep
   * screen would offer 9. The same block is also loaded by the start event
   * (`402C0100` at `0x14c2128`), so the greens are placed either way; only the
   * count is odd. Verify in-game.
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
 * The three "load units" instructions by leading byte:
 *   `402C` LOAD1 (ユニット読込 自軍ユニットは仲間にする) - **recruits**;
 *   `412C` LOAD2 (ユニット読込) - loads an existing member;
 *   `422C` LOAD3 (cutscene only).
 * `40050200...` (増援分岐) also carries a `POINTER_UNIT`, pointing at an **enemy**
 * block. `MakeUnitPointerEventScan` collects every `POINTER_UNIT` for its icon
 * overlay; we classify by owning instruction to get army membership only.
 */
export type LoadKind = "recruit" | "load" | "cutscene" | "other";

/**
 * Byte at index `i` of a pattern, or -1 when the pattern is too short.
 *
 * `Number.parseInt("")` is `NaN`, and every comparison against `NaN` is false -
 * which silently turns a short pattern into "other" rather than flagging it.
 */
function patternByte(pattern: string, i: number): number {
  if (i < 0) return -1;
  const at = i * 2;
  if (at + 2 > pattern.length) return -1;
  return Number.parseInt(pattern.slice(at, at + 2), 16);
}

/** `4005` - the composite-instruction prefix ("do X, then Y"). */
const COMPOSITE_HEAD = [0x40, 0x05] as const;

/**
 * The unit pointer of the composite LOAD family does **not** sit after a `2C`:
 *
 *   `40050200XXXXXXXX400A0000AC03A608`  Load reinforcements
 *   `40050200XXXXXXXX40050300YYYYYYYY400A0000...`
 *                                       Extension branch LOAD (two selectors)
 *
 * so the pointer is preceded by a `0200` / `0300` selector instead. Both are
 * *loads*, not recruits: they bring a block in without adding it to the party.
 */
const COMPOSITE_SELECTORS = new Set([0x02, 0x03]);

/**
 * Classify the `POINTER_UNIT` argument at byte `position` of an opcode pattern.
 * `LL2C` is the well-known form:
 *   `402C0100XXXXXXXX` LOAD1 (joins the party when ours)
 *   `412C0100XXXXXXXX` LOAD2 (existing member)
 *   `422C0100XXXXXXXX` LOAD3 (cutscene-only)
 * The composite family above puts its argument four bytes in with no `2C`;
 * classifying on `2C` alone drops it into `other`, and `chapter_recruits`
 * filters `load_kind != 'other'`, throwing away every reinforcement block
 * (190 + 18 on the FE8U fixture, 210 of 213 unreachable load blocks). So `other`
 * means "a unit block outside these families", not "not 402C/412C/422C".
 */
export function classifyUnitArg(pattern: string, position: number): LoadKind {
  if (patternByte(pattern, position - 3) === 0x2c) {
    const lead = patternByte(pattern, position - 4);
    if (lead === 0x40) return "recruit";
    if (lead === 0x41) return "load";
    if (lead === 0x42) return "cutscene";
    return "other";
  }

  const isCompositeHead =
    patternByte(pattern, position - 4) === COMPOSITE_HEAD[0] &&
    patternByte(pattern, position - 3) === COMPOSITE_HEAD[1];
  if (isCompositeHead && COMPOSITE_SELECTORS.has(patternByte(pattern, position - 2))) {
    return "load";
  }

  return "other";
}

export interface UnitPointerHit {
  addr: number;
  blockAddr: number;
  instruction: string;
  kind: LoadKind;
}

/** The 12-byte gold literal, with the amount left as a hole. */
const GOLD_LITERAL_HEAD = [0x40, 0x05, 0x03, 0x00];
const GOLD_OPCODE_GAIN = 0x21;
const GOLD_OPCODE_LOSE = 0x22;

/**
 * Gold literals anywhere inside one instruction: 20-byte composite forms like
 * `400A0000<ptr>40050300XXXX000021370000` ("call a sub-event, then pay out")
 * carry the literal at offset 8 *inside* the instruction, which the disassembler
 * returns as one step, so the walker never visits it. Literals are 4-byte
 * aligned; only offsets 0/4/8/... are checked.
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
 * Port of `EventCondForm.MakeUnitPointerEventScan` (EventCondForm.cs:1743):
 * walk one script, follow `POINTER_EVENT` jumps, collect `POINTER_UNIT` targets.
 * Stops on an exit code or after >10 consecutive unrecognised instructions
 * (the reference's bail-out).
 *
 * `innerFailure` matters: the reference aborts the *caller* when a sub-event
 * ends in anything but an exit (`if (inner !== 'exit') return inner`); in this
 * hack most sub-events end in the unknown-opcode bail-out, so 'abort' stops at
 * the first `400A0000` call and hides the rest. The placement scan uses
 * 'continue'.
 */
export interface WalkOptions {
  /** `'abort'` (default, reference-faithful) or `'continue'`. */
  innerFailure?: "abort" | "continue";
}

/** Every `POINTER_UNIT` target reachable from `startAddr`. */
export function walkScript(
  rom: RomBuffer,
  scripts: EventScriptTable,
  startAddr: number,
  budget = 20_000,
  options: WalkOptions = {},
): UnitPointerHit[] {
  const abortOnInnerFailure = (options.innerFailure ?? "abort") === "abort";
  const unitPointers: UnitPointerHit[] = [];
  const visited = new Set<number>();
  let instructions = 0;

  const walk = (from: number): "exit" | "unknowns" | "end-of-rom" | "budget" => {
    let addr = from;
    let lastBranchAddr = 0;
    let unknownCount = 0;

    while (true) {
      if (instructions++ > budget) return "budget";
      if (!rom.isSafeOffset(addr)) return "end-of-rom";

      const code = disassemble(rom, addr, scripts);

      if (isExitCode(rom, code, lastBranchAddr)) return "exit";

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

  walk(startAddr);
  return unitPointers;
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
 * Unlike a recruit-only scan, the reinforcement blocks (`kind: 'other'`) are
 * kept: they are where the bulk of a chapter's enemies live. Slot handling is
 * the reference's (`EventCondForm.MakeUnitPointer`, EventCondForm.cs:1577):
 * TURN / TALK / OBJECT / ALWAYS / TUTORIAL walk a table of 12-byte records
 * each holding a script pointer at `+4` and terminated by a zero byte;
 * START_EVENT / END_EVENT point straight at a script. The remaining slots
 * (PLAYER_UNIT, FREEMAP_*, TRAP) hold no script and are not walked.
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
      for (const hit of walkScript(rom, scripts, s, 20_000, { innerFailure: "continue" })) {
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
