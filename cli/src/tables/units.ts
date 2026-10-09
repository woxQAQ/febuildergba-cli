/**
 * Unit (playable character) table.
 *
 * Record layout, 52 bytes. Derived from FEBuilderGBA's `UnitForm.designer.cs`
 * and `UnitFE7Form.designer.cs`, where the WinForms control names encode the
 * byte offset (`B12` = byte at offset 12, `W0` = word at offset 0, `P44` =
 * pointer at offset 44) and the adjacent label text names the field.
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
 * Note the off-by-one convention: **unit ids are 1-based**. Unit id `n` lives
 * at `tableOffset + (n - 1) * 52`. FEBuilderGBA does `uid--` before indexing
 * (`UnitForm.cs:271`).
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import { hex } from "../format.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextId, displayName, sanitizeName, sanitizeText } from "../text/huffman.ts";
import type { ClassBases } from "./classes.ts";
import type { ResolvedTable, WeaponLevels } from "./common.ts";
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

/**
 * A unit's **per-unit** base stats: the 7 stats at `+12..18` plus constitution
 * at `+19`.
 *
 * These are **signed deltas**, not final values. The reference spells this out
 * for the field it labels ユニット別能力 (`X_BASE.AccessibleDescription =
 * "@UNITBASE"`, InputFormRef.cs:12022):
 *
 *   「ユニットの基礎値です。この値に、クラスの能力値を加えたものがユニットの
 *     初期値になります。マイナス値にすることもできますが、合算した時に -1
 *     以下になると、2 の補数により、ロード時に最大数になります。」
 *
 * i.e. `startingStat = class base + unit base`, the field may be negative, and
 * if the sum reaches -1 the value **wraps to the maximum** when the game loads
 * the unit. Read as unsigned, `0xFF` would look like +255 instead of -1.
 *
 * Zero is by far the most common value (70 of 255 populated slots in the test
 * ROM) and simply means "no per-unit adjustment on top of the class base".
 */
export interface UnitStats {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
  con: number;
}

/**
 * The stats a unit actually starts with: class base + per-unit delta.
 *
 * `lck` has no class base in FE, so it equals the per-unit value. `con` uses
 * the class's constitution base. See `UnitStats` for the source of the rule.
 */
export type UnitStartingStats = UnitStats;

export interface UnitGrowths {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
}

export interface Unit {
  /** Unit id as used by the game and by support data. 1-based. */
  id: number;
  /** Index into the unit table. 0-based. `id === index + 1` for vanilla data. */
  index: number;
  address: number;
  nameTextId: number;
  descriptionTextId: number;
  /**
   * Display name: decoded, control bytes removed, `@XXXX` escapes stripped.
   *
   * The reference is inconsistent about this and both behaviours are real:
   * `UnitForm.GetUnitNameByAddr` returns `TextForm.Direct(id).Trim()` (keeps the
   * escapes), while `StatusUnitsMenuForm.GetNameFast` returns
   * `TextForm.DirectAndStripAllCode(id)` (strips them). This CLI strips, because
   * 17 units in `dream-of-five.gba` carry a trailing `@001F` glyph and a roster
   * keyed on `"Franseza@001F"` is keyed on noise. The unstripped form is kept in
   * {@link Unit.nameRaw} so nothing is lost.
   */
  name: string;
  /** Decoded name with `@XXXX` escapes left in place. See {@link Unit.name}. */
  nameRaw: string;
  description: string;
  classId: number;
  className: string;
  /**
   * True when this class is the *promoted* half of a base/promoted pair, i.e.
   * some other class's reverse `promotesToClassId` points at it. Such a unit
   * has already promoted and has no promotion left.
   *
   * Hack rosters skew heavily this way - Vision Quest starts 74% of its
   * playable units in a promoted class - so "can this unit still promote" is
   * a real strategic question, not a formality. Derived from the class table,
   * which is why this lives here rather than in an analysis script.
   */
  isPromotedClass: boolean;
  mapFaceId: number;
  portraitId: number;
  attribute: number;
  sortOrder: number;
  level: number;
  /** Per-unit deltas, **signed**. See `UnitStats`. */
  stats: UnitStats;
  /** Class base + per-unit delta: what the unit actually starts with. */
  startingStats: UnitStartingStats;
  growths: UnitGrowths;
  /** Sum of the seven growth rates. A rough "how much does this unit scale" signal. */
  growthTotal: number;
  weaponLevels: WeaponLevels;
  abilityFlags: [number, number, number, number];
  /** Raw pointer value stored at +44. */
  supportPointer: number;
  /** File offset the support pointer resolves to, or 0 when unset/invalid. */
  supportAddress: number;
  /** True when +44 held a pointer that lands inside the ROM. */
  hasSupportData: boolean;
  /** Heuristic: no name, no class and no level means an unused slot. */
  isEmpty: boolean;
}

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

/**
 * `class base + unit base`. Luck has no class base, so it passes through.
 * Constitution uses the class's `con` base.
 */
export function combineStartingStats(
  unit: UnitStats,
  classBases: ClassBases | undefined,
): UnitStartingStats {
  const base = (key: keyof ClassBases): number => classBases?.[key] ?? 0;
  return {
    hp: base("hp") + unit.hp,
    str: base("str") + unit.str,
    skl: base("skl") + unit.skl,
    spd: base("spd") + unit.spd,
    def: base("def") + unit.def,
    res: base("res") + unit.res,
    // No class luck base exists in FE: luck is purely per-unit.
    lck: unit.lck,
    con: base("con") + unit.con,
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
  const decodedName = decodeTextId(rom, nameTextId, text);
  const name = displayName(decodedName);
  const nameRaw = sanitizeName(decodedName);
  const description = sanitizeText(decodeTextId(rom, descriptionTextId, text));

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

/**
 * Map unit id -> display name. Falls back to `Unit 0xNN` for ids the table
 * does not cover, so support output never has holes.
 */
export function buildUnitNameMap(units: readonly Unit[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const unit of units) {
    if (unit.id !== 0) map.set(unit.id, unit.name);
  }
  return map;
}

export function unitNameOrId(nameMap: ReadonlyMap<number, string>, id: number): string {
  const name = nameMap.get(id);
  if (name && name.length > 0) return name;
  return `Unit ${hex(id, 2)}`;
}
