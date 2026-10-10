/**
 * Terrain names. The ROM has a table of **65** names indexed by terrain id - the
 * same id space the movement-cost table uses (`MoveCostForm` labels its 65 cost
 * columns `J_0..J_64` with these names), so id 0..0x40 lines up one-to-one.
 *
 * Two on-disk shapes; `MapTerrainNameForm.MakeList()` delegates to
 * `MapTerrainNameEngForm` when `!RomInfo.is_multibyte`:
 * | release        | stride | record contents             | terminator                  |
 * |----------------|--------|-----------------------------|-----------------------------|
 * | JP (multibyte) | 4      | GBA pointer to a raw string | `!U.isPointerOrNULL(u32(a))` |
 * | EN (single)    | 2      | text id                     | `u16(a) == 0`               |
 *
 * FE8U/FE7U are `is_multibyte = false` (ROMFE8U.cs:460, ROMFE7U.cs:451), so the
 * English path is what the fixture uses. The Japanese path is **raw Shift-JIS**
 * (read with `ROM.getString`, not the text table); with no SJIS decoder, those
 * records come back as raw bytes with `decoded: false`.
 *
 * Reference: `MapTerrainNameForm.cs`, `MapTerrainNameEngForm.cs`.
 */

import type { RomBuffer } from "../rom/RomBuffer.ts";
import type { TerrainNameLayout } from "../data/layouts.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextId, sanitizeName, stripAllCodes } from "../text/huffman.ts";

/** `U.isPointerOrNULL`: either 0 or a usable GBA pointer. */
function isPointerOrNull(value: number): boolean {
  return value === 0 || (value >= 0x0800_0000 && value < 0x0a00_0000);
}

export interface TerrainName {
  /** Terrain id, 0..0x40. Also the index into a class's movement-cost table. */
  id: number;
  /** Decoded name; `''` when the record is empty or undecodable. */
  name: string;
  /** Non-multibyte releases only: the text id the name was decoded from. */
  textId: number | null;
  /** Multibyte releases only: file offset of the raw string. */
  nameAddress: number | null;
  /** False when the name could not be decoded (Shift-JIS releases). */
  decoded: boolean;
  /** Raw bytes, always present - useful for the undecoded case. */
  raw: number[];
}

export interface TerrainTable {
  slotOffset: number;
  tableOffset: number;
  recordSize: number;
  isMultibyte: boolean;
  count: number;
}

export interface TerrainReadResult {
  table: TerrainTable | null;
  names: TerrainName[];
}

/**
 * Read the terrain-name table.
 *
 * `maxCount` is only a safety bound — the reference walks until the terminator
 * or the end of the ROM (`ROM.getBlockDataCount`).
 */
export function readTerrainNames(
  rom: RomBuffer,
  layout: TerrainNameLayout,
  text: TextContext,
): TerrainReadResult {
  const tableOffset = rom.p32(layout.slot);
  if (!rom.isSafeOffset(tableOffset)) {
    return { table: null, names: [] };
  }

  const isMultibyte = layout.recordSize === 4;
  const names: TerrainName[] = [];

  for (let id = 0; id < layout.maxCount; id++) {
    const addr = tableOffset + id * layout.recordSize;
    if (!rom.isSafeOffset(addr) || addr + layout.recordSize > rom.length) break;

    if (isMultibyte) {
      const pointer = rom.u32(addr);
      if (!isPointerOrNull(pointer)) break;

      const nameAddress = pointer === 0 ? 0 : rom.toOffset(pointer);
      let raw: number[] = [];
      if (nameAddress !== 0 && rom.isSafeOffset(nameAddress)) {
        // `ROM.getString` - a plain NUL-terminated byte string, NOT Huffman.
        const bytes: number[] = [];
        for (let i = 0; i < 0x40 && nameAddress + i < rom.length; i++) {
          const b = rom.u8(nameAddress + i);
          if (b === 0) break;
          bytes.push(b);
        }
        raw = bytes;
      }

      names.push({
        id,
        name: "",
        textId: null,
        nameAddress: nameAddress === 0 ? null : nameAddress,
        // No Shift-JIS decoder in this CLI yet; see the module doc.
        decoded: false,
        raw,
      });
      continue;
    }

    const textId = rom.u16(addr);
    if (textId === 0) break;

    const raw = Array.from(rom.bytes(addr, layout.recordSize));
    names.push({
      id,
      // Terrain names are single-line labels. Strip the `\x1F` bytes the Huffman
      // decoder leaves behind ("Forest\x1F") and the `@XXXX` escapes, which is
      // exactly what `MapTerrainNameForm.GetName` does via `StripAllCode`.
      name: stripAllCodes(sanitizeName(decodeTextId(rom, textId, text))),
      textId,
      nameAddress: null,
      decoded: true,
      raw,
    });
  }

  return {
    table: {
      slotOffset: layout.slot,
      tableOffset,
      recordSize: layout.recordSize,
      isMultibyte,
      count: names.length,
    },
    names,
  };
}

/**
 * Terrain ids whose appearance in-game is misleading, so FEBuilderGBA appends a
 * bracketed hint. `MapTerrainNameForm.MakeHint_Full`.
 *
 * The `0x20` / `0x0B` / `0x34` / `0x14` / `0x04` / `0x37` entries are only added
 * for non-multibyte ROMs ("英語版だと、empty Chestsの区別がないので追記する").
 */
export const TERRAIN_HINTS: Readonly<Record<number, string>> = {
  0x04: "closed village",
  0x0b: "castle gate",
  0x14: "drawbridge",
  0x18: "healing floor",
  0x1b: "breakable wall",
  0x20: "empty chest",
  0x2e: "fliers may pass",
  0x34: "log bridge",
  0x37: "ruins",
};

/** Ids whose hint is emitted for every release, not just the English ones. */
const ALWAYS_HINTS = new Set([0x18, 0x1b, 0x2e]);

export function terrainHint(id: number, isMultibyte: boolean): string {
  const hint = TERRAIN_HINTS[id];
  if (hint === undefined) return "";
  if (!ALWAYS_HINTS.has(id) && isMultibyte) return "";
  return `[${hint}]`;
}
