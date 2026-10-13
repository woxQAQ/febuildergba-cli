/**
 * Magic-split patch detection: port of `MagicSplitUtil.SearchMagicSplitLow`
 * (MagicSplitUtil.cs:48). FEBuilderGBA recognises three families by a fixed
 * signature at a fixed offset, gated on version:
 *   FE8NMAGIC  FE8J  0x2a542  {30 1C}                 FE8N 魔力分離
 *   FE7UMAGIC  FE7U  0x68de0  {38 18 01 78}           FE7U 魔力分離
 *   FE8UMAGIC  FE8U  0x2bb44  {01 4B A5 F0 C1 FE}
 *   FE8UMAGIC  FE8U  0x17e5c  {01 4B B9 F0 35 FD}     2022年以降
 *
 * Detection answers *whether* and *which*, nothing more. A present family means
 * the game keeps magic out of the strength field - FE7U/FE8U in separate tables
 * (per-unit 2 bytes, per-class 4 bytes, located by `FE7UInit`/`FE8UInit`),
 * FE8N in the struct's unused bytes - so attack stats cannot be read as plain
 * FE8 values. Those tables are deliberately not resolved or decoded yet:
 * nothing consumes them, and `none` and a detected family are both recorded as
 * identification only, the same stance `skillSystem.ts` takes.
 */

import type { RomBuffer } from "./RomBuffer.ts";
import type { GameVersion } from "../model/game.ts";

/** A magic-split patch family, or `none`. Names match FEBuilderGBA's enum. */
export type MagicSplit = "FE8NMAGIC" | "FE7UMAGIC" | "FE8UMAGIC" | "none";

interface MagicSplitSignature {
  /** Upstream's `name`, reused as the reported value. */
  readonly name: Exclude<MagicSplit, "none">;
  /** The `ver` this signature belongs to. */
  readonly version: GameVersion;
  readonly addr: number;
  readonly signature: readonly number[];
}

/**
 * Every signature upstream checks, in its own order. Kept verbatim - `addr`
 * values are file offsets, not pointers.
 */
const SIGNATURES: readonly MagicSplitSignature[] = [
  { name: "FE8NMAGIC", version: "FE8J", addr: 0x2a_542, signature: [0x30, 0x1c] },
  { name: "FE7UMAGIC", version: "FE7U", addr: 0x68_de0, signature: [0x38, 0x18, 0x01, 0x78] },
  {
    name: "FE8UMAGIC",
    version: "FE8U",
    addr: 0x2b_b44,
    signature: [0x01, 0x4b, 0xa5, 0xf0, 0xc1, 0xfe],
  },
  // 魔力分離パッチ FE8U 2022年以降 - the second FE8U build, same family.
  {
    name: "FE8UMAGIC",
    version: "FE8U",
    addr: 0x17_e5c,
    signature: [0x01, 0x4b, 0xb9, 0xf0, 0x35, 0xfd],
  },
];

/**
 * Which magic-split patch this ROM carries, or `none`.
 *
 * Signatures for other versions are skipped rather than probed, for the same
 * reason as {@link detectSkillSystem}: a FE8U ROM cannot carry the FE8J patch,
 * and probing would only invite a coincidental match in unrelated data.
 */
export function detectMagicSplit(rom: RomBuffer, version: GameVersion | null): MagicSplit {
  if (version === null) return "none";
  for (const entry of SIGNATURES) {
    if (entry.version !== version) continue;
    if (rom.matches(entry.addr, entry.signature)) return entry.name;
  }
  return "none";
}
