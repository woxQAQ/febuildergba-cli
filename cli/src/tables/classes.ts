/**
 * A class name, dispatched by storage format.
 *
 * Hacks store class names in either format, and the distinction matters: the
 * **item font** (`ITEM_FONT`) is a separate glyph space where `< 0x80` is plain
 * ASCII and `0x81..0xBC` are glyph codes for the letters that have no ASCII
 * slot. A name stored that way must NOT go through `decodeTextId` -
 * `applySpecialGlyphs` only expands the Latin-1 accented codes, so every
 * glyph code survives as a literal `@00XX`, and the later `stripAllCodes`
 * deletes them, leaving only the incidental ASCII letters.
 *
 * That is what turned Vision Quest's `Sword Pegasus` (id 71, `Natsuko`) into
 * `"w"` and `Sword Cavalier` (id 35, `Marlen`) into `"w li"` - not custom
 * names, just the item font read as text.
 */
function readClassName(rom: RomBuffer, textId: number, text: TextContext): string {
  if (textId === 0) return '';

  const entry = text.textBase + textId * 4;
  if (!rom.isSafeOffset(entry)) return '';

  const pointer = rom.u32(entry);
  if (isUnHuffmanPatchPointer(pointer)) {
    const addr = rom.toOffset(convertUnHuffmanPatchToPointer(pointer));
    const { text: name } = decodeItemFontBytes(unHuffmanRawBytes(rom, addr));
    return name.trim();
  }

  return displayName(decodeTextId(rom, textId, text));
}

/**
 * Class table.
 *
 * Record layout, 84 bytes. Derived from `ClassForm.designer.cs` control names
 * and label text, same method as the unit table.
 *
 *   +0   u16 name text id           +34..39 u8  promotion bonuses (6)
 *   +2   u16 description text id    +40..43 u8  ability flags (4)
 *   +4   u8  class id               +44..51 u8  weapon levels (8)
 *   +5   u8  promotes to class id   +52  p32 battle animation pointer
 *   +6   u8  wait icon              +56  p32 movement cost pointer
 *   +7   u8  movement speed         +60  p32 movement cost, rain
 *   +8   u16 generic enemy face     +64  p32 movement cost, snow
 *   +10  u8  sort order             +68  p32 terrain avoid pointer
 *   +11..17 u8 base stats (7)       +72  p32 terrain defence pointer
 *   +18  u8  movement range         +76  p32 terrain resistance pointer
 *   +19..25 u8 stat caps (7)        +80  u32 (unlabelled)
 *   +26  u8  experience bonus
 *   +27..33 u8 enemy growths (7)
 *
 * Class ids are **0-based** (unlike unit ids), and class 0 is the empty entry
 * FEBuilderGBA write-protects.
 */

import { RomBuffer } from '../rom/RomBuffer.ts';
import type { TextContext } from '../text/huffman.ts';
import {
  classifyTextPointer,
  convertUnHuffmanPatchToPointer,
  decodeTextId,
  displayName,
  isUnHuffmanPatchPointer,
  sanitizeText,
  stripAllCodes,
  unHuffmanRawBytes,
} from '../text/huffman.ts';
import { decodeItemFontBytes } from '../text/itemFont.ts';
import type { ResolvedTable, WeaponLevels } from './common.ts';
import { readWeaponLevels } from './common.ts';
import type { ClassFlagDef, MountKind } from './classFlags.ts';
import { classifyMount, decodeAbilityFlags, specialActionRole } from './classFlags.ts';

export const CLASS_RECORD_SIZE = 84;

/**
 * Entries in a class's movement-cost table: one per terrain id, `0x00..0x40`.
 *
 * **65, not 64.** Three independent measurements agree:
 *   1. `MoveCostForm.Designer.cs` declares exactly 65 `NumericUpDown`s,
 *      `B0..B64`, and `MoveCostForm.cs` labels 65 columns `J_0..J_64` with the
 *      terrain names `0..0x40` from `map_terrain_name_pointer`.
 *   2. The terrain-name table itself has 65 entries (`tables/terrainNames.ts`),
 *      and the two share an index space.
 *   3. The tables are allocated **0x41 bytes apart** in this ROM (16 distinct
 *      tables, every gap exactly 0x41), so a 64-byte read would slice the first
 *      byte off the next table.
 *
 * `PatchUtil.WriteIndependence` copies 68 bytes, i.e. 65 rounded up to a
 * 4-byte boundary, which is consistent with 65 as well.
 *
 * Reading only 64 silently drops terrain id `0x40` ("Mast") - the last column
 * the reference displays.
 */
export const CLASS_TERRAIN_COUNT = 0x41;

/** Movement-cost value meaning "this class cannot enter this terrain". */
export const IMPASSABLE_COST = 0xff;

export const CLASS_OFFSET = {
  nameTextId: 0,
  descriptionTextId: 2,
  classId: 4,
  promotesToClassId: 5,
  waitIcon: 6,
  movementSpeed: 7,
  genericEnemyFace: 8,
  sortOrder: 10,
  baseStats: 11,
  movementRange: 18,
  statCaps: 19,
  experienceBonus: 26,
  enemyGrowths: 27,
  promotionBonuses: 34,
  abilityFlags: 40,
  weaponLevels: 44,
  battleAnimationPointer: 52,
  movementCostPointer: 56,
  movementCostRainPointer: 60,
  movementCostSnowPointer: 64,
  terrainAvoidPointer: 68,
  terrainDefencePointer: 72,
  terrainResistancePointer: 76,
  unlabelled80: 80,
} as const;

export interface ClassBases {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  con: number;
}

/**
 * What a class *adds* to its avoid / defence / resistance while standing on a
 * terrain. All three arrays are indexed by the same terrain id `0x00..0x40` the
 * movement-cost table uses.
 */
export interface TerrainBonuses {
  avoid: number[];
  def: number[];
  res: number[];
}

export interface UnitClass {
  id: number;
  index: number;
  address: number;
  nameTextId: number;
  name: string;
  description: string;
  /**
   * **The class this one is promoted FROM** - the field is a *reverse* link,
   * despite the reference implementation's own naming. Verified on FE8U:
   * `Knight`(1) stores 3, and 3 is `General`; `Paladin`(7) stores 5, and 5 is
   * `Lance Cavalier`. Reading it as "this class promotes into X" produces
   * nonsense (a level-1 unit looking already-promoted).
   *
   * To test "is this class already promoted", count *inbound* links instead:
   * some `X` exists with `promotesToClassId === thisClass`.
   *
   * {@link UnitClass.sortOrder} is the forward view: each base/promoted pair
   * shares a value (Brawler=1, Great Chief=2).
   */
  promotesToClassId: number;
  /**
   * Promotion tier. Each base class and its promoted version share one value,
   * so 1 = Brawler/Great Chief tier, 2 = Gladiator, ... Read this, not
   * {@link promotesToClassId}, to know which side of a promotion a class is on.
   */
  sortOrder: number;
  movementRange: number;
  movementSpeed: number;
  bases: ClassBases;
  /** Stat caps, same field order as `bases`. */
  caps: ClassBases;
  enemyGrowths: {
    hp: number;
    str: number;
    skl: number;
    spd: number;
    def: number;
    res: number;
    lck: number;
  };
  /** Stat gains applied on promotion. Six fields - the ROM has no luck bonus. */
  promotionBonuses: {
    hp: number;
    str: number;
    skl: number;
    spd: number;
    def: number;
    res: number;
  };
  weaponLevels: WeaponLevels;
  /** The raw four ability bytes at `+40`..`+43`. */
  abilityFlags: [number, number, number, number];
  /**
   * Decoded ability flags as stable ids (`mountHorse`, `canto`, `dance`, ...).
   *
   * Empty when `config/data` is unavailable - see `tables/classFlags.ts`. The
   * bit names live in `unitclass_checkbox_<game>.txt`, not in the C# code and
   * not in the ROM.
   */
  abilityFlagIds: string[];
  /** Mount category from the icon flags. `null` for foot units. */
  mount: MountKind;
  /** Utility role from the action flags, or `null`. */
  specialAction: 'dancer' | 'bard' | 'thief' | null;
  /**
   * Cost to enter each terrain type, indexed by terrain id. `0xFF` means the
   * class cannot enter that terrain. Read from the pointer at `+56`.
   */
  movementCosts: number[];
  /**
   * True when every *passable* terrain costs the same.
   *
   * That is the mechanical signature of a flying class: fliers ignore terrain,
   * so their cost table is uniform apart from the terrains nobody may enter.
   *
   * This is now a **cross-check**, not the primary source: the ability-flag
   * table gives `mountPegasus` / `mountWyvern` directly. The two disagreeing is
   * a useful signal that something is mis-parsed.
   */
  flying: boolean;
  /**
   * Terrain bonuses this class receives, indexed by terrain id. Read from the
   * pointers at `+68` / `+72` / `+76`.
   *
   * `ClassForm.cs:517-521` maps the three `地形回避` / `地形防御` / `地形魔防`
   * columns to those offsets, and `MoveCostForm.cs:329-334` dereferences each as
   * `p32(classAddr + offset)` before indexing by terrain id — so they are
   * pointers, exactly like the movement-cost table at `+56`.
   *
   * `null` when the pointers are unusable (class 0, or a class with no tables).
   */
  terrainBonuses: TerrainBonuses | null;
  /**
   * True when this class gets **no terrain bonus on any terrain**.
   *
   * That is the mechanical definition of "this class ignores terrain". It is a
   * third, independent signal alongside `mount` (icon flags) and `flying`
   * (uniform movement costs), and it is the **most complete** of the three:
   *
   *   - icon flags (`+41` bits `0x08`/`0x10`) → 9 classes on the fixture ROM
   *   - uniform movement costs (`+56`)         → 17 classes
   *   - all-zero terrain bonus (`+68`)         → 17 classes, **identical set**
   *
   * The 8 the icon flags miss are the airborne *monster* classes (Manakete,
   * Phantom, Mogall, Arch Mogall, Gargoyle, Grotesque, Dracolich), which have
   * no mount flag because their map icons are not the flier icons.
   */
  terrainBonusImmune: boolean;
  /** Heuristic: name id 0 and class id 0 means an unused slot. */
  isEmpty: boolean;
}

export interface ClassTableContext {
  rom: RomBuffer;
  table: ResolvedTable;
  text: TextContext;
  /**
   * Ability-flag definitions from `config/data`. When omitted, `abilityFlagIds`
   * is empty and role derivation falls back to movement costs.
   */
  abilityFlagDefs?: readonly ClassFlagDef[];
}

/**
 * Read a movement-cost table. Returns an empty array when the pointer is not
 * usable, so callers can treat "no data" and "uniform costs" differently.
 */
function readMovementCosts(rom: RomBuffer, addr: number): number[] {
  const offset = rom.toOffset(rom.u32(addr + CLASS_OFFSET.movementCostPointer));
  if (!rom.isSafeOffset(offset) || offset + CLASS_TERRAIN_COUNT > rom.length) return [];
  return Array.from(rom.bytes(offset, CLASS_TERRAIN_COUNT));
}

/** See {@link UnitClass.flying}. */
function isFlying(costs: readonly number[]): boolean {
  const passable = costs.filter((v) => v !== IMPASSABLE_COST);
  return passable.length > 0 && new Set(passable).size === 1;
}

/**
 * Read one of the three terrain-bonus tables. Same shape as
 * {@link readMovementCosts}: `p32(classAddr + offset)`, then
 * {@link CLASS_TERRAIN_COUNT} bytes indexed by terrain id.
 */
function readTerrainBonus(rom: RomBuffer, addr: number, offset: number): number[] | null {
  const tableOffset = rom.toOffset(rom.u32(addr + offset));
  if (!rom.isSafeOffset(tableOffset) || tableOffset + CLASS_TERRAIN_COUNT > rom.length) return null;
  return Array.from(rom.bytes(tableOffset, CLASS_TERRAIN_COUNT));
}

function readBases(rom: RomBuffer, addr: number): ClassBases {
  const o = CLASS_OFFSET.baseStats;
  return {
    hp: rom.u8(addr + o + 0),
    str: rom.u8(addr + o + 1),
    skl: rom.u8(addr + o + 2),
    spd: rom.u8(addr + o + 3),
    def: rom.u8(addr + o + 4),
    res: rom.u8(addr + o + 5),
    con: rom.u8(addr + o + 6),
  };
}

export function readClass(ctx: ClassTableContext, index: number): UnitClass | null {
  const { rom, table, text } = ctx;
  const addr = table.tableOffset + index * CLASS_RECORD_SIZE;
  if (!rom.isSafeOffset(addr) || addr + CLASS_RECORD_SIZE > rom.length) return null;

  const nameTextId = rom.u16(addr + CLASS_OFFSET.nameTextId);
  const descriptionTextId = rom.u16(addr + CLASS_OFFSET.descriptionTextId);
  const id = rom.u8(addr + CLASS_OFFSET.classId);

  const caps = readBases(rom, addr + (CLASS_OFFSET.statCaps - CLASS_OFFSET.baseStats));
  const movementCosts = readMovementCosts(rom, addr);
  const abilityFlags: [number, number, number, number] = [
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 0),
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 1),
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 2),
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 3),
  ];
  const abilityFlagIds =
    ctx.abilityFlagDefs === undefined
      ? []
      : decodeAbilityFlags(abilityFlags, ctx.abilityFlagDefs);

  // Terrain avoid / defence / resistance, three pointer tables indexed by the
  // same terrain id the movement-cost table uses.
  const terrainAvoid = readTerrainBonus(rom, addr, CLASS_OFFSET.terrainAvoidPointer);
  const terrainDef = readTerrainBonus(rom, addr, CLASS_OFFSET.terrainDefencePointer);
  const terrainRes = readTerrainBonus(rom, addr, CLASS_OFFSET.terrainResistancePointer);
  const terrainBonuses: TerrainBonuses | null =
    terrainAvoid !== null && terrainDef !== null && terrainRes !== null
      ? { avoid: terrainAvoid, def: terrainDef, res: terrainRes }
      : null;
  // "No terrain bonus on any terrain" is the mechanical definition of ignoring
  // terrain. Unknown (unreadable pointers) is reported as false rather than
  // claiming immunity without evidence.
  const terrainBonusImmune =
    terrainBonuses !== null &&
    terrainBonuses.avoid.every((v) => v === 0) &&
    terrainBonuses.def.every((v) => v === 0) &&
    terrainBonuses.res.every((v) => v === 0);

  return {
    id,
    index,
    address: addr,
    nameTextId,
    name: readClassName(rom, nameTextId, text),
    description: sanitizeText(decodeTextId(rom, descriptionTextId, text)),
    promotesToClassId: rom.u8(addr + CLASS_OFFSET.promotesToClassId),
    sortOrder: rom.u8(addr + CLASS_OFFSET.sortOrder),
    movementRange: rom.u8(addr + CLASS_OFFSET.movementRange),
    movementSpeed: rom.u8(addr + CLASS_OFFSET.movementSpeed),
    bases: readBases(rom, addr),
    caps,
    enemyGrowths: {
      hp: rom.u8(addr + CLASS_OFFSET.enemyGrowths + 0),
      str: rom.u8(addr + CLASS_OFFSET.enemyGrowths + 1),
      skl: rom.u8(addr + CLASS_OFFSET.enemyGrowths + 2),
      spd: rom.u8(addr + CLASS_OFFSET.enemyGrowths + 3),
      def: rom.u8(addr + CLASS_OFFSET.enemyGrowths + 4),
      res: rom.u8(addr + CLASS_OFFSET.enemyGrowths + 5),
      lck: rom.u8(addr + CLASS_OFFSET.enemyGrowths + 6),
    },
    promotionBonuses: {
      hp: rom.u8(addr + CLASS_OFFSET.promotionBonuses + 0),
      str: rom.u8(addr + CLASS_OFFSET.promotionBonuses + 1),
      skl: rom.u8(addr + CLASS_OFFSET.promotionBonuses + 2),
      spd: rom.u8(addr + CLASS_OFFSET.promotionBonuses + 3),
      def: rom.u8(addr + CLASS_OFFSET.promotionBonuses + 4),
      res: rom.u8(addr + CLASS_OFFSET.promotionBonuses + 5),
    },
    weaponLevels: readWeaponLevels(rom, addr + CLASS_OFFSET.weaponLevels),
    abilityFlags,
    abilityFlagIds,
    mount: classifyMount(abilityFlagIds),
    specialAction: specialActionRole(abilityFlagIds),
    movementCosts,
    flying: isFlying(movementCosts),
    terrainBonuses,
    terrainBonusImmune,
    isEmpty: nameTextId === 0 && id === 0,
  };
}

/** `ClassForm.Init` caps the scan at index 0xff inclusive, i.e. 256 records. */
export const CLASS_HARD_LIMIT = 0x100;

/**
 * Read the class table, using FEBuilderGBA's read-count predicate verbatim
 * (`ClassForm.Init`):
 *
 *     if (i == 0)               return true;   // index 0 is always kept
 *     if (i > 0xff)             return false;  // hard cap, 256 records
 *     return rom.u8(addr + 4) != 0;            // stop at the first class id 0
 *
 * The terminator matters: past the last real class the bytes are *not* empty
 * padding, they are whatever else the linker placed there. Scanning them as
 * classes yields records with plausible-looking names ("Dark", "Gunnels")
 * attached to bogus ids, which then silently poison any id -> name map.
 *
 * Class 0 is the reserved empty entry, so it is kept and reported with
 * `isEmpty: true` rather than treated as the terminator.
 */
export function readAllClasses(
  ctx: ClassTableContext,
  options: { maxCount?: number } = {},
): UnitClass[] {
  const cap = Math.min(options.maxCount ?? ctx.table.maxCount, CLASS_HARD_LIMIT);
  const classes: UnitClass[] = [];
  for (let index = 0; index < cap; index++) {
    const cls = readClass(ctx, index);
    if (cls === null) break;
    if (index > 0 && cls.id === 0) break;
    classes.push(cls);
  }
  return classes;
}

/** class id -> display name, for enriching unit output. */
export function buildClassNameMap(classes: readonly UnitClass[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const cls of classes) {
    if (cls.name.length > 0) map.set(cls.id, cls.name);
  }
  return map;
}
