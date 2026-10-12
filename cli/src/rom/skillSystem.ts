/**
 * Skill-system detection: port of `PatchUtil.SearchSkillSystemLow`
 * (PatchUtil.cs:180). FEBuilderGBA recognises six families by a fixed signature
 * at a fixed offset, gated on version:
 *   yugudora     FE8J  0x0EE594  {4B FA 2F 59}                        FE8N custom
 *   FE8N         FE8J  0x089268  {00 4B 9F 46}                        FE8N
 *   midori       FE8J  0xFE58E0  {05 1C 00 F0 25 F8 01 29 04 D0 ...}  early custom
 *   SkillSystem  FE8U  0x02ACF8  {70 47}                              FE8U patch
 *
 * Only `SkillSystem` is reachable: the three FE8J ones need Shift-JIS text
 * (`supported: false` in `data/layouts.ts`), so `loadRom` refuses those ROMs
 * first. They stay in the table so the port does not diverge from the reference.
 *
 * Deliberate gap: upstream refines `FE8N` into `ver2`/`ver3` by searching skill
 * icon pointer runs in `0xB00000..0xC00000`, which needs FE8J glyph tables, so
 * `FE8N` is reported as itself until FE8J lands.
 *
 * Detection answers *whether* and *which*; {@link resolveSkillPointers} locates
 * the five per-variant tables (`ASSIGN`/`LEVELUP`/`ICON`/`TEXT`/`ANIME`) by the
 * same search, and `tables/skills.ts` decodes them. Still missing: the FE8J-only
 * table shapes, the `FE8N` sub-version refinement, and the config-file
 * skill-name fallback.
 */

import type { RomBuffer } from "./RomBuffer.ts";
import type { GameVersion } from "../model/game.ts";
import type { SkillPointers } from "../model/snapshotRecords.ts";

/** A skill-system family, or `none`. Names match FEBuilderGBA's enum. */
export type SkillSystem = "SkillSystem" | "FE8N" | "yugudora" | "midori" | "none";

interface SkillSystemSignature {
  /** Upstream's `name`, reused as the reported value. */
  readonly name: Exclude<SkillSystem, "none">;
  /** The `VersionToFilename` fragment this signature belongs to. */
  readonly version: GameVersion;
  readonly addr: number;
  readonly signature: readonly number[];
}

/**
 * Every signature upstream checks, in its own order. Kept verbatim - `addr`
 * values are file offsets, not pointers.
 */
const SIGNATURES: readonly SkillSystemSignature[] = [
  { name: "yugudora", version: "FE8J", addr: 0x0ee_594, signature: [0x4b, 0xfa, 0x2f, 0x59] },
  { name: "FE8N", version: "FE8J", addr: 0x08_9268, signature: [0x00, 0x4b, 0x9f, 0x46] },
  {
    name: "midori",
    version: "FE8J",
    addr: 0xfe_58e0,
    signature: [
      0x05, 0x1c, 0x00, 0xf0, 0x25, 0xf8, 0x01, 0x29, 0x04, 0xd0, 0x28, 0x1c, 0x00, 0xf0, 0x28,
      0xf8,
    ],
  },
  // Two bytes: `bx lr`. Weak on its own, but this is the offset and the
  // signature the reference uses, and it is the only FE8U criterion there is.
  { name: "SkillSystem", version: "FE8U", addr: 0x02_acf8, signature: [0x70, 0x47] },
];

/** Byte-for-byte `U.memcmp`, returning false rather than throwing off the end. */
function matchesAt(rom: RomBuffer, addr: number, signature: readonly number[]): boolean {
  if (!rom.isSafeOffset(addr + signature.length)) return false;
  return signature.every((byte, i) => rom.u8(addr + i) === byte);
}

/**
 * Which skill system this ROM carries, or `none`.
 *
 * Signatures for other versions are skipped rather than probed: a FE8U ROM
 * cannot carry the FE8J patch, and probing would only invite a coincidental
 * match in unrelated data.
 */
export function detectSkillSystem(rom: RomBuffer, version: GameVersion | null): SkillSystem {
  if (version === null) return "none";
  for (const entry of SIGNATURES) {
    if (entry.version !== version) continue;
    if (matchesAt(rom, entry.addr, entry.signature)) return entry.name;
  }
  return "none";
}

// ------------------------------------------------------------- table lookup

/**
 * Port of `SkillConfigSkillSystemForm.FindSkillPointer`'s `SkillSystemsTableSt`
 * table (SkillConfigSkillSystemForm.cs:203), in upstream order.
 *
 * Each entry is a code signature; the **slot** holding the table pointer sits
 * `pattern.length + skip + callerSkip` bytes past the match. Upstream scans
 * `0xB00000..0xC00000` at 4-byte steps and returns the first entry - in this
 * order - whose computed slot reads as a valid pointer. Because the loop is
 * ordered, an entry with a shorter/looser signature can steal a match from a
 * later one, so the order is part of the format and is preserved verbatim.
 *
 * `FF FF FF FF` runs in `pattern` are wildcards (`MakeMaskData`), and
 * `LEVELUP` needs the extra check that the pointer's first three `u32` values
 * are pointers-or-null - upstream says older ROMs carry look-alike data.
 */
interface SkillPointerSignature {
  readonly type: SkillPointerType;
  /** Upstream's `skip`, added after the matched pattern. */
  readonly skip: number;
  /** Hex byte pattern; `FFFFFFFF` is a four-byte wildcard. */
  readonly pattern: string;
}

export type SkillPointerType = "ASSIGN" | "LEVELUP" | "ICON" | "TEXT" | "ANIME";

const SKILL_POINTER_SIGNATURES: readonly SkillPointerSignature[] = [
  { type: "ASSIGN", skip: 16, pattern: "01350236F1E700202870291C0248091A" },
  { type: "LEVELUP", skip: 16 + 8, pattern: "01350236F1E700202870291C0248091A" },
  { type: "ASSIGN", skip: 16, pattern: "291CFFF7FAFF011C08780028EFD00131FAE70000" },
  {
    type: "LEVELUP",
    skip: 0,
    pattern: "0AD01A78002A07D08A4201D00233F8E75A7822700134F9E70020207031BC7047",
  },
  { type: "ANIME", skip: 32, pattern: "002B00D1064B381C9E4600F805480047" },
  { type: "ICON", skip: 24, pattern: "0240094C054800470548004705480047" },
  {
    type: "ICON",
    skip: 8,
    pattern: "084204D11279AA4201D1012003E00134BF2CEADD002030BC02BC0847",
  },
  {
    type: "ICON",
    skip: 0,
    pattern:
      "3800FFFFFFFFFFFF80220E491648164BFFFFFFFFFFFF2B3429003800144BFFFFFFFFFFFF2670FFFFFFFFFFFF" +
      "00470133CDE7C046",
  },
  {
    type: "ICON",
    skip: 0,
    pattern:
      "380000F0FBF980220E491648164B00F0F5F92B3429003800144B00F0EFF92670F8BC01BC0047" +
      "0133CDE7C046",
  },
  { type: "TEXT", skip: 16, pattern: "0749400040180088002800D10648211C" },
  { type: "TEXT", skip: 16, pattern: "405D0849400040180088002800D10748211C4C31" },
  {
    type: "LEVELUP",
    skip: 0,
    pattern: "E458002C0CD02378002B09D08B4201DD934201DD0234F6E7637833700136F9E70020307071BC7047",
  },
  {
    type: "LEVELUP",
    skip: 0,
    pattern:
      "06DD143B8B4201DD934201DD0234EFE7637833700136F9E70B4C43681B799B00E458002C0CD0237800" +
      "2B09D08B4201DD934201DD0234F6E7637833700136F9E70020307071BC7047",
  },
  {
    type: "LEVELUP",
    skip: 0,
    pattern:
      "F0E7022B12D0032B06D10D484221415C202211420AD1E5E7042B06D108481421415C4022114201D1DC" +
      "E7DBE7637833700136D7E70020307006BCF1BC70470000F0BC0202",
  },
  { type: "ANIME", skip: 32, pattern: "002B00D1064B381C9E4600F805480047" },
  {
    type: "ANIME",
    skip: 16,
    pattern:
      "00D1331C0133381CFFFFFFFFFFFFF0BC11480047F0BC10480047F0BC1048004718476DA10508358A0508" +
      "000800000004000010E306088CE50608C4AE020855A10508",
  },
  {
    type: "ANIME",
    skip: 12,
    pattern: "9D2E0008358A0508000800000004000010E306088CE50608C4AE020855A10508",
  },
];

/** `IsClassSkillExtends`'s 64-byte probe (SkillConfigSkillSystemForm.cs:344). */
const CLASS_SKILL_EXTENDS_PATTERN =
  "F0E7022B12D0032B06D10D484221415C202211420AD1E5E7042B06D108481421415C4022114201D1DCE7" +
  "DBE7637833700136D7E70020307006BCF1BC70470000F0BC0202";

/** Upstream searches exactly this window, at 4-byte alignment. */
const SEARCH_START = 0xb0_0000;
const SEARCH_END = 0xc0_0000;

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * True for a `FF FF FF FF` run starting at `i` (`MakeMaskData`).
 *
 * Upstream builds its mask with `for (i = 0; i < len - 4; i++)`, so a wildcard
 * can never *start* in the last four bytes - the tail is always compared
 * literally. Reproduced exactly: a pattern ending in `FF FF FF FF` would
 * otherwise be treated more loosely than the reference treats it.
 */
function isWildcard(pattern: readonly number[], i: number): boolean {
  if (i + 4 >= pattern.length) return false;
  return (
    pattern[i] === 0xff &&
    pattern[i + 1] === 0xff &&
    pattern[i + 2] === 0xff &&
    pattern[i + 3] === 0xff
  );
}

/** First 4-aligned match in the window, or `-1`. Mirrors `U.GrepPatternMatch`. */
function findPattern(rom: RomBuffer, pattern: readonly number[]): number {
  const end = Math.min(SEARCH_END, rom.length);
  outer: for (let addr = SEARCH_START; addr + pattern.length <= end; addr += 4) {
    let i = 0;
    while (i < pattern.length) {
      if (isWildcard(pattern, i)) {
        i += 4;
        continue;
      }
      if (rom.u8(addr + i) !== pattern[i]) continue outer;
      i += 1;
    }
    return addr;
  }
  return -1;
}

/**
 * Resolve one `FindSkillPointer(type, callerSkip)` call.
 *
 * `callerSkip` is the second argument upstream's callers pass: 0 for the
 * personal/icon/text/anime slots, 4 for the class ones (the two slots sit 4
 * bytes apart and the same signature is matched once).
 */
function resolveSkillPointer(
  rom: RomBuffer,
  type: SkillPointerType,
  callerSkip: number,
): number | null {
  for (const entry of SKILL_POINTER_SIGNATURES) {
    if (entry.type !== type) continue;
    const pattern = hexBytes(entry.pattern);
    const found = findPattern(rom, pattern);
    if (found < 0) continue;

    const slot = found + pattern.length + entry.skip + callerSkip;
    if (!rom.isSafeOffset(slot + 4)) continue;
    const pointer = rom.u32(slot);
    if (!rom.isSafePointer(pointer)) continue;

    if (type === "LEVELUP") {
      // "昔のROMには紛らわしいデータがあるらしい" - the list must look like a
      // pointer list: its first three u32 words are pointers-or-null.
      const data = rom.toOffset(pointer);
      if (!rom.isSafeOffset(data + 12)) continue;
      const words = [rom.u32(data), rom.u32(data + 4), rom.u32(data + 8)];
      if (!words.every((w) => w === 0 || rom.isSafePointer(w))) continue;
    }
    return slot;
  }
  return null;
}

/**
 * Whether the ROM carries the class-skill **extension** patch, which is what
 * makes the level byte of a level-up entry carry the player/enemy/difficulty
 * flags. Without it a level byte is just a level (`SkillConfigSkillSystemForm.
 * IsClassSkillExtends`, SkillConfigSkillSystemForm.cs:334).
 */
export function hasClassSkillExtends(rom: RomBuffer): boolean {
  return findPattern(rom, hexBytes(CLASS_SKILL_EXTENDS_PATTERN)) >= 0;
}

/** Resolve every table pointer once. Cheap enough to call per extract. */
export function resolveSkillPointers(rom: RomBuffer): SkillPointers {
  return {
    icon: resolveSkillPointer(rom, "ICON", 0),
    text: resolveSkillPointer(rom, "TEXT", 0),
    anime: resolveSkillPointer(rom, "ANIME", 0),
    assignUnit: resolveSkillPointer(rom, "ASSIGN", 0),
    assignClass: resolveSkillPointer(rom, "ASSIGN", 4),
    levelUpClass: resolveSkillPointer(rom, "LEVELUP", 0),
    levelUpUnit: resolveSkillPointer(rom, "LEVELUP", 4),
  };
}
