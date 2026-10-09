/**
 * FE8's **item-name font** (`RomInfo.font_item_address`, FE8U = `0x58c7ec`).
 *
 * ## Why item names need their own decoder
 *
 * FE8 draws item names in the inventory with a dedicated font
 * (「アイテム名とかに使われるフォント」, the routine at `0x08004504`), and the
 * strings for that font live in their **own code space** — they are not ASCII
 * and they are not Huffman.
 *
 * `dream-of-five.gba` stores them un-compressed (the anti-Huffman patch), so
 * text id 852 is the raw bytes
 *
 * ```text
 * 49 8f 8c 8b bc ad 77 8c 8f 84        ->  "Iron Sword"
 * ```
 *
 * FEBuilderGBA has no table for this font, so it prints those bytes as
 * `@008F@008C@008B@00BC@00ADw@008C@008F@0084` - mojibake that looks like data.
 * The bytes *are* the text; they just need the item font's alphabet.
 *
 * ## How the table below was recovered
 *
 * There is no code->char table anywhere in the ROM (a scan for one comes back
 * empty), so the mapping is **empirical**, built from the item table itself:
 * the first seven entries are the vanilla Iron/Slim/Steel/Silver
 * Sword/Blade pair, which pins `a`, `b`, `c`, `d`, `e`, `i`, `l`, `m`, `n`,
 * `o`, `r`, `S`, `t`, `v`, `w`; the rest follow from
 * `Rapier`, `Runesword`, `Lancereaver`, `Killing Edge`, `Bolting`,
 * `Berserk` (`0x8A = k`), `Elixir`, `Lockpick` (`0x8E = q`), `Mioritza`
 * (`0x9A = z`), `Authority`, `Parzifal`, `Veritas`, `Wyrmslayer`
 * (`0x99 = y`, `0x90 = s`) …
 *
 * ## Shape of the alphabet
 *
 * Codes `< 0x80` are **plain ASCII**, and the letters that appear there are
 * exactly the ones with no separate item-font glyph: `I M N T W i l m w`.
 * Everything else lives in the `0x80`-`0xBC` block. `0xBC` is the space.
 *
 * The `0xA1`, `0xA9`-`0xAB`, `0xB0`, `0xB1` slots and the `0x91`-`0x94` gap
 * are **inferred from the alphabet's ordering**, not observed: no item name in
 * this ROM uses them. `0xB2 = Z` follows from `… U V [W=ASCII] X Y Z` and is
 * corroborated by item #177, whose name reads `<0xB2>almoxis` = **Zalmoxis**.
 * They are listed here so the table is complete; treat them as provisional.
 *
 * Reference: `ROMFE8U.cs:235 font_item_address`, `FontForm.GetFontPointer`,
 *            `FETextDecode.UnHffmanPatchDecodeLow`.
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
