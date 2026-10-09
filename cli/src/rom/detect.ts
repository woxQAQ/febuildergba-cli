/**
 * ROM identification.
 *
 * Reference: FEBuilderGBA/FEBuilderGBA/Rom.cs -> `ROM.Load()` / `ROM.LoadLow()`.
 */

import { RomBuffer } from "./RomBuffer.ts";
import { hex } from "../format.ts";
export type GameVersion = "FE6J" | "FE7J" | "FE7U" | "FE8J" | "FE8U";

/** FEBuilderGBA reads 6 bytes here: 4-byte game code + 2-byte maker code. */
export const GAME_CODE_OFFSET = 0xac;
export const GAME_CODE_LENGTH = 6;

/** Title field, purely informational. */
export const TITLE_OFFSET = 0xa0;
export const TITLE_LENGTH = 12;

const GAME_CODE_TO_VERSION: Readonly<Record<string, GameVersion>> = {
  AFEJ01: "FE6J",
  AE7J01: "FE7J",
  AE7E01: "FE7U",
  BE8J01: "FE8J",
  BE8E01: "FE8U",
};

/**
 * Minimum ROM size FEBuilderGBA requires before it will trust the game code.
 * Exported so a too-short file can be rejected with the number it missed by,
 * instead of failing later as a range error from some table read.
 */
export const MIN_ROM_SIZES: Readonly<Record<GameVersion, number>> = {
  FE6J: 0x0080_0000, // 8 MB
  FE7J: 0x0100_0000, // 16 MB
  FE7U: 0x0100_0000,
  FE8J: 0x0100_0000,
  FE8U: 0x0100_0000,
};

export interface RomIdentity {
  gameCode: string;
  title: string;
  version: GameVersion | null;
  sizeOk: boolean;
  size: number;
  /** Human-readable note about anything unusual, e.g. a size that is not a power of two. */
  notes: string[];
}

/** The ROM must at least contain the header we read. */
export const MIN_HEADER_SIZE = GAME_CODE_OFFSET + GAME_CODE_LENGTH;

export function readGameCode(rom: RomBuffer): string {
  return rom.ascii(GAME_CODE_OFFSET, GAME_CODE_LENGTH);
}

export function readTitle(rom: RomBuffer): string {
  return rom.ascii(TITLE_OFFSET, TITLE_LENGTH).replace(/\0+$/, "").trimEnd();
}

export function detectVersion(rom: RomBuffer): RomIdentity {
  // Bail out before `ascii()` can throw, so a truncated or non-ROM file gets a
  // readable message instead of a RangeError.
  if (rom.length < MIN_HEADER_SIZE) {
    return {
      gameCode: "",
      title: "",
      version: null,
      sizeOk: false,
      size: rom.length,
      notes: [
        `File is only ${rom.length} bytes; a GBA ROM header needs at least ` +
          `${MIN_HEADER_SIZE} (${hex(MIN_HEADER_SIZE)}).`,
      ],
    };
  }

  const gameCode = readGameCode(rom);
  const title = readTitle(rom);
  const version = GAME_CODE_TO_VERSION[gameCode] ?? null;
  const notes: string[] = [];

  let sizeOk = true;
  if (version) {
    const min = MIN_ROM_SIZES[version];
    sizeOk = rom.length >= min;
    if (!sizeOk) {
      notes.push(
        `ROM is ${rom.length} bytes but ${version} expects at least ${min} (${hex(min)}).`,
      );
    }
  } else {
    notes.push(`Unrecognised game code "${gameCode}" - no pointer layout available.`);
  }

  // Expanded ROMs are normal, but a non-power-of-two length is worth surfacing
  // because it usually means the file was trimmed or repacked.
  if ((rom.length & (rom.length - 1)) !== 0) {
    notes.push(`ROM length ${hex(rom.length)} is not a power of two (expanded/repacked ROM).`);
  }

  return { gameCode, title, version, sizeOk, size: rom.length, notes };
}
