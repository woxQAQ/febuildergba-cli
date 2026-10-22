/**
 * Shared helpers for reading fixed-size record tables out of a ROM.
 *
 * A table is located by dereferencing its pointer slot (see
 * `data/layouts.ts` for why that dereference is mandatory) and then walking
 * `recordSize` bytes at a time.
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import { hex } from "../format.ts";
import type { TableLayout } from "../data/layouts.ts";
import { resolveTableSlot } from "../data/layouts.ts";
import type { WeaponLevels } from "../model/snapshotRecords.ts";
import { WEAPON_TYPES } from "../model/snapshotRecords.ts";

export interface ResolvedTable {
  /** File offset of the 4-byte slot holding the table pointer. */
  slotOffset: number;
  /** File offset of the table itself. */
  tableOffset: number;
  recordSize: number;
  maxCount: number;
}

export function resolveTable(rom: RomBuffer, layout: TableLayout): ResolvedTable {
  const slotOffset = resolveTableSlot(rom, layout.slot);
  const tableOffset = rom.p32(slotOffset);

  if (!rom.isSafeOffset(tableOffset)) {
    throw new Error(
      `Table pointer slot ${hex(slotOffset)} resolved to `
        + `${hex(tableOffset)}, which is outside the ROM.`,
    );
  }

  return {
    slotOffset,
    tableOffset,
    recordSize: layout.recordSize,
    maxCount: layout.maxCount,
  };
}

export function readWeaponLevels(rom: RomBuffer, addr: number): WeaponLevels {
  const levels = {} as WeaponLevels;
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    levels[WEAPON_TYPES[i]!] = rom.u8(addr + i);
  }
  return levels;
}
