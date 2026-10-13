/**
 * The class-change branch table (CC分岐表): per class, the two promotion
 * targets the game's CC menu actually offers. FE8 only.
 *
 * `CCBranchForm.Init` builds its `InputFormRef` over
 * `Program.ROM.RomInfo.ccbranch_pointer` with block size 2, and every reader
 * takes the two columns as `u8(addr + 0)` / `u8(addr + 1)`
 * (`AddressList_SelectedIndexChanged`, `GetCCCount`, `UpdateClass`). `0` means
 * "no branch in that slot". The row count is the class table's own count
 * (`ClassForm.DataCount()`), so the array is dense over class ids - which is
 * why {@link readClassBranches} takes the extracted class ids and records one
 * row per class, zeros included.
 *
 * The class record's `+5` byte is NOT this table: it is the main-chain target
 * only (`WriteButton_Click` writes it as the CC3 patch's third branch). A hack
 * can therefore have `+5` links the menu never shows and branch targets `+5`
 * never mentions - both are stored, neither is derived from the other.
 *
 * `ccbranch2_pointer` (FE8U `0xCC7C8`) is this table + 1 with the thumb bit
 * set - the second column, used by the 見習い CC - so it adds no data of its
 * own and gets no column.
 *
 * Reference: `CCBranchForm.cs`, `ROMFE8U.cs:76`, `ROMFE8JP.cs:76`,
 * `ROMFE6JP/7U/7JP.cs` (all `0x0`).
 */

import type { ClassBranchLayout, GameLayout } from "../data/layouts.ts";
import { RomBuffer } from "../rom/RomBuffer.ts";
import type { ClassBranchEntry, ClassBranchTable } from "../model/snapshotRecords.ts";

/**
 * Read the branch table over the class ids the class-table scan kept.
 *
 * Returns `null` when the game has no table (FE6/FE7), when the slot does not
 * hold a usable pointer, or when no class id was supplied. An FE8 ROM whose
 * slot is unreadable gets a diagnostic from `parse()`: the game has the table,
 * so an empty `class_branches` would otherwise read as "nothing promotes".
 */
export function readClassBranches(
  rom: RomBuffer,
  layout: GameLayout,
  classIds: readonly number[],
): ClassBranchTable | null {
  const spec: ClassBranchLayout | null = layout.classBranch;
  if (spec === null) return null;
  if (!rom.isSafeOffset(spec.slot)) return null;

  const tableOffset = rom.p32(spec.slot);
  if (!rom.isSafeOffset(tableOffset)) return null;

  const entries: ClassBranchEntry[] = [];
  for (const classId of classIds) {
    if (classId >= spec.maxCount) break;
    const addr = tableOffset + classId * spec.recordSize;
    if (!rom.isSafeOffset(addr + spec.recordSize)) break;
    entries.push({
      classId,
      addr,
      branch1: rom.u8(addr),
      branch2: rom.u8(addr + 1),
    });
  }

  if (entries.length === 0) return null;

  return {
    slotOffset: spec.slot,
    tableOffset,
    recordSize: spec.recordSize,
    count: entries.length,
    entries,
  };
}
