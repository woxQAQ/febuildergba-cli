/**
 * Skill extraction for the FE8U `SkillSystem` patch. Only that variant is
 * decoded (see `rom/skillSystem.ts`); the FE8J families are unreachable.
 *
 * Five tables, each a **slot** resolved by signature search
 * (`resolveSkillPointers`), one dereference to the data:
 * | pointer        | shape                                                      |
 * |----------------|------------------------------------------------------------|
 * | `text`         | `u16` text id per skill id, 0..254                          |
 * | `icon`         | 16x16 4bpp tiles, 128 bytes per skill id                    |
 * | `anime`        | `u32` animation pointer per skill id                        |
 * | `assignUnit`   | one `u8` skill id per **unit** id                           |
 * | `assignClass`  | one `u8` skill id per **class** id                          |
 * | `levelUpClass` | `u32` pointer list per class id -> `u16` learn entries       |
 * | `levelUpUnit`  | `u32` pointer list per unit id -> `u16` learn entries        |
 * A unit/class has **at most one** innate skill (one byte per id, 0 = none);
 * the rest are level-up lists.
 *
 * A learn entry is a `u16`: low byte level, high byte skill id
 * (`N1_InputFormRef` shows `u8(addr+1)` as skill, `u8(addr+0)` as level, block
 * size 2). With the class-skill *extension* the level byte carries flags:
 *     bits 0..4 level (0..31), bit 5 player-only, bit 6 enemy-only, bit 7 hard-only
 * (`SkillAssignmentClassSkillSystemForm.cs:887-893`; `IsClassSkillExtends` gates
 * them). Without the extension the byte is a plain level and all flags are
 * `false`.
 *
 * `0xFF` is a rule, not a level: upstream hides the bit panel and shows
 * `X_LV_255` (`SkillAssignmentClassSkillSystemForm.cs:865-880`), whose label
 * says the skill is innate only when LOADed directly into the class and is
 * *not* gained on promotion. So {@link SkillLearn.level} keeps `255` verbatim.
 *
 * Names come from the ROM text table (`Name:Description`), not config:
 * `SkillConfigSkillSystemForm.SkillTextToName` keeps everything before the first
 * `:` as {@link Skill.name}, the rest as {@link Skill.description} - the only
 * place a patch states what a skill does. With no `:` the config fallback
 * (`skill_extends_skillsystem_name_*`) is not ported, so `name` is empty and the
 * full string is in {@link Skill.text}.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import type {
  SkillPointers,
  Skill,
  SkillAssignment,
  SkillLearn,
  SkillReadResult,
} from "../model/snapshotRecords.ts";
import { hasClassSkillExtends, resolveSkillPointers } from "../rom/skillSystem.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextId, sanitizeText, stripAllCodes } from "../text/huffman.ts";

/** Upper bound on skill ids, from `SkillConfigSkillSystemForm.Init` (`i < 255`). */
const MAX_SKILLS = 255;

/** Upper bound on a learn list; upstream lints 20+ entries as suspicious. */
const MAX_LEARN_ENTRIES = 32;

export interface SkillReadOptions {
  rom: RomBuffer;
  /**
   * Which skill system the ROM carries. Only `SkillSystem` is decoded; every
   * other value (including `none`) returns `null`.
   */
  skillSystem: string;
  /**
   * Highest unit id the unit table carries, i.e. the per-unit tables' id
   * **cardinality** (`max(id) + 1`). Not the number of units read: the two
   * differ whenever the ids have a gap, and an id-indexed table must be read
   * to the id, not to the count.
   */
  unitCount: number;
  /** Same as {@link unitCount}, for the class table (`max(id) + 1`). */
  classCount: number;
  text: TextContext;
}

/**
 * `max(id) + 1` over a scanned table: the id cardinality an id-indexed table
 * must be indexed by.
 *
 * The array length is the wrong quantity. `readAllClasses` stops at the first
 * class id 0 (`ClassForm.Init`'s predicate) and `readAllUnits` at the table's
 * own end, so a length is "rows we happened to keep", while an assignment table
 * is indexed by the game's own id. The two agree only while the ids are
 * contiguous; with a gap the length undercounts, and every owner at or past the
 * gap is read at an offset unrelated to its id. No fixture here has a gap (both
 * ROMs read 128 classes with ids 0..127), so this is a bound that is right for
 * a reason, not a bug fix - neither fixture's output changes.
 *
 * Empty entries are excluded because class 0's reserved slot is a real row that
 * no assignment table indexes.
 */
export function idCardinality(
  rows: readonly { id: number; isEmpty: boolean }[],
): number {
  let max = -1;
  for (const row of rows) {
    if (row.isEmpty) continue;
    if (row.id > max) max = row.id;
  }
  return max + 1;
}

/** Decode a skill's text and apply upstream's `SkillTextToName` rule. */
function decodeSkillName(
  rom: RomBuffer,
  textId: number,
  text: TextContext,
): { text: string; name: string; description: string } {
  if (textId === 0) return { text: "", name: "", description: "" };
  const decoded = stripAllCodes(sanitizeText(decodeTextId(rom, textId, text)));
  const colon = decoded.indexOf(":");
  if (colon < 0) return { text: decoded, name: "", description: "" };
  return {
    text: decoded,
    name: decoded.slice(0, colon).trim(),
    description: decoded.slice(colon + 1).trim(),
  };
}

/**
 * One `u8` per owner: `u8(base + id)`, skipping zeros.
 *
 * `count` is the id cardinality the table is indexed by, not the number of
 * owners we scanned ({@link idCardinality}); the two differ on a table whose ids
 * have a gap.
 *
 * There is deliberately no "did I stop early?" probe: a byte past the table is
 * not distinguishable from an owner's entry. The class id space ends at 0xFE/0xFF
 * with both bytes 0xFF, and the neighbouring table follows immediately, so a
 * scan for non-zero bytes past `count` reports the next table's data as this
 * one's. A heuristic here would fire on a correct bound as readily as it would
 * catch a wrong one.
 */
function readAssignments(rom: RomBuffer, base: number, count: number): SkillAssignment[] {
  const out: SkillAssignment[] = [];
  for (let ownerId = 0; ownerId < count; ownerId++) {
    if (!rom.isSafeOffset(base + ownerId)) break;
    const skillId = rom.u8(base + ownerId);
    if (skillId !== 0) out.push({ ownerId, skillId });
  }
  return out;
}

/**
 * Decode a `u32`-per-owner pointer list into learn entries.
 *
 * `base` is the list's own offset (already dereferenced once). An owner whose
 * word is 0 or not a pointer has no learn list, which is normal.
 */
function readLearnLists(
  rom: RomBuffer,
  base: number,
  count: number,
  classSkillExtends: boolean,
): SkillLearn[] {
  const out: SkillLearn[] = [];
  for (let ownerId = 0; ownerId < count; ownerId++) {
    const word = base + ownerId * 4;
    if (!rom.isSafeOffset(word + 4)) break;
    const pointer = rom.u32(word);
    if (pointer === 0 || !rom.isSafePointer(pointer)) continue;
    const list = rom.toOffset(pointer);
    if (!rom.isSafeOffset(list)) continue;

    for (let position = 0; position < MAX_LEARN_ENTRIES; position++) {
      const at = list + position * 2;
      if (!rom.isSafeOffset(at + 2)) break;
      const entry = rom.u16(at);
      if (entry === 0 || entry === 0xffff) break;

      const rawLevel = entry & 0xff;
      const skillId = entry >> 8;
      out.push({
        ownerId,
        position,
        level: classSkillExtends ? rawLevel & 0x1f : rawLevel,
        skillId,
        rawLevel,
        playerOnly: classSkillExtends && (rawLevel & 32) === 32,
        enemyOnly: classSkillExtends && (rawLevel & 64) === 64,
        bothSides: classSkillExtends && (rawLevel & 96) === 96,
        hardOnly: classSkillExtends && (rawLevel & 128) === 128,
      });
    }
  }
  return out;
}

/**
 * Read every skill table, or `null` when the ROM has no decodable skill system.
 *
 * `null` means "this ROM has no skills", not "the parse failed" - a ROM without
 * the patch has no tables to read, and reporting empty arrays would blur the
 * two.
 */
export function readSkills(options: SkillReadOptions): SkillReadResult | null {
  const { rom, skillSystem, unitCount, classCount, text } = options;
  if (skillSystem !== "SkillSystem") return null;

  const pointers = resolveSkillPointers(rom);
  // The text table is what makes an assignment mean anything; without it the
  // ids are bare numbers, so treat an unresolved text slot as "no skills".
  if (pointers.text === null) return null;
  if (pointers.assignUnit === null && pointers.assignClass === null) return null;

  const classSkillExtends = hasClassSkillExtends(rom);

  const textBase = rom.p32(pointers.text);
  const skills: Skill[] = [];
  if (rom.isSafeOffset(textBase)) {
    for (let id = 0; id < MAX_SKILLS; id++) {
      const at = textBase + id * 2;
      if (!rom.isSafeOffset(at + 2)) break;
      const nameTextId = rom.u16(at);
      const { text: full, name, description } = decodeSkillName(rom, nameTextId, text);
      skills.push({ id, nameTextId, name, description, text: full });
    }
  }

  const unitBase = pointers.assignUnit === null ? null : rom.p32(pointers.assignUnit);
  const classBase = pointers.assignClass === null ? null : rom.p32(pointers.assignClass);
  const unitLearnBase = pointers.levelUpUnit === null ? null : rom.p32(pointers.levelUpUnit);
  const classLearnBase = pointers.levelUpClass === null ? null : rom.p32(pointers.levelUpClass);

  return {
    pointers,
    classSkillExtends,
    skills,
    unitSkills: unitBase === null ? [] : readAssignments(rom, unitBase, unitCount),
    classSkills: classBase === null ? [] : readAssignments(rom, classBase, classCount),
    unitLearns:
      unitLearnBase === null
        ? []
        : readLearnLists(rom, unitLearnBase, unitCount, classSkillExtends),
    classLearns:
      classLearnBase === null
        ? []
        : readLearnLists(rom, classLearnBase, classCount, classSkillExtends),
  };
}
