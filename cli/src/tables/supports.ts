/**
 * Support relationships.
 *
 * ## How this table is indexed
 *
 * There is **no** usable index for the support table. It is not ordered by unit
 * id and has no fixed length. The only way in is the support pointer stored at
 * **offset +44 of each unit record**:
 *
 *     unitAddress + 44 -> GBA pointer -> 24-byte support record
 *
 * (`SupportUnitForm.cs:282` notes this +44 convention is shared by FE6/FE7/FE8.)
 *
 * Records happen to be packed back to back at a 24-byte stride in
 * `dream-of-five.gba` (verified: 62 records, 61 gaps, all 0x18), but **do not
 * rely on that** - nothing guarantees the ordering, and unit id order does not
 * match address order there (unit 1 -> 0x1AEF610, unit 2 -> 0x1AEF640,
 * unit 3 -> 0x1AEF670, unit 4 -> 0x1AEF658). Indexing by stride is only safe
 * after you have confirmed the layout on the specific ROM.
 *
 * ## Record layout, 24 bytes
 *
 *   +0..6   u8 x7  partner unit ids   (0 = empty slot)
 *   +7..13  u8 x7  initial support value per partner
 *   +14..20 u8 x7  support growth per partner
 *   +21     u8     declared partner count
 *   +22..23 u8 x2  padding
 *
 * Bindings confirmed in `SupportUnitForm.cs`: partner *i* is `B{i}`, its
 * initial value is `B{7+i}`, its growth is `B{14+i}`, and the count is `B21`.
 *
 * ## Two things that bite
 *
 * 1. **Supports are stored twice.** A→B and B→A are separate records and both
 *    must agree. Deduplicate before building a graph or every edge doubles.
 * 2. **Trailing slots hold stale data.** Only entries whose partner id is
 *    non-zero are meaningful; values beyond that are leftovers from whoever
 *    authored the table and must be ignored.
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
