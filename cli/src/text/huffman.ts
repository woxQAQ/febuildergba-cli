/**
 * Fire Emblem GBA text decoding.
 *
 * Strings are Huffman-compressed. A text id indexes a table of string
 * pointers; each string is a bit stream walked through a binary tree stored in
 * the ROM.
 *
 * This is a line-by-line port of FEBuilderGBA's:
 *   - `FETextDecode.huffman_decode()`   (FETextDecode.cs:327)
 *   - `FETextDecode.append_string()`    (FETextDecode.cs:~214)
 *   - `FETextDecode.listbyte_to_string()` (FETextDecode.cs:~250)
 *   - `FETextEncode.RevConvertSPMoji()` (special-glyph post-processing)
 *
 * The control flow is deliberately kept close to the original rather than
 * "cleaned up": the tree walk has subtle state (`treeData` is only reset when a
 * leaf is hit) and several early-return-on-corruption paths that a naive
 * rewrite tends to get wrong.
 *
 * ## Limits
 *
 * Shift-JIS ROMs (FE6J, FE7J, FE8J) are not supported yet: their byte stream
 * has to be interpreted as SJIS pairs, and Node has no built-in SJIS codec.
 * `decodeTextId` throws a clear error for those instead of emitting mojibake.
 */

import { RomBuffer } from '../rom/RomBuffer.ts';
import type { TextLayout } from '../data/layouts.ts';

export interface TextContext {
  treeBase: number;
  treeDataBase: number;
  /** Base offset of the text-id -> string-pointer table. */
  textBase: number;
  useSjis: boolean;
}

/** Codes FEBuilderGBA renders as `@XXXX` instead of a character. */
function isEscapeCode(code: number, beforeCode: number): boolean {
  return (
    beforeCode === 0x0010 ||
    beforeCode === 0x0011 ||
    beforeCode === 0x0080 ||
    code <= 0x001f ||
    (code >= 0x0080 && code <= 0x0f00)
  );
}

/**
 * Port of `append_string`. Appends the byte(s) for `code` to `out`.
 * Escape codes are emitted as the literal ASCII text `@XXXX` (4 uppercase hex
 * digits), exactly as FEBuilderGBA does.
 */
function appendString(out: number[], code: number, beforeCode: number): void {
  if (code === 0x00) return;

  if (isEscapeCode(code, beforeCode)) {
    const escape = `@${code.toString(16).toUpperCase().padStart(4, '0')}`;
    for (let i = 0; i < escape.length; i++) out.push(escape.charCodeAt(i));
    return;
  }

  if ((code & 0xff00) <= 0) {
    out.push(code & 0xff);
    return;
  }

  // XXYY -> low byte first, matching the original's little-endian ordering.
  out.push(code & 0xff);
  out.push((code >> 8) & 0xff);
}

/**
 * Port of `huffman_decode`. Decodes the compressed string starting at `addr`.
 * Returns the raw byte stream (still containing `@XXXX` escapes).
 */
export function huffmanDecode(
  rom: RomBuffer,
  addr: number,
  ctx: TextContext,
): { bytes: number[]; byteLength: number } {
  const out: number[] = [];
  const romLength = rom.length;

  let treeData = ctx.treeDataBase;
  let beforeCode = 0;
  const addrStart = addr;

  if (!rom.isSafeOffset(addr)) {
    throw new Error(`huffmanDecode: string address 0x${addr.toString(16)} is not safe`);
  }
  if (!rom.isSafeOffset(ctx.treeBase)) {
    throw new Error(`huffmanDecode: broken mask_pointer -> 0x${ctx.treeBase.toString(16)}`);
  }
  if (!rom.isSafeOffset(ctx.treeDataBase)) {
    throw new Error(
      `huffmanDecode: broken mask_point_base_pointer -> 0x${ctx.treeDataBase.toString(16)}`,
    );
  }

  for (;;) {
    if (addr + 4 > romLength) {
      return { bytes: out, byteLength: addr - addrStart };
    }

    let word = rom.u32(addr);

    if (word === 0) {
      if (addr + 8 > romLength) {
        return { bytes: out, byteLength: addr - addrStart };
      }
      if (rom.u32(addr + 4) === 0) {
        // Two consecutive null words terminate the string.
        return { bytes: out, byteLength: addr - addrStart };
      }
    }

    addr++;

    for (let bitIndex = 7; bitIndex >= 0; bitIndex--) {
      const treeAddr = treeData + (word & 1) * 2;
      if (treeAddr + 2 > romLength) {
        return { bytes: out, byteLength: addr - addrStart };
      }

      const child = rom.u16(treeAddr);
      treeData = ctx.treeBase + child * 4;
      word >>>= 1;

      if (treeData + 4 > romLength) {
        return { bytes: out, byteLength: addr - addrStart };
      }

      const node = rom.u32(treeData);
      // High bit clear => internal node, keep walking without resetting.
      if ((node & 0x8000_0000) === 0) continue;

      // Leaf. Reset the tree cursor for the next character.
      treeData = ctx.treeDataBase;

      const code = node & 0xffff;
      if (code <= 0 || (code & 0xff) === 0) {
        return { bytes: out, byteLength: addr - addrStart };
      }

      if (
        ctx.useSjis ||
        beforeCode === 0x10 ||
        beforeCode === 0x80 ||
        (code & 0xff00) >= 0x8100 ||
        (code & 0xff00) === 0x0000 ||
        (code & 0xff00) === 0x1f00
      ) {
        appendString(out, code, beforeCode);
        beforeCode = code;
      } else {
        appendString(out, code & 0xff, beforeCode);
        beforeCode = code & 0xff;

        const nextCode = (code >> 8) & 0xff;
        appendString(out, nextCode, beforeCode);
        beforeCode = nextCode;
      }
    }
  }
}

// --------------------------------------------------------------- un-huffman
//
// Some hacks store strings *uncompressed*. The text table is unchanged - still
// one 4-byte entry per id - but the pointer has 0x80000000 added to it, which
// lands it in 0x88000000..0x8A000000. That range is outside GBA address space,
// so it can never be confused with a normal pointer and acts as a tag.
//
// Because the bytes are plain, they are NOT a Huffman bit stream: they are
// decoded by a variable-length byte walk instead.
//
// Reference: FETextEncode.IsUnHuffmanPatchPointer / ConvertUnHuffmanPatchToPointer,
//            FETextDecode.UnHffmanPatchDecode / UnHffmanPatchDecodeLow.

/** `FETextEncode.IsUnHuffmanPatchPointer`. */
export function isUnHuffmanPatchPointer(pointer: number): boolean {
  return pointer >= 0x8800_0000 && pointer <= 0x8a00_0000;
}

/** `FETextEncode.ConvertUnHuffmanPatchToPointer`: strips the 0x80000000 tag. */
export function convertUnHuffmanPatchToPointer(pointer: number): number {
  if (!isUnHuffmanPatchPointer(pointer)) return pointer;
  return (pointer - 0x8000_0000) >>> 0;
}

/** `U.IsEnglishSPCode`: bytes the English builds use for single-byte glyphs. */
function isEnglishSpCode(code: number): boolean {
  return (
    code >= 0x81 ||
    code === 0x1f ||
    code === 0x7b ||
    code === 0x7c ||
    code === 0x7d ||
    code === 0x7f
  );
}

/** `U.isSJIS1stCode`. */
function isSjis1stCode(c: number): boolean {
  return (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc);
}

/** `U.isSJIS2ndCode`. */
function isSjis2ndCode(c: number): boolean {
  return (c >= 0x40 && c <= 0x7e) || (c >= 0x80 && c <= 0xfc);
}

/** `AppendAtmarkCode`: pushes the literal ASCII text `@XXXX`. */
function appendAtmarkCode(out: number[], code: number): void {
  out.push(0x40); // '@'
  const hex = (code >>> 0).toString(16).toUpperCase().padStart(4, '0');
  for (let i = 0; i < hex.length; i++) out.push(hex.charCodeAt(i));
}

/**
 * Port of `UnHffmanPatchDecodeLow` for Latin-1 (non-multibyte) ROMs.
 *
 * The UTF8 / SJIS-2-byte branches of the original are only reachable when the
 * ROM's `PriorityCode` is UTF8 or SJIS; for an English build it is LAT1, so
 * `AppendSJIS` degenerates to "an English SP code consumes exactly one byte".
 */
function unHuffmanPatchDecodeLow(src: Buffer): number[] {
  const out: number[] = [];
  const length = src.length;
  let i = 0;

  while (i < length) {
    const code = src[i] as number;

    if (length > i + 1) {
      const code2 = src[i + 1] as number;

      if (isSjis1stCode(code) && isSjis2ndCode(code2)) {
        // `AppendSJIS` under LAT1 priority: `IsEnglishSPCode(code)` is always
        // true here (it accepts everything >= 0x81), so one byte is consumed.
        appendAtmarkCode(out, code);
        i += 1;
        continue;
      }

      if (code === 0x80) {
        appendAtmarkCode(out, code); // @0080
        appendAtmarkCode(out, code2);
        i += 2;
        continue;
      }

      if (code === 0x10) {
        if (length <= i + 2) {
          // Not enough room for the 3-byte form: emit it raw.
          out.push(code);
          out.push(code2);
          i += 2;
          continue;
        }
        const code3 = src[i + 2] as number;
        const code23 = ((code3 << 8) | (code2 & 0xff)) >>> 0;
        appendAtmarkCode(out, code); // @0010
        appendAtmarkCode(out, code23); // @0102
        i += 3;
        continue;
      }
    }

    if (code < 0x20 || code === 0x40) {
      appendAtmarkCode(out, code);
      i += 1;
      continue;
    }

    if (isEnglishSpCode(code)) {
      appendAtmarkCode(out, code);
      i += 1;
      continue;
    }

    // Ordinary character.
    out.push(code);
    i += 1;
  }

  return out;
}

/**
 * Port of `UnHffmanPatchDecode`. Reads the null-terminated plain string at
 * `addr` and walks it with {@link unHuffmanPatchDecodeLow}.
 */
export function unHuffmanPatchDecode(
  rom: RomBuffer,
  addr: number,
): { bytes: number[]; byteLength: number } {
  if (!rom.isSafeOffset(addr)) return { bytes: [], byteLength: 0 };

  // `getBlockDataCount(addr, 1, (i, p) => u8(p) != 0)`: run of non-zero bytes.
  let length = 0;
  while (addr + length + 1 <= rom.length && rom.u8(addr + length) !== 0) length++;
  if (length <= 0) return { bytes: [], byteLength: 0 };

  let byteLength: number;
  if (rom.isSafeOffset(addr + length + 2) && rom.u8(addr + length + 2) === 0x00) {
    // The anti-huffman patch stacks two nulls.
    byteLength = length + 2;
  } else if (rom.isSafeOffset(addr + length + 1)) {
    byteLength = length + 1;
  } else {
    byteLength = length;
  }

  return { bytes: unHuffmanPatchDecodeLow(rom.bytes(addr, length)), byteLength };
}

/**
 * The **raw** byte run of an un-huffman string at `addr`, before the `@XXXX`
 * mangling {@link unHuffmanPatchDecodeLow} applies.
 *
 * Needed by callers that supply their own alphabet. The FE8 item-name font is
 * exactly that case: those bytes are not ASCII and not escapes, they are glyph
 * codes for a font the editor does not know. See `text/itemFont.ts`.
 */
export function unHuffmanRawBytes(rom: RomBuffer, addr: number, limit = 0x100): number[] {
  const out: number[] = [];
  let p = addr;
  while (p < rom.length && out.length < limit && rom.u8(p) !== 0) {
    out.push(rom.u8(p));
    p++;
  }
  return out;
}

/**
 * The Latin-1 code points FEBuilderGBA round-trips through `@00XX` escapes for
 * non-multibyte ROMs. Transcribed from `FETextEncode.MakeRepalceSPCode()`.
 * Because each escape's hex digits equal the code point, the mapping is
 * `@00XX -> String.fromCharCode(0xXX)`.
 */
const LATIN1_ESCAPE_CODEPOINTS = new Set<number>([
  0xa1, 0xaa, 0xab, 0xbb, 0xbf, 0xc0, 0xc1, 0xc2, 0xc4, 0xc7, 0xc8, 0xc9, 0xca,
  0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xd1, 0xd2, 0xd3, 0xd4, 0xd6, 0xd9, 0xda, 0xdb,
  0xdc, 0xdf, 0xe0, 0xe1, 0xe2, 0xe4, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed,
  0xee, 0xef, 0xf1, 0xf2, 0xf3, 0xf4, 0xf6, 0xf9, 0xfa, 0xfb, 0xfc,
]);

/**
 * Port of `RevConvertSPMoji`. Turns `@0001` into a newline and restores the
 * accented Latin-1 characters that were escaped. Other `@XXXX` control codes
 * are preserved verbatim so callers can still see them.
 */
export function applySpecialGlyphs(text: string): string {
  return text.replace(/@([0-9A-Fa-f]{4})/g, (match, hex: string) => {
    const code = parseInt(hex, 16);
    if (code === 0x0001) return '\n';
    if (code <= 0xff && LATIN1_ESCAPE_CODEPOINTS.has(code)) {
      return String.fromCharCode(code);
    }
    return match;
  });
}

/**
 * Strip control characters that survive decoding.
 *
 * Strings routinely end with a stray control byte. When a Huffman code lands in
 * the `(code & 0xFF00) == 0x1F00` range the decoder emits it as a *raw* byte
 * rather than an `@XXXX` escape, so `applySpecialGlyphs` cannot remove it -
 * "Paladin" decodes to `Paladin\x1F`. FEBuilderGBA leaves that byte in place
 * too; for display we drop it.
 *
 * Also collapses runs of whitespace and trims.
 */
export function sanitizeName(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Like {@link sanitizeName} but keeps line breaks, for multi-line descriptions. */
export function sanitizeText(text: string): string {
  return text
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Port of `TextForm.StripAllCode` (TextForm.cs:1262): drop every `@XXXX`
 * control escape and trim the padding characters the game uses.
 *
 * This is what FEBuilderGBA calls on terrain names before showing them
 * (`MapTerrainNameForm.GetName`), so a name whose decoded form ends in a
 * control escape - e.g. the healing-floor tile, which decodes to
 * `Runes@001F` - reads as just `Runes`.
 */
export function stripAllCodes(text: string): string {
  return text
    .replace(/@([0-9A-Fa-f]{4})/g, '')
    .replace(/^[\s\u001f\u3000]+|[\s\u001f\u3000]+$/g, '');
}

/**
 * A name ready to show: {@link sanitizeName} then {@link stripAllCodes}.
 *
 * This is the combination FEBuilderGBA uses for every name it puts in a list -
 * e.g. `StatusUnitsMenuForm.GetNameFast` returns
 * `TextForm.DirectAndStripAllCode(textid)`. It matters on real data: 17 unit
 * names in `dream-of-five.gba` decode with a trailing `@001F` escape, and a
 * roster keyed on `"Franseza@001F"` is a roster keyed on noise.
 *
 * Chapter titles are deliberately *not* put through this - the map-title
 * classifier keys on the literal `@001F` to spot the world-map encounter
 * entries, so stripping there would erase the distinction.
 */
export function displayName(text: string): string {
  return stripAllCodes(sanitizeName(text));
}

/**
 * Convert a decoded byte stream to a string.
 *
 * For Latin-1 ROMs the escape sequences were pushed as plain ASCII bytes, so a
 * latin1 decode round-trips them correctly. Shift-JIS ROMs would need a real
 * SJIS codec here.
 */
export function bytesToString(bytes: number[], useSjis: boolean): string {
  if (useSjis) {
    throw new Error(
      'Shift-JIS text decoding is not implemented. Only Latin-1 (English) ROMs ' +
        'are supported for now.',
    );
  }
  return Buffer.from(bytes).toString('latin1');
}

/** Build the decoding context for a ROM from its layout. */
export function makeTextContext(rom: RomBuffer, layout: TextLayout): TextContext {
  const treeBase = rom.p32(layout.maskPointer);
  const treeDataBase = rom.p32p(layout.maskPointBasePointer);

  let textBase = rom.p32(layout.textPointer);
  if (!rom.isSafeOffset(textBase)) {
    // Some hacks clobber the text pointer; FEBuilderGBA falls back to a fixed
    // offset recorded per game.
    textBase = layout.textRecoverAddress;
  }

  return {
    treeBase,
    treeDataBase,
    textBase,
    useSjis: layout.isMultibyte,
  };
}

/**
 * Decode a text id into a display string.
 *
 * Returns `''` for ids that are out of range or point nowhere, matching
 * FEBuilderGBA's behaviour of yielding an empty string rather than failing.
 *
 * Reference: `FETextDecode.Decode()` (FETextDecode.cs:~46).
 */
export function decodeTextId(rom: RomBuffer, id: number, ctx: TextContext): string {
  return applySpecialGlyphs(decodeTextIdRaw(rom, id, ctx));
}

/**
 * Same as {@link decodeTextId} but leaves `@XXXX` control codes unexpanded.
 * Useful when you need to see what the ROM actually encoded.
 */
export function decodeTextIdRaw(rom: RomBuffer, id: number, ctx: TextContext): string {
  // FE7 stores a few strings (song titles) as raw addresses rather than ids.
  if (rom.isSafePointer(id)) {
    return bytesToString(cString(rom, rom.toOffset(id)), ctx.useSjis);
  }

  if (id >= 0x7fff) return '';

  const entry = ctx.textBase + id * 4;
  if (!rom.isSafeOffset(entry)) return '';

  return decodeTextPointerRaw(rom, rom.u32(entry), ctx);
}

/**
 * Decode a *text-table entry value* (a pointer, possibly un-huffman tagged).
 * Split out from {@link decodeTextIdRaw} so `analysis` code can reuse it.
 *
 * Reference: `FETextDecode.DecodeAddr()`.
 */
export function decodeTextPointerRaw(
  rom: RomBuffer,
  pointer: number,
  ctx: TextContext,
): string {
  if (isUnHuffmanPatchPointer(pointer)) {
    const addr = rom.toOffset(convertUnHuffmanPatchToPointer(pointer));
    const { bytes } = unHuffmanPatchDecode(rom, addr);
    return bytesToString(bytes, ctx.useSjis);
  }

  if (!RomBuffer.isPointer(pointer)) return '';

  const { bytes } = huffmanDecode(rom, rom.toOffset(pointer), ctx);
  return bytesToString(bytes, ctx.useSjis);
}

/** `FETextDecode.CString`: a plain null-terminated string at a file offset. */
function cString(rom: RomBuffer, addr: number): number[] {
  const out: number[] = [];
  let p = addr;
  while (p < rom.length && rom.u8(p) !== 0) {
    out.push(rom.u8(p));
    p++;
  }
  return out;
}

/** Which storage format a text-table entry uses. */
export type TextPointerKind = 'huffman' | 'unhuffman' | 'direct' | 'invalid';

/** Classify a text-table entry value without decoding it. */
export function classifyTextPointer(pointer: number): TextPointerKind {
  if (isUnHuffmanPatchPointer(pointer)) return 'unhuffman';
  if (RomBuffer.isPointer(pointer)) return 'huffman';
  return 'invalid';
}

export interface DecodedText {
  /** Display form: `@XXXX` escapes expanded, newlines as `\n`. */
  text: string;
  /** Verbatim decoder output, escapes intact. Useful when diagnosing. */
  raw: string;
  kind: TextPointerKind;
}

/**
 * Like {@link decodeTextId} but also reports which storage format was used.
 * Hacks mix the two freely, so "why is this name empty?" is usually answered by
 * looking at `kind`.
 */
export function decodeTextIdDetailed(
  rom: RomBuffer,
  id: number,
  ctx: TextContext,
): DecodedText {
  if (rom.isSafePointer(id)) {
    const raw = bytesToString(cString(rom, rom.toOffset(id)), ctx.useSjis);
    return { text: applySpecialGlyphs(raw), raw, kind: 'direct' };
  }

  if (id >= 0x7fff) return { text: '', raw: '', kind: 'invalid' };

  const entry = ctx.textBase + id * 4;
  if (!rom.isSafeOffset(entry)) return { text: '', raw: '', kind: 'invalid' };

  const pointer = rom.u32(entry);
  const raw = decodeTextPointerRaw(rom, pointer, ctx);
  return { text: applySpecialGlyphs(raw), raw, kind: classifyTextPointer(pointer) };
}
