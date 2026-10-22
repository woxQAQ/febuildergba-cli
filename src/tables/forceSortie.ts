/**
 * The forced-deployment (強制出撃) table: a per-map list of units the prep screen
 * will not let you bench (`EventForceSortieForm` tooltip
 * 「必ず出撃しなければいけないユニットを設定します。」).
 *
 * The reference's `Init` exposes only `u16(addr)` and `u8(addr + 3)`, so the
 * middle byte comes from the ROM: `IsCharacterForceDeployed` (`0x080953F0`)
 * tail-calls `IsCharacterForceDeployed_` (`0x08084800`):
 *
 * ```asm
 * 08084802  lsls r0, r0, #0x10
 * 08084804  lsrs r4, r0, #0x10      ; r4 = the unit id being tested
 * 08084806  ldr  r2, [pc, #0x34]    ; r2 = the table (slot dereferenced)
 * 08084808  ldrh r0, [r2]           ; +0  unit id
 * 0808480A  ldr  r1, [pc, #0x34]    ; r1 = 0xFFFF
 * 0808480C  cmp  r0, r1
 * 0808480E  beq  -> return 0        ;     end of table
 * 08084810  ldr  r3, [pc, #0x30]    ; r3 = @ChapterData (0x0202BCF0)
 * 08084814  ldrb r0, [r2, #2]       ; +2  route filter
 * 08084816  cmp  r0, #0xff
 * 08084818  beq  -> skip route test  ;     0xFF = any route
 * 0808481A  ldrb r1, [r3, #0x1b]    ;     ChapterData+0x1B = 編指定
 * 0808481C  cmp  r0, r1
 * 0808481E  bne  -> next record
 * 08084820  ldrb r0, [r2, #3]       ; +3  map filter
 * 08084822  cmp  r0, #0xff
 * 08084824  beq  -> skip map test    ;     0xFF = any map
 * 08084826  movs r0, #0xe
 * 08084828  ldrsb r0, [r3, r0]      ;     ChapterData+0x0E = マップID
 * 0808482C  cmp  r1, r0
 * 0808482E  bne  -> next record
 * 08084830  ldrh r0, [r2]           ;     the unit id must match too
 * 08084832  cmp  r4, r0
 * 08084834  bne  -> next record
 * 08084836  movs r0, #1              ;     forced
 * ```
 *
 * A record is `u16 unitId`, `u8 route`, `u8 mapId`; a unit is forced when all
 * three match, `0xFF` in either filter meaning "no constraint". The map id is a
 * **map-setting index**, not a chapter number - what `EventForceSortieForm`'s
 * label passes to `MapSettingForm.GetMapNameAndANYFF`.
 *
 * `ChapterData + 0x1B` is 編指定 (`asmmap_FE8.txt`: `序盤=0x1, A編=0x2, F編=0x3`).
 * In the Dream of Five fixture only `0xFF`/`0x01`/`0x02` occur, and the `0x01`
 * records point at maps on *both* story routes, so the byte is stored raw; the
 * vanilla labels are reader hints, not a mapping.
 *
 * Reference: `ROMFE8U.cs:95`, `EventForceSortieForm.cs`, `MainFormUtil.cs:2526`,
 * `asmmap_FE8.txt`.
 */

import type { GameLayout } from "../data/layouts.ts";
import { RomBuffer } from "../rom/RomBuffer.ts";
import type { ForceSortieRecord, ForceSortieTable } from "../model/snapshotRecords.ts";

/** The terminator of a `'terminator'`-style table (`u16(+0)`). */
export const FORCE_SORTIE_TERMINATOR = 0xffff;

/**
 * Read the forced-deployment table.
 *
 * Returns `null` when the layout has no table (FE6), when the slot does not
 * hold a usable pointer, or when the first record is already the terminator.
 */
export function readForceSortie(
  rom: RomBuffer,
  layout: GameLayout,
  maxCount = 0x400,
): ForceSortieTable | null {
  const spec = layout.forceSortie;
  if (spec === null) return null;
  if (!rom.isSafeOffset(spec.slot)) return null;

  const tableOffset = rom.p32(spec.slot);
  if (!rom.isSafeOffset(tableOffset)) return null;

  const records: ForceSortieRecord[] = [];
  const limit = spec.termination === "fixed" ? (spec.count ?? 0) : maxCount;

  for (let i = 0; i < limit; i++) {
    const addr = tableOffset + i * spec.recordSize;
    if (!rom.isSafeOffset(addr + spec.recordSize)) break;

    const unitId = rom.u16(addr);
    if (spec.termination === "terminator" && unitId === FORCE_SORTIE_TERMINATOR) break;

    records.push({
      index: i,
      addr,
      unitId,
      route: rom.u8(addr + 2),
      mapIndex: spec.termination === "fixed" ? (spec.mapIdBase ?? 0) + i : rom.u8(addr + 3),
    });
  }

  if (records.length === 0) return null;

  return {
    slotOffset: spec.slot,
    tableOffset,
    recordSize: spec.recordSize,
    count: records.length,
    termination: spec.termination,
    records,
  };
}
