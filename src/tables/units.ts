/**
 * Unit (playable character) table, 52-byte records. Layout from
 * `UnitForm.designer.cs` / `UnitFE7Form.designer.cs`: WinForms control names
 * encode the offset (`B12` byte 12, `W0` word 0, `P44` pointer 44), labels the
 * field.
 *
 *   +0   u16  name text id          +28..34 u8  growth rates (7)
 *   +2   u16  description text id   +35  u8  low-class battle palette
 *   +4   u8   unit id               +36  u8  high-class battle palette
 *   +5   u8   base class id         +37  u8  low-class custom animation
 *   +6   u16  map face id           +38  u8  high-class custom animation
 *   +8   u8   portrait id           +39  u8  (unlabelled)
 *   +9   u8   attribute             +40..43 u8  ability flags (4 bytes)
 *   +10  u8   sort order            +44  p32 support data pointer
 *   +11  u8   level                 +48  u8  talk group
 *   +12..18 u8 base stats (7)       +49..51 u8 (unlabelled)
 *   +19  u8   constitution
 *   +20..27 u8 weapon levels (8)
 *
 * **Unit ids are 1-based**: id `n` is at `tableOffset + (n - 1) * 52`
 * (`UnitForm.cs:271` does `uid--` before indexing).
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextEntry, displayName, sanitizeName, sanitizeText } from "../text/huffman.ts";
import type { ClassBases, UnitStats, UnitGrowths } from "../model/stats.ts";
import { combineStartingStats } from "../model/stats.ts";
import type { Unit } from "../model/snapshotRecords.ts";
import type { ResolvedTable } from "./common.ts";
import { readWeaponLevels } from "./common.ts";

export const UNIT_RECORD_SIZE = 52;

/** Field offsets within a unit record. */
export const UNIT_OFFSET = {
  nameTextId: 0,
  descriptionTextId: 2,
  unitId: 4,
  classId: 5,
  mapFaceId: 6,
  portraitId: 8,
  attribute: 9,
  sortOrder: 10,
  level: 11,
  baseStats: 12,
  constitution: 19,
  weaponLevels: 20,
  growths: 28,
  lowClassPalette: 35,
  highClassPalette: 36,
  lowClassAnimation: 37,
  highClassAnimation: 38,
  abilityFlags: 40,
  supportPointer: 44,
  talkGroup: 48,
} as const;

export interface UnitTableContext {
  rom: RomBuffer;
  table: ResolvedTable;
  text: TextContext;
  /** Class id -> display name, used to enrich unit output. */
  classNames: ReadonlyMap<number, string>;
  /**
   * Class id -> class base stats. Required to compute `startingStats`; when
   * absent the class contribution is treated as zero.
   */
  classBases?: ReadonlyMap<number, ClassBases>;
  /**
   * Class ids that are the promoted half of a pair, i.e. classes some other
   * class promotes *from*. Required to set {@link Unit.isPromotedClass}.
   */
  promotedClassIds?: ReadonlySet<number>;
}

/** Signed: these are deltas on the class base, and may be negative. */
function readStats(rom: RomBuffer, addr: number): UnitStats {
  const o = UNIT_OFFSET.baseStats;
  return {
    hp: rom.i8(addr + o + 0),
    str: rom.i8(addr + o + 1),
    skl: rom.i8(addr + o + 2),
    spd: rom.i8(addr + o + 3),
    def: rom.i8(addr + o + 4),
    res: rom.i8(addr + o + 5),
    lck: rom.i8(addr + o + 6),
    con: rom.i8(addr + UNIT_OFFSET.constitution),
  };
}

/** Growth rates are unsigned percentages; `> 100` just means "always grows". */
function readGrowths(rom: RomBuffer, addr: number): UnitGrowths {
  const o = UNIT_OFFSET.growths;
  return {
    hp: rom.u8(addr + o + 0),
    str: rom.u8(addr + o + 1),
    skl: rom.u8(addr + o + 2),
    spd: rom.u8(addr + o + 3),
    def: rom.u8(addr + o + 4),
    res: rom.u8(addr + o + 5),
    lck: rom.u8(addr + o + 6),
  };
}

export function readUnit(ctx: UnitTableContext, index: number): Unit | null {
  const { rom, table, text } = ctx;
  const addr = table.tableOffset + index * UNIT_RECORD_SIZE;
  if (!rom.isSafeOffset(addr) || addr + UNIT_RECORD_SIZE > rom.length) return null;

  const nameTextId = rom.u16(addr + UNIT_OFFSET.nameTextId);
  const descriptionTextId = rom.u16(addr + UNIT_OFFSET.descriptionTextId);
  const id = rom.u8(addr + UNIT_OFFSET.unitId);
  const classId = rom.u8(addr + UNIT_OFFSET.classId);
  const level = rom.u8(addr + UNIT_OFFSET.level);

  // `displayName` rather than `sanitizeName`: 17 names in this ROM decode with
  // a trailing `@001F` glyph escape, which is display noise, not part of the
  // name. The unstripped form is kept alongside it. See `text/huffman.ts`.
  // `decodeTextEntry` (not `decodeTextId`): 7 names in this ROM are stored in
  // the item font - see its doc comment. Unit 64 is `Radoslav`, not `"l"`.
  const decodedName = decodeTextEntry(rom, nameTextId, text);
  const name = displayName(decodedName);
  const nameRaw = sanitizeName(decodedName);
  const description = sanitizeText(decodeTextEntry(rom, descriptionTextId, text));

  const stats = readStats(rom, addr);
  const growths = readGrowths(rom, addr);

  const supportPointer = rom.u32(addr + UNIT_OFFSET.supportPointer);
  const supportAddress = RomBuffer.isPointer(supportPointer) ? rom.toOffset(supportPointer) : 0;
  const hasSupportData = supportAddress !== 0 && rom.isSafeOffset(supportAddress);

  return {
    id,
    index,
    address: addr,
    nameTextId,
    descriptionTextId,
    name,
    nameRaw,
    description,
    classId,
    className: ctx.classNames.get(classId) ?? "",
    isPromotedClass: ctx.promotedClassIds?.has(classId) ?? false,
    mapFaceId: rom.u16(addr + UNIT_OFFSET.mapFaceId),
    portraitId: rom.u8(addr + UNIT_OFFSET.portraitId),
    attribute: rom.u8(addr + UNIT_OFFSET.attribute),
    sortOrder: rom.u8(addr + UNIT_OFFSET.sortOrder),
    level,
    stats,
    startingStats: combineStartingStats(stats, ctx.classBases?.get(classId)),
    growths,
    growthTotal:
      growths.hp +
      growths.str +
      growths.skl +
      growths.spd +
      growths.def +
      growths.res +
      growths.lck,
    weaponLevels: readWeaponLevels(rom, addr + UNIT_OFFSET.weaponLevels),
    abilityFlags: [
      rom.u8(addr + UNIT_OFFSET.abilityFlags + 0),
      rom.u8(addr + UNIT_OFFSET.abilityFlags + 1),
      rom.u8(addr + UNIT_OFFSET.abilityFlags + 2),
      rom.u8(addr + UNIT_OFFSET.abilityFlags + 3),
    ],
    supportPointer,
    supportAddress,
    hasSupportData,
    isEmpty: nameTextId === 0 && classId === 0 && level === 0,
  };
}

/** Read every slot in the unit table. Entries that run past the ROM are skipped. */
export function readAllUnits(ctx: UnitTableContext): Unit[] {
  const units: Unit[] = [];
  for (let index = 0; index < ctx.table.maxCount; index++) {
    const unit = readUnit(ctx, index);
    if (unit === null) break;
    units.push(unit);
  }
  return units;
}

/** Look up a unit by its 1-based id. */
export function findUnitById(units: readonly Unit[], id: number): Unit | undefined {
  return units.find((u) => u.id === id);
}
