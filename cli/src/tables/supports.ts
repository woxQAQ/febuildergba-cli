/**
 * Support relationships. There is **no** usable index: not ordered by unit id,
 * no fixed length. The only way in is the support pointer at unit record `+44`:
 *     unitAddress + 44 -> GBA pointer -> 24-byte support record
 * (`SupportUnitForm.cs:282`; the +44 convention is shared by FE6/FE7/FE8).
 *
 * Records happen to sit at a 24-byte stride in `dream-of-five.gba` (62 records,
 * 61 gaps all 0x18), but **do not rely on it**: ordering is not guaranteed and
 * unit id order does not match address order there (unit 1 -> 0x1AEF610, unit 2
 * -> 0x1AEF640, unit 3 -> 0x1AEF670, unit 4 -> 0x1AEF658). Stride indexing is
 * only safe after confirming the layout on the specific ROM.
 *
 * Record layout, 24 bytes:
 *   +0..6   u8 x7  partner unit ids (0 = empty)
 *   +7..13  u8 x7  initial support value per partner
 *   +14..20 u8 x7  support growth per partner
 *   +21     u8     declared partner count
 *   +22..23 u8 x2  padding
 * `SupportUnitForm.cs` bindings: partner *i* is `B{i}`, initial `B{7+i}`, growth
 * `B{14+i}`, count `B21`.
 *
 * Two things that bite:
 * 1. Supports are stored twice (A->B and B->A, both must agree); deduplicate
 *    before building a graph or every edge doubles.
 * 2. Trailing slots hold stale data; only non-zero partner ids are meaningful.
 *
 * Reference: FEBuilderGBA/FEBuilderGBA/SupportUnitForm.cs
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import type { Unit } from "./units.ts";
import { unitNameOrId } from "./units.ts";

export const SUPPORT_RECORD_SIZE = 24;

/** The ROM stores at most seven partners per unit. `SupportUnitForm.cs:322`. */
export const SUPPORT_LIMIT = 7;

export const SUPPORT_OFFSET = {
  partners: 0,
  initialValues: 7,
  growthValues: 14,
  declaredCount: 21,
} as const;

export interface SupportPartner {
  /** Partner unit id, 1-based. */
  unitId: number;
  unitName: string;
  /** Support points the pair starts with. */
  initial: number;
  /** Support points gained per turn spent adjacent. */
  growth: number;
}

export interface SupportEntry {
  unitId: number;
  unitName: string;
  /** File offset of this unit's support record. */
  address: number;
  /** Partner count recorded at +21. */
  declaredCount: number;
  /** Number of slots holding a non-zero partner id. Should equal `declaredCount`. */
  actualCount: number;
  countMatches: boolean;
  partners: SupportPartner[];
}

export interface SupportReadResult {
  entries: SupportEntry[];
  /** Units whose +44 slot did not hold a usable pointer. */
  missing: { unitId: number; unitName: string; rawPointer: number }[];
}

function readRecord(
  rom: RomBuffer,
  address: number,
  nameMap: ReadonlyMap<number, string>,
): SupportEntry | null {
  if (!rom.isSafeOffset(address) || address + SUPPORT_RECORD_SIZE > rom.length) {
    return null;
  }

  const partners: SupportPartner[] = [];
  let actualCount = 0;

  for (let i = 0; i < SUPPORT_LIMIT; i++) {
    const partnerId = rom.u8(address + SUPPORT_OFFSET.partners + i);
    if (partnerId === 0) continue;

    actualCount++;
    partners.push({
      unitId: partnerId,
      unitName: unitNameOrId(nameMap, partnerId),
      initial: rom.u8(address + SUPPORT_OFFSET.initialValues + i),
      growth: rom.u8(address + SUPPORT_OFFSET.growthValues + i),
    });
  }

  const declaredCount = rom.u8(address + SUPPORT_OFFSET.declaredCount);

  return {
    unitId: 0, // filled in by the caller, which knows the unit
    unitName: "",
    address,
    declaredCount,
    actualCount,
    countMatches: declaredCount === actualCount,
    partners,
  };
}

/**
 * Read the support record for every unit that has one.
 *
 * `units` should come from {@link readAllUnits}; the name map is used to label
 * partners.
 */
export function readSupports(
  rom: RomBuffer,
  units: readonly Unit[],
  nameMap: ReadonlyMap<number, string>,
): SupportReadResult {
  const entries: SupportEntry[] = [];
  const missing: SupportReadResult["missing"] = [];

  for (const unit of units) {
    if (unit.isEmpty) continue;

    if (!unit.hasSupportData) {
      if (unit.supportPointer !== 0) {
        missing.push({
          unitId: unit.id,
          unitName: unit.name,
          rawPointer: unit.supportPointer,
        });
      }
      continue;
    }

    const record = readRecord(rom, unit.supportAddress, nameMap);
    if (record === null) {
      missing.push({
        unitId: unit.id,
        unitName: unit.name,
        rawPointer: unit.supportPointer,
      });
      continue;
    }

    record.unitId = unit.id;
    record.unitName = unit.name.length > 0 ? unit.name : unitNameOrId(nameMap, unit.id);
    entries.push(record);
  }

  return { entries, missing };
}
