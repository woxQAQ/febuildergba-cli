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
 * `FEBuilderGBA/bin/Debug/config/data/` into `cli/data/`.
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
 * Japanese. We prefer the caller's language, then English, then the bare file -
 * mirroring `U.ConfigDataFilename` (U.cs:3180).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where we look for `config/data`, in order.
 *
 * The vendored `cli/data/` copy is the default source, so the CLI never has to
 * reach into the sibling `FEBuilderGBA/` checkout. `FEBUILDERGBA_CONFIG` lets a
 * caller point at a full upstream `config/data` tree (e.g. a fresh release) and
 * takes precedence when it exists.
 */
export function defaultConfigSearchPaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/config -> src -> cli
  const cliRoot = resolve(here, '..', '..');
  return [process.env['FEBUILDERGBA_CONFIG'] ?? '', join(cliRoot, 'data')].filter(
    (p) => p.length > 0,
  );
}

/**
 * Locate a `config/data` directory. Returns `null` when none exists, which is
 * not fatal - callers degrade to "this table is unavailable".
 */
export function findConfigDataDir(explicit?: string): string | null {
  if (explicit !== undefined) {
    return existsSync(explicit) ? explicit : null;
  }
  for (const candidate of defaultConfigSearchPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Languages to try, in order. The bare filename is Japanese. */
const LANGUAGE_SUFFIXES = ['', '.en', '.zh'];

/**
 * Resolve `<prefix><game><lang>.txt` the way `U.ConfigDataFilename` does.
 *
 * `game` is the `TitleToFilename` fragment - `FE6`, `FE7`, `FE8` - or `ALL`.
 * Returns `null` when no variant exists.
 */
export function resolveDataFile(
  dir: string,
  prefix: string,
  game: string,
  languages: readonly string[] = LANGUAGE_SUFFIXES,
): string | null {
  for (const lang of languages) {
    const path = join(dir, `${prefix}${game}${lang}.txt`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function readTextFile(path: string): string {
  // Some of these files carry a UTF-8 BOM; strip it or the first key breaks.
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

/** `//`-prefixed and blank lines are comments, per `U.IsComment`. */
export function isComment(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith('//') || t.startsWith(';');
}

export function splitTab(line: string): string[] {
  return line.split('\t').map((s) => s.trim());
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
    const eq = raw.indexOf('=');
    if (eq < 0) continue;

    const key = raw.slice(0, eq).trim();
    if (key.length === 0) continue;

    const value = raw.slice(eq + 1);
    const name = value.split(/\t|\\r\\n/)[0]?.trim() ?? '';
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
