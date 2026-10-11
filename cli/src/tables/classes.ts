/**
 * A class name, dispatched by storage format. Hacks use either the normal text
 * encoding or the **item font** (`ITEM_FONT`), a separate glyph space where
 * `< 0x80` is ASCII and `0x81..0xBC` are glyphs for letters with no ASCII slot.
 * An item-font name must NOT go through `decodeTextId`: `applySpecialGlyphs`
 * expands only Latin-1 accents, so every glyph survives as `@00XX` and
 * `stripAllCodes` deletes it, leaving the incidental ASCII. That is how Vision
 * Quest's `Sword Pegasus` (id 71) became `"w"` and `Sword Cavalier` (id 35)
 * `"w li"`.
 */
function readClassName(rom: RomBuffer, textId: number, text: TextContext): string {
  if (textId === 0) return "";

  const entry = text.textBase + textId * 4;
  if (!rom.isSafeOffset(entry)) return "";

  const pointer = rom.u32(entry);
  if (isUnHuffmanPatchPointer(pointer)) {
    const addr = rom.toOffset(convertUnHuffmanPatchToPointer(pointer));
    const { text: name } = decodeItemFontBytes(unHuffmanRawBytes(rom, addr));
    return name.trim();
  }

  return displayName(decodeTextId(rom, textId, text));
}

/**
 * Class table, 84-byte records. Layout from `ClassForm.designer.cs` control names
 * and labels (same method as the unit table).
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
 *   +26  u8  class power
 *   +27..33 u8 enemy growths (7)
 *
 * Class ids are **0-based** (unlike unit ids), and class 0 is the empty entry
 * FEBuilderGBA write-protects.
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import type { TextContext } from "../text/huffman.ts";
import {
  classifyTextPointer,
  convertUnHuffmanPatchToPointer,
  decodeTextId,
  displayName,
  isUnHuffmanPatchPointer,
  sanitizeText,
  stripAllCodes,
  unHuffmanRawBytes,
} from "../text/huffman.ts";
import { decodeItemFontBytes } from "../text/itemFont.ts";
import type { ResolvedTable, WeaponLevels } from "./common.ts";
import { readWeaponLevels } from "./common.ts";
import type { ClassFlagDef, MountKind } from "./classFlags.ts";
import { classifyMount, decodeAbilityFlags, specialActionRole } from "./classFlags.ts";

export const CLASS_RECORD_SIZE = 84;

/**
 * Movement-cost entries: one per terrain id, `0x00..0x40`. **65, not 64**, from
 * three measurements: `MoveCostForm.Designer.cs` declares `B0..B64` and labels
 * 65 columns `J_0..J_64` with the 65 `map_terrain_name_pointer` names; the
 * tables are allocated **0x41 bytes apart** (16 tables, every gap 0x41, so a
 * 64-byte read would slice the next); `PatchUtil.WriteIndependence` copies 68
 * bytes (65 rounded to 4). Reading 64 silently drops terrain id `0x40` (Mast).
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
  classPower: 26,
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
   * The class this one is promoted FROM - a **reverse** link despite the name.
   * Verified FE8U: `Knight`(1) stores 3 (`General`), `Paladin`(7) stores 5
   * (`Lance Cavalier`); reading it forward gives nonsense. The name is kept
   * because {@link CLASS_OFFSET.promotesToClassId} reads byte `+5` and
   * FEBuilderGBA's own label for it is 転職先 (promotion *destination*), so a
   * reader comparing the two should not find them quietly disagreeing. Read
   * {@link buildPromotionGraph} instead of resolving the direction here.
   *
   * The pair links **both ways** (base -> promoted and promoted -> base), so
   * the byte alone cannot order it; `sortOrder` breaks the tie.
   */
  promotesToClassId: number;
  /**
   * Promotion tier; each base/promoted pair shares one value (1 = Brawler/Great
   * Chief, 2 = Gladiator, ...). Read this to know which side a class is on.
   */
  sortOrder: number;
  movementRange: number;
  movementSpeed: number;
  /**
   * `+26`: **class power** (威力等级), the divisor/multiplier of the FE6/7/8
   * experience formula. The designer label is 経験値補正値 with
   * `AccessibleDescription = "@CLASS_POWER"` (ClassForm.Designer.cs `J_26`,
   * same in ClassFE6Form.Designer.cs), and the FE8U decomp names the byte
   * `ClassData.classRelativePower` at `0x1A` (include/bmunit.h). Vanilla
   * values are 1 (trainees/civilians), 2 (thieves, healers, dancers),
   * 3 (everything else), 5 (final bosses); 0 marks the empty entry.
   * Earlier read as "experience bonus" - a mistranslation of the label.
   */
  classPower: number;
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
  specialAction: "dancer" | "bard" | "thief" | null;
  /**
   * Cost to enter each terrain type, indexed by terrain id. `0xFF` means the
   * class cannot enter that terrain. Read from the pointer at `+56`.
   */
  movementCosts: number[];
  /** Rain-weather cost table (`+60`), or `[]` when the class has none. */
  movementCostsRain: number[];
  /** Snow-weather cost table (`+64`), or `[]` when the class has none. */
  movementCostsSnow: number[];
  /**
   * True when every *passable* terrain costs the same - the mechanical signature
   * of a flier, whose cost table is uniform except impassable terrain. A
   * cross-check (the ability flags give `mountPegasus`/`mountWyvern` directly);
   * disagreement signals a mis-parse.
   */
  flying: boolean;
  /**
   * Terrain avoid/defence/resistance bonuses, indexed by the same terrain id.
   * `ClassForm.cs:517-521` maps 地形回避/地形防御/地形魔防 to `+68`/`+72`/`+76`;
   * `MoveCostForm.cs:329-334` dereferences each as `p32(classAddr + offset)`
   * before indexing, so they are pointers like `+56`. `null` when unusable.
   */
  terrainBonuses: TerrainBonuses | null;
  /**
   * True when this class gets **no terrain bonus on any terrain** - the
   * definition of ignoring terrain, and the most complete of three signals:
   * icon flags (`+41` bits 0x08/0x10) find 9 classes on the fixture, uniform
   * movement costs (`+56`) 17, all-zero terrain bonus (`+68`) 17 with the
   * **identical set**. The 8 the flags miss are airborne monsters (Manakete,
   * Phantom, Mogall, Arch Mogall, Gargoyle, Grotesque, Dracolich), which have no
   * mount flag because their icons are not flier icons.
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
 * Read a movement-cost table from one of the three cost pointers; `[]` when the
 * pointer is unusable, so callers can tell "no data" from "uniform costs".
 */
function readMovementCosts(rom: RomBuffer, addr: number, pointerOffset: number): number[] {
  const offset = rom.toOffset(rom.u32(addr + pointerOffset));
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
  const movementCosts = readMovementCosts(rom, addr, CLASS_OFFSET.movementCostPointer);
  // Weather variants of the same table (+60 rain, +64 snow). Empty when the
  // class has no weather-specific table, which is the common case.
  const movementCostsRain = readMovementCosts(rom, addr, CLASS_OFFSET.movementCostRainPointer);
  const movementCostsSnow = readMovementCosts(rom, addr, CLASS_OFFSET.movementCostSnowPointer);
  const abilityFlags: [number, number, number, number] = [
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 0),
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 1),
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 2),
    rom.u8(addr + CLASS_OFFSET.abilityFlags + 3),
  ];
  const abilityFlagIds =
    ctx.abilityFlagDefs === undefined ? [] : decodeAbilityFlags(abilityFlags, ctx.abilityFlagDefs);

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
    classPower: rom.u8(addr + CLASS_OFFSET.classPower),
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
    movementCostsRain,
    movementCostsSnow,
    flying: isFlying(movementCosts),
    terrainBonuses,
    terrainBonusImmune,
    isEmpty: nameTextId === 0 && id === 0,
  };
}

/** `ClassForm.Init` caps the scan at index 0xff inclusive, i.e. 256 records. */
export const CLASS_HARD_LIMIT = 0x100;

/**
 * Read the class table with FEBuilderGBA's read-count predicate (`ClassForm.Init`):
 *     i == 0               -> keep            (index 0 always kept)
 *     i > 0xff             -> stop            (256-record cap)
 *     u8(addr + 4) != 0    -> stop at first class id 0
 * The terminator matters: past the last class the bytes are whatever the linker
 * placed, and scanning them as classes yields plausible names ("Dark",
 * "Gunnels") on bogus ids that poison id -> name maps. Class 0 is the reserved
 * empty entry, kept with `isEmpty: true`.
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

/**
 * The class table's promotion graph, resolved once. `+5` is a reverse link (see
 * {@link UnitClass.promotesToClassId}) and the pair links both ways, so the
 * direction can only be recovered by comparing {@link UnitClass.sortOrder} -
 * across the vanilla base/promoted pairs the **higher** value is the promoted
 * side. Both halves of the answer are needed often enough that reading the byte
 * directly is how the two callers of this used to drift apart, so the rule
 * lives here and nowhere else.
 */
export interface PromotionGraph {
  /** Class ids that are the promoted half of a pair, with a promotion left. */
  readonly promoted: ReadonlySet<number>;
  /** Base class id -> the class it promotes into. Absent when it has none. */
  readonly targets: ReadonlyMap<number, UnitClass>;
}

/**
 * Three-tier chains exist (trainee -> base -> promoted) and `+5` names each
 * class's *own* base, so a promoted class whose reverse link points at another
 * promoted class still yields a correct base -> promoted edge.
 */
export function buildPromotionGraph(classes: readonly UnitClass[]): PromotionGraph {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const promoted = new Set<number>();
  for (const c of classes) {
    const target = byId.get(c.promotesToClassId);
    if (target && target.sortOrder < c.sortOrder) promoted.add(c.id);
  }

  const targets = new Map<number, UnitClass>();
  for (const c of classes) {
    if (!promoted.has(c.id)) continue;
    const base = byId.get(c.promotesToClassId);
    if (base !== undefined && base.id !== c.id) targets.set(base.id, c);
  }

  return { promoted, targets };
}
