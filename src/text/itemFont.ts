/**
 * FE8's **item-name font** (`RomInfo.font_item_address`, FE8U `0x58c7ec`), the
 * dedicated inventory-item font (「アイテム名とかに使われるフォント」, routine
 * `0x08004504`). Its strings are their own code space - neither ASCII nor
 * Huffman. `dream-of-five.gba` stores them un-compressed (anti-Huffman patch), so
 * text id 852 is the raw bytes
 *
 * ```text
 * 49 8f 8c 8b bc ad 77 8c 8f 84        ->  "Iron Sword"
 * ```
 *
 * FEBuilderGBA has no table for this font and prints those as
 * `@008F@008C@008B@00BC@00ADw@008C@008F@0084`; the bytes need only this alphabet.
 *
 * The mapping is **empirical** (the ROM has no code->char table; a scan comes
 * back empty), built from the item table: the first seven entries pin `a b c d e
 * i l m n o r S t v w`; `Rapier`, `Runesword`, `Lancereaver`, `Killing Edge`,
 * `Bolting`, `Berserk` (`0x8A=k`), `Elixir`, `Lockpick` (`0x8E=q`), `Mioritza`
 * (`0x9A=z`), `Authority`, `Parzifal`, `Veritas`, `Wyrmslayer` (`0x99=y`,
 * `0x90=s`) fill the rest.
 *
 * Codes `< 0x80` are **plain ASCII** - exactly the letters with no separate
 * glyph (`I M N T W i l m w`); everything else is `0x80`-`0xBC`, with `0xBC` the
 * space. `0xA1`, `0xA9`-`0xAB`, `0xB0`, `0xB1`, the `0x91`-`0x94` gap and
 * `0xB2 = Z` (`… U V [W=ASCII] X Y Z`, corroborated by item #177
 * `<0xB2>almoxis` = Zalmoxis) are **inferred from the ordering**, not observed;
 * treat as provisional.
 *
 * Reference: `ROMFE8U.cs:235 font_item_address`, `FontForm.GetFontPointer`,
 * `FETextDecode.UnHffmanPatchDecodeLow`.
 */

/** Bytes `< 0x20` and `0x7F` never appear inside an item name; they end one. */
const TERMINATORS = new Set([0x1f]);

/**
 * Item-font code -> character, for codes that are not plain ASCII.
 *
 * The `?`-marked entries are inferred from the alphabet's order.
 */
export const ITEM_FONT: Readonly<Record<number, string>> = {
  // lowercase
  0x81: "a",
  0x82: "b",
  0x83: "c",
  0x84: "d",
  0x85: "e",
  0x86: "f",
  0x87: "g",
  0x88: "h",
  0x89: "j", // inferred (i is ASCII 0x69)
  0x8a: "k",
  0x8b: "n",
  0x8c: "o",
  0x8d: "p",
  0x8e: "q",
  0x8f: "r",
  0x90: "s",
  0x95: "t",
  0x96: "u",
  0x97: "v",
  0x98: "x",
  0x99: "y",
  0x9a: "z",
  // uppercase
  0x9b: "A",
  0x9c: "B",
  0x9d: "C",
  0x9e: "D",
  0x9f: "E",
  0xa0: "F",
  0xa2: "G",
  0xa3: "H",
  0xa4: "J",
  0xa5: "K",
  0xa6: "L",
  0xa7: "O", // inferred (M, N are ASCII)
  0xa8: "P",
  0xac: "R",
  0xad: "S",
  0xae: "U",
  0xaf: "V",
  0xb0: "X",
  0xb1: "Y",
  0xb2: "Z", // inferred (W is ASCII)
  // punctuation
  0xbc: " ",
};

export interface ItemFontDecodeResult {
  /** Display text. Unmapped codes come out as `\uFFFD` so they are visible. */
  text: string;
  /** Codes that had no mapping, in order of appearance. */
  unknown: number[];
}

/**
 * Decode a raw item-name byte stream.
 *
 * Codes `< 0x80` pass through as ASCII, which is how this ROM stores
 * `I M N T W i l m w` and all digits/punctuation. A trailing `0x1F` (and any
 * other control byte) is dropped, matching the `@001F` stripping the reference
 * does for names.
 */
export function decodeItemFontBytes(bytes: readonly number[]): ItemFontDecodeResult {
  let text = "";
  const unknown: number[] = [];

  for (const code of bytes) {
    if (code === 0) break;
    if (TERMINATORS.has(code) || code < 0x20) continue;

    if (code < 0x80) {
      text += String.fromCharCode(code);
      continue;
    }

    const ch = ITEM_FONT[code];
    if (ch === undefined) {
      if (!unknown.includes(code)) unknown.push(code);
      text += "\uFFFD";
      continue;
    }
    text += ch;
  }

  return { text, unknown };
}

/**
 * Restore an item-font string that has been through the ordinary text decoder.
 *
 * This is the **Huffman-stored** variant: the ROM compresses a normal text
 * entry whose payload is item-font bytes (`Radoslav`'s name is the compressed
 * stream `AC 81 84 8C 90 6C 81 97`). The decoder renders each glyph `>= 0x81`
 * as `@00XX` because `applySpecialGlyphs` only expands Latin-1 accents, and
 * `stripAllCodes` then deletes every one - leaving only the incidental ASCII
 * (`"l"` for Radoslav, `"w"` for Honeydew, `""` for Onderdonk).
 *
 * Detection is deliberately narrow: at least one `@00XX` in the item-font code
 * range `0x81..0xBC`, and **every** code must map. A plain `@001F` terminator
 * (17 unit names in this ROM) does not trigger it. Returns `null` when the text
 * is not item-font, so callers keep the ordinary decode.
 */
export function restoreItemFontText(text: string): string | null {
  const codes: number[] = [];
  const escape = /@([0-9A-Fa-f]{4})/g;
  let m: RegExpExecArray | null;
  while ((m = escape.exec(text)) !== null) {
    const hex = m[1];
    if (hex !== undefined) codes.push(parseInt(hex, 16));
  }

  const itemFontCodes = codes.filter((c) => c >= 0x81 && c <= 0xbc);
  if (itemFontCodes.length === 0) return null;

  let out = "";
  let last = 0;
  escape.lastIndex = 0;
  while ((m = escape.exec(text)) !== null) {
    const hex = m[1];
    if (hex === undefined) return null;
    out += text.slice(last, m.index);
    const code = parseInt(hex, 16);
    if (code === 0x1f) {
      // terminator, as `stripAllCodes` drops it
    } else if (code < 0x80) {
      out += String.fromCharCode(code);
    } else {
      const ch = ITEM_FONT[code];
      if (ch === undefined) return null; // not item-font after all
      out += ch;
    }
    last = m.index + m[0].length;
  }
  out += text.slice(last);

  return out;
}
