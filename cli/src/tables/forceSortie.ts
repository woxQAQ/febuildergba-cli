/**
 * The forced-deployment ("強制出撃") table.
 *
 * FEBuilderGBA ships an editor for this (`EventForceSortieForm`) whose tooltip
 * reads 「必ず出撃しなければいけないユニットを設定します。」 - "set the units
 * that must always be deployed". That is the whole feature: a per-map list of
 * units the prep screen will not let you bench.
 *
 * ## The record layout, recovered from the ROM's own code
 *
 * The reference's `Init` only exposes two of the three fields
 * (`u16(addr)` and `u8(addr + 3)`), so the middle byte had to come from the
 * game itself. `IsCharacterForceDeployed` (`0x080953F0`) tail-calls
 * `IsCharacterForceDeployed_` (`0x08084800`), and disassembling the latter
 * gives every byte and both filters:
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
 * So a record is four bytes - `u16 unitId`, `u8 route`, `u8 mapId` - and a
 * unit is forced when **all three** of its filters match. `0xFF` in either
 * filter byte means "no constraint".
 *
 * The map id is a **map-setting index**, not a chapter number: that is what
 * `EventForceSortieForm`'s own label passes to
 * `MapSettingForm.GetMapNameAndANYFF`.
 *
 * ## The route byte
 *
 * `ChapterData + 0x1B` is the vanilla 編指定 field, which `asmmap_FE8.txt`
 * documents as `序盤=0x1, A編=0x2, F編=0x3`. In the Dream of Five fixture only
 * `0xFF`, `0x01` and `0x02` occur, and the `0x01` records point at maps on
 * *both* story routes - so the label cannot be taken to mean "pre-route-split".
 * {@link routeLabel} therefore reports the raw value alongside the vanilla
 * label rather than inventing a mapping.
 *
 * Reference: ROMFE8U.cs:95, EventForceSortieForm.cs, MainFormUtil.cs:2526,
 *            asmmap_FE8.txt (`IsCharacterForceDeployed` / `@ChapterData@1B`).
 */

import type { ForceSortieLayout, GameLayout } from "../data/layouts.ts";
import { hex } from "../format.ts";
import { RomBuffer } from "../rom/RomBuffer.ts";

/** Value of the route filter meaning "this record applies on every route". */
export const ROUTE_ANY = 0xff;

/** Value of the map filter meaning "this record applies on every map". */
export const MAP_ANY = 0xff;

/** The terminator of a `'terminator'`-style table (`u16(+0)`). */
export const FORCE_SORTIE_TERMINATOR = 0xffff;

/**
 * The vanilla labels for `ChapterData + 0x1B`, from `asmmap_FE8.txt`
 * (`@ChapterData@1B  byte  編指定 序盤=0x1,A編=0x2,F編=0x3`).
 *
 * These are hints only - see the module doc comment for why the fixture's
 * `0x01` records cannot actually mean "pre-split".
 */
export const ROUTE_LABELS: Readonly<Record<number, string>> = {
  1: "序盤",
  2: "A編",
  3: "F編",
};

export interface ForceSortieRecord {
  /** Position in the table. */
  index: number;
  /** File offset of the record. */
  addr: number;
  /** `+0`. The unit that must be deployed. */
  unitId: number;
  /** `+2`. `0xFF` = any route, otherwise must equal `ChapterData + 0x1B`. */
  route: number;
  /** `+3`. `0xFF` = any map, otherwise a map-setting index. */
  mapIndex: number;
}

export interface ForceSortieTable {
  /** File offset of the 4-byte slot holding the table pointer. */
  slotOffset: number;
  /** File offset of the table itself. */
  tableOffset: number;
  recordSize: number;
  count: number;
  /** How the end of the table was found. */
  termination: ForceSortieLayout["termination"];
  records: ForceSortieRecord[];
}

/** Human-readable route filter, e.g. `any` or `0x01 (序盤)`. */
export function routeLabel(route: number): string {
  if (route === ROUTE_ANY) return "any";
  const name = ROUTE_LABELS[route];
  return `${hex(route, 2)}${name === undefined ? "" : ` (${name})`}`;
}

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

/**
 * The records that apply to one map setting index.
 *
 * This mirrors the two filters `IsCharacterForceDeployed_` applies: the map
 * byte must be `0xFF` or equal `mapIndex`. The route byte cannot be checked
 * statically (it compares against a runtime value), so records are returned
 * regardless of their route filter and callers should surface
 * {@link ForceSortieRecord.route} when it is not `0xFF`.
 */
export function forcedUnitsForMap(
  table: ForceSortieTable | null,
  mapIndex: number,
): ForceSortieRecord[] {
  if (table === null) return [];
  return table.records.filter((r) => r.mapIndex === MAP_ANY || r.mapIndex === mapIndex);
}

/**
 * The records that apply to a unit on every map - i.e. entries whose map filter
 * is `0xFF`. These are the "this unit is always deployed" rows.
 */
export function alwaysForcedUnits(table: ForceSortieTable | null): ForceSortieRecord[] {
  if (table === null) return [];
  return table.records.filter((r) => r.mapIndex === MAP_ANY);
}
