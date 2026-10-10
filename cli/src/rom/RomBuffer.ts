/**
 * Binary reader for a GBA ROM, mirroring FEBuilderGBA's `ROM`/`U` helpers.
 * Mixing the two coordinate systems is the most common bug source here:
 *   - file offset - an index into the ROM byte array (e.g. 0x803D64);
 *   - GBA address - a pointer value stored in the ROM (0x08xxxxxx).
 * `u8/u16/u32` take a file offset; `p32/p32p` read a GBA address and return a
 * file offset. Reference: `Rom.cs` (`u8`/`u16`/`u32`/`p32`/`p32p`), `U.cs`
 * (`toOffset`/`isPointer`/`isSafetyOffset`).
 */

import { hex } from "../format.ts";

export const POINTER_BASE = 0x0800_0000;
export const POINTER_END = 0x0a00_0000;
export const NOT_FOUND = 0xffff_ffff;

/** FEBuilderGBA's `U.isSafetyOffset` also rejects anything at or above this. */
const SAFE_OFFSET_CEILING = 0x0200_0000;
const SAFE_OFFSET_FLOOR = 0x0000_0200;

export class RomBuffer {
  readonly data: Buffer;

  constructor(data: Buffer) {
    this.data = data;
  }

  get length(): number {
    return this.data.length;
  }

  // ---------------------------------------------------------------- raw reads

  private ensure(addr: number, size: number): void {
    if (!Number.isInteger(addr) || addr < 0 || addr + size > this.data.length) {
      throw new RangeError(
        `read out of range: addr=${hex(addr)} size=${size} ` + `romLength=${hex(this.data.length)}`,
      );
    }
  }

  u8(addr: number): number {
    this.ensure(addr, 1);
    return this.data[addr] as number;
  }

  /**
   * Signed 8-bit read. Needed for fields the game treats as signed: a unit's
   * per-unit base stats are signed deltas on top of the class base, so `0xFF`
   * means -1, not 255. Reading them unsigned silently turns every negative
   * adjustment into a huge bonus.
   */
  i8(addr: number): number {
    this.ensure(addr, 1);
    return this.data.readInt8(addr);
  }

  u16(addr: number): number {
    this.ensure(addr, 2);
    return this.data.readUInt16LE(addr);
  }

  u32(addr: number): number {
    this.ensure(addr, 4);
    return this.data.readUInt32LE(addr);
  }

  /** Signed 32-bit read. The Huffman tree uses the sign bit as a leaf marker. */
  i32(addr: number): number {
    this.ensure(addr, 4);
    return this.data.readInt32LE(addr);
  }

  // ------------------------------------------------------- pointer arithmetic

  static isPointer(value: number): boolean {
    return value >= POINTER_BASE && value < POINTER_END;
  }

  /**
   * GBA address -> file offset. Values that are already offsets pass through
   * untouched, which is what makes this safe to call on mixed input.
   * Reference: `U.toOffset` (U.cs:2206).
   */
  toOffset(value: number): number {
    if (value <= 1) return value;
    return RomBuffer.isPointer(value) ? value - POINTER_BASE : value;
  }

  /** File offset -> GBA address. Reference: `U.toPointer` (U.cs:2225). */
  toPointer(value: number): number {
    if (value <= 1) return value;
    return value < POINTER_BASE ? value + POINTER_BASE : value;
  }

  /** Reference: `U.isSafetyOffset` (U.cs:2921). */
  isSafeOffset(addr: number): boolean {
    return addr >= SAFE_OFFSET_FLOOR && addr < SAFE_OFFSET_CEILING && addr < this.data.length;
  }

  /** Reference: `U.isSafetyPointer` (U.cs:2927). */
  isSafePointer(value: number): boolean {
    return (
      value >= POINTER_BASE + SAFE_OFFSET_FLOOR &&
      value < POINTER_END &&
      value - POINTER_BASE < this.data.length
    );
  }

  // -------------------------------------------------------------- indirection

  /**
   * Dereference a pointer slot: read a GBA address at `slot` and convert it to
   * a file offset.
   *
   * This is how nearly every table in the ROM is reached. `RomInfo.*_pointer`
   * values in FEBuilderGBA are *slot* offsets, not table offsets — reading a
   * table without going through `p32` is the classic mistake.
   *
   * Out-of-range slots yield 0 rather than throwing, matching FEBuilderGBA.
   */
  p32(slot: number): number {
    if (!Number.isInteger(slot) || slot < 0 || slot + 4 > this.data.length) return 0;
    return this.toOffset(this.data.readUInt32LE(slot));
  }

  /** Double indirection: `p32(p32(slot))`. Used for the Huffman tree data base. */
  p32p(slot: number): number {
    return this.p32(this.p32(slot));
  }

  // ------------------------------------------------------------------ strings

  ascii(addr: number, len: number): string {
    this.ensure(addr, len);
    return this.data.subarray(addr, addr + len).toString("latin1");
  }

  bytes(addr: number, len: number): Buffer {
    this.ensure(addr, len);
    return this.data.subarray(addr, addr + len);
  }
}
