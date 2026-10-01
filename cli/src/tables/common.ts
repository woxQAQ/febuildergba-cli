/**
 * Shared helpers for reading fixed-size record tables out of a ROM.
 *
 * A table is located by dereferencing its pointer slot (see
 * `data/layouts.ts` for why that dereference is mandatory) and then walking
 * `recordSize` bytes at a time.
 */

import { RomBuffer } from '../rom/RomBuffer.ts';
import type { TableLayout } from '../data/layouts.ts';
import { resolveTableSlot } from '../data/layouts.ts';

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
      `Table pointer slot 0x${slotOffset.toString(16)} resolved to ` +
        `0x${tableOffset.toString(16)}, which is outside the ROM.`,
    );
  }

  return {
    slotOffset,
    tableOffset,
    recordSize: layout.recordSize,
    maxCount: layout.maxCount,
  };
}

/** The eight weapon types, in the order the ROM stores them. */
export const WEAPON_TYPES = [
  'sword',
  'lance',
  'axe',
  'bow',
  'staff',
  'anima',
  'light',
  'dark',
] as const;

export type WeaponType = (typeof WEAPON_TYPES)[number];

export type WeaponLevels = Record<WeaponType, number>;

export function readWeaponLevels(rom: RomBuffer, addr: number): WeaponLevels {
  const levels = {} as WeaponLevels;
  for (let i = 0; i < WEAPON_TYPES.length; i++) {
    levels[WEAPON_TYPES[i]!] = rom.u8(addr + i);
  }
  return levels;
}
