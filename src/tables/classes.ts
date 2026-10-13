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
import type { ResolvedTable } from "./common.ts";
import { readWeaponLevels } from "./common.ts";
import type { ClassFlagDef } from "./classFlags.ts";
import { classifyMount, decodeAbilityFlags, specialActionRole } from "./classFlags.ts";
import type { ClassBases } from "../model/stats.ts";
import type { TerrainBonuses, UnitClass } from "../model/snapshotRecords.ts";

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
