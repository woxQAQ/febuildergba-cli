/**
 * Reader for the `config/data/*.txt` resource tables.
 *
 * ## Why this exists
 *
 * A lot of ROM semantics are **not** in the C# code and **not** in the ROM:
 * the names of class ability bits, the event-script opcode table, the
 * chapter-condition table. FEBuilderGBA ships them as plain text files next to
 * the executable, under `config/data/`.
 *
 * ## Where the files come from (vendored, not borrowed)
 *
 * These files originate from FEBuilderGBA, but the CLI **does not read them out
 * of the C# checkout**. A minimal subset is copied into `cli/data/` so this
 * project stands alone: cloning `cli/` on its own is enough to parse a ROM.
 *
 * The vendored set is exactly what the parser consumes - three prefixes, each
 * for FE6 / FE7 / FE8, in all three languages (bare = Japanese, `.en`, `.zh`):
 *
 *   - `unitclass_checkbox_<game>*.txt` - class ability bit names
 *   - `event_<game>*.txt`              - event-script opcode patterns
 *   - `eventcond_<game>*.txt`          - chapter condition slot names
 *
 * To refresh them after an FEBuilderGBA update, re-copy those 27 files from
 * `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/` into `cli/data/`.
 *
 * ## File format
 *
 * Line-oriented, tab-separated, with `//` comments. Three shapes appear:
 *
 *   1. `KEY=Display Name`            - checkbox / enum tables (`unitclass_checkbox_*`)
 *   2. `PATTERN<TAB>info<TAB>...`    - opcode tables (`event_*`, `aiscript_*`)
 *   3. `FLAG<TAB>Display Name`       - simple two-column tables (`eventcond_*`)
 *
 * Language variants sit alongside each other as `<name>.<lang>.txt`
 * (`unitclass_checkbox_FE8.txt`, `.en.txt`, `.zh.txt`). The bare name is
 * Japanese. `U.ConfigDataFilename` (U.cs:3180) tries the caller's language,
 * then English, then the bare file - but the CLI's caller is a program, not a
 * person, and its output is read by an AI: so the default order here is
 * English, bare (Japanese), Chinese. Pass `--lang` to change it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The vendored `cli/data/` copy is the only source, so the CLI never has to
 * reach into the sibling `FEBuilderGBA/` checkout and its behaviour does not
 * depend on environment variables. Library callers can pass `configDir` to
 * `loadRom` to point elsewhere (e.g. a fresh upstream tree).
 */
function vendoredDataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/config -> src -> cli
  return resolve(here, "..", "..", "data");
}

/**
 * Locate a `config/data` directory. Returns `null` when none exists, which is
 * not fatal - callers degrade to "this table is unavailable".
 */
export function findConfigDataDir(explicit?: string): string | null {
  if (explicit !== undefined) {
    return existsSync(explicit) ? explicit : null;
  }
  const vendored = vendoredDataDir();
  return existsSync(vendored) ? vendored : null;
}

/**
 * Languages this CLI knows how to ask for, by `--lang` value.
 *
 * `ja` is the bare filename (no suffix); the other two are the suffixed
 * variants. Each entry lists the suffixes to try in order: the requested
 * language first, then English, then the bare file, so a missing translation
 * degrades to something readable instead of to nothing.
 */
export const LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  en: [".en", "", ".zh"],
  ja: ["", ".en", ".zh"],
  zh: [".zh", ".en", ""],
};

/**
 * Whether a `--lang` value is one this CLI knows.
 *
 * The single answer to "is this language real", because two places used to
 * decide it independently and could disagree: the CLI rejects an unknown value
 * with exit 2, while `loadRom` - also a library entry point, so it cannot
 * assume the CLI ran - warns and falls back. Same question, two answers; now
 * one predicate with two callers.
 */
export function isKnownLanguage(language: string): boolean {
  return Object.hasOwn(LANGUAGES, language);
}

/** Languages `--lang` accepts, in help-text order. */
export const LANGUAGE_NAMES: readonly string[] = Object.keys(LANGUAGES);

/** Default when `--lang` is absent: English, then bare (Japanese), then Chinese. */
export const DEFAULT_LANGUAGE = "en";

/**
 * Suffixes to try for a `--lang` value, or `null` when the language is not one
 * we know. Callers validate the name; this is the second gate.
 */
export function languageSuffixes(language: string | undefined): readonly string[] | null {
  if (language !== undefined && !isKnownLanguage(language)) return null;
  return LANGUAGES[language ?? DEFAULT_LANGUAGE] as readonly string[];
}

/**
 * Resolve `<prefix><game><lang>.txt`.
 *
 * `game` is the `TitleToFilename` fragment - `FE6`, `FE7`, `FE8` - or `ALL`.
 * `language` is a `--lang` value. Returns `null` when no variant exists.
 */
export function resolveDataFile(
  dir: string,
  prefix: string,
  game: string,
  language?: string,
): string | null {
  const suffixes = languageSuffixes(language);
  if (suffixes === null) return null;
  for (const suffix of suffixes) {
    const path = join(dir, `${prefix}${game}${suffix}.txt`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function readTextFile(path: string): string {
  // Some of these files carry a UTF-8 BOM; strip it or the first key breaks.
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

/** `//`-prefixed and blank lines are comments, per `U.IsComment`. */
export function isComment(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith("//") || t.startsWith(";");
}

export function splitTab(line: string): string[] {
  return line.split("\t").map((s) => s.trim());
}

export interface KeyedEntry {
  /** Raw key as written in the file, e.g. `13`. Parsed as hex by callers. */
  key: string;
  /** Display name - up to the first tab or literal `\r\n`. */
  name: string;
}

/**
 * Parse a `KEY=Name` table.
 *
 * The value can carry more than the name: a tab and/or a literal `\r\n` may
 * follow it with the tooltip body. The name is everything up to the first of
 * those, which is what `GetInfoByBitFlag` does with `pair.Value.Split('\t')[0]`
 * (InputFormRef.cs:7470).
 */
export function parseKeyedTable(text: string): KeyedEntry[] {
  const out: KeyedEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (isComment(raw)) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) continue;

    const key = raw.slice(0, eq).trim();
    if (key.length === 0) continue;

    const value = raw.slice(eq + 1);
    const name = value.split(/\t|\\r\\n/)[0]?.trim() ?? "";
    out.push({ key, name });
  }
  return out;
}

/**
 * Parse a `FLAG<TAB>Name` table (`eventcond_*`). Order matters: the index in
 * this list is the slot index in the ROM's condition table.
 */
export function parseTwoColumnTable(text: string): { flag: string; name: string }[] {
  const out: { flag: string; name: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (isComment(raw)) continue;
    const cols = splitTab(raw);
    if (cols.length < 2) continue;
    out.push({ flag: cols[0] as string, name: cols[1] as string });
  }
  return out;
}
