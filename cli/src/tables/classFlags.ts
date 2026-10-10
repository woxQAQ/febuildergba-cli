/**
 * Class ability flags - the bytes at class record `+40`..`+43`.
 *
 * Bit names are in `config/data/unitclass_checkbox_<game>.txt` (neither C# nor
 * ROM), loaded by `InputFormRef.LoadCheckboxesResource` (InputFormRef.cs:12584)
 * with label prefixes `L_40_BIT_`..`L_43_BIT_`.
 *
 * A key is two hex digits read as one number; `LoadCheckboxesResource`
 * dispatches on its range, not the high nibble: `0x01..0x0F` -> `L_40_BIT_`
 * (byte `+40`), `0x10..0x1F` -> `+41`, `0x20..0x2F` -> `+42`, `0x30..0x3F` ->
 * `+43`; the **low** nibble selects the bit (`1` -> `0x01` ... `8` -> `0x80`).
 * So byte = `40 + (key >> 4)` - the high nibble is one below the byte index,
 * since `0x01` not `0x11` is the first bit. `GetInfoByBitFlag`
 * (InputFormRef.cs:7453): `shift = (key & 0xf) - 1 + ((key & 0xf0) >> 4) * 8`.
 *
 * Cross-check: `11` = byte `+41`, mask `0x01` (= upstream's
 * `u8(addr + 41) & 0x01`, `ClassForm.isHighClassAddr`); `13` = `+41`, mask
 * `0x04` (cavalry). If decoding drifts a byte, `promoted` stops matching.
 * (`34` = byte `+43`, mask `0x08` = Summoning in FE8, 敵アイテムドロップ in FE7.)
 */

import { parseKeyedTable, readTextFile, resolveDataFile } from "../config/data.ts";

/** Byte offset of the first ability byte within a class record. */
export const CLASS_ABILITY_BASE_OFFSET = 40;
/** Number of ability bytes: `+40`, `+41`, `+42`, `+43`. */
export const CLASS_ABILITY_BYTE_COUNT = 4;

/**
 * Stable ids for the flags we reason about, **for FE8**, keyed by the config
 * file's two-hex-digit key so the mapping is auditable. Names are ours; display
 * strings come from the file.
 *
 * The ids are per-game, not universal: each game ships its own
 * `unitclass_checkbox_<game>.txt`, and an id taken from FE8 silently mislabels
 * FE6/FE7. Divergences read off the three files:
 *   key  FE6            FE7                 FE8
 *   21   weaponLockRoy  weaponLock1         weaponLock1
 *   23   manaketeLock   manaketeLock        monsterWeapon
 *   24   zephielLock    morph               maxLevel10
 *   28   npc            unselectable        npc
 *   34   (unnamed)      **droppableItem**   **summon**
 *   35   (unnamed)      weaponLockEliwood   weaponLockEirika
 *   36   (unnamed)      weaponLockHector    weaponLockEphraim
 *   37   (unnamed)      weaponLockLyndis    weaponLockLyn
 *   38   (unnamed)      weaponLockAthos     weaponLockAthos
 * `34` is load-bearing: FE7 敵アイテムドロップ (drops last item) vs FE8 the drop
 * flag moved to the placement record's `ext` and the bit became Summoning. See
 * {@link classFlagKeysFor}.
 */
export const CLASS_FLAG_KEYS: Readonly<Record<string, string>> = {
  "01": "mountedAid", // Mounted Aid Calc
  "02": "canto",
  "03": "steal",
  "04": "thiefSkill",
  "05": "dance",
  "06": "play",
  "07": "critBoost",
  "08": "ballista",
  "11": "promoted",
  "12": "supply",
  "13": "mountHorse",
  "14": "mountWyvern",
  "15": "mountPegasus",
  "16": "lord",
  "17": "female",
  "18": "boss",
  "21": "weaponLock1",
  "22": "weaponLockMyrmidon",
  "23": "monsterWeapon",
  "24": "maxLevel10",
  "25": "unselectable",
  "26": "trianglePegasus",
  "27": "triangleArmour",
  "28": "npc",
  "31": "noExp",
  "32": "lethality",
  "33": "magicSeal",
  "34": "summon",
  "35": "weaponLockEirika",
  "36": "weaponLockEphraim",
  "37": "weaponLockLyn",
  "38": "weaponLockAthos",
};

/**
 * Per-game overrides for keys that do not share FE8's meaning; the rest fall
 * through to {@link CLASS_FLAG_KEYS}. Keys marked `(unnamed)` (FE6 leaves
 * `32`..`38` as `??`) get an id of our own so the bit stays visible.
 */
const CLASS_FLAG_KEYS_BY_GAME: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  FE6: {
    "21": "weaponLockRoy",
    "23": "manaketeLock",
    "24": "zephielLock",
    "32": "flag32",
    "33": "flag33",
    "34": "flag34",
    "35": "flag35",
    "36": "flag36",
    "37": "flag37",
    "38": "flag38",
  },
  FE7: {
    "23": "manaketeLock",
    "24": "morph",
    "28": "unselectable",
    "34": "droppableItem",
    "35": "weaponLockEliwood",
    "36": "weaponLockHector",
    "37": "weaponLockLyndis",
  },
};

/** Resolve a config key to its id for a given game fragment (`FE6`/`FE7`/`FE8`). */
export function classFlagKeysFor(game: string): Readonly<Record<string, string>> {
  const override = CLASS_FLAG_KEYS_BY_GAME[game];
  if (override === undefined) return CLASS_FLAG_KEYS;
  return { ...CLASS_FLAG_KEYS, ...override };
}

export interface ClassFlagDef {
  /** Raw key from the config file, e.g. `13`. */
  key: string;
  /** Stable identifier, e.g. `mountHorse`. */
  id: string;
  /** Display name from the config file. */
  label: string;
  /** Byte offset within the class record. */
  offset: number;
  /** Bit mask within that byte. */
  mask: number;
}

/**
 * Decode a config key into (byte offset, bit mask). The key is **hexadecimal**
 * (`U.LoadDicResource` stores it via `U.atoh(sp[0])`, U.cs:3385). Bit arithmetic
 * from `GetInfoByBitFlag` (InputFormRef.cs:7453):
 *     shift = (key & 0xf) - 1 + ((key & 0xf0) >> 4) * 8;  bit = 1 << shift
 * i.e. high nibble = byte index in the 4-byte block, low nibble = 1-based bit.
 */
export function decodeFlagKey(key: string): { offset: number; mask: number } | null {
  const value = Number.parseInt(key, 16);
  if (Number.isNaN(value) || value <= 0 || value >= 0x40) return null;

  const byteIndex = value >> 4;
  const bitSelector = value & 0xf;
  if (byteIndex < 0 || byteIndex >= CLASS_ABILITY_BYTE_COUNT) return null;
  if (bitSelector < 1 || bitSelector > 8) return null;

  return { offset: CLASS_ABILITY_BASE_OFFSET + byteIndex, mask: 1 << (bitSelector - 1) };
}

/**
 * Load the ability-flag table for a game (`TitleToFilename` fragment); `[]` when
 * `config/data` is unavailable, in which case callers fall back to deriving roles
 * from movement costs alone.
 */
export function loadClassFlags(configDir: string, game: string, language?: string): ClassFlagDef[] {
  const path = resolveDataFile(configDir, "unitclass_checkbox_", game, language);
  if (path === null) return [];

  const ids = classFlagKeysFor(game);
  const out: ClassFlagDef[] = [];
  for (const entry of parseKeyedTable(readTextFile(path))) {
    const decoded = decodeFlagKey(entry.key);
    if (decoded === null) continue;
    const id = ids[entry.key] ?? `flag${entry.key}`;
    out.push({ key: entry.key, id, label: entry.name, ...decoded });
  }
  return out;
}

/** Read the raw ability bytes from a class record. */
export function readAbilityBytes(read: (offset: number) => number, recordOffset: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < CLASS_ABILITY_BYTE_COUNT; i++) {
    out.push(read(recordOffset + CLASS_ABILITY_BASE_OFFSET + i));
  }
  return out;
}

/**
 * Which flags are set in a 4-byte ability block: stable ids in table order.
 * Unknown bits become `flag<key>` so nothing is dropped.
 */
export function decodeAbilityFlags(
  bytes: readonly number[],
  defs: readonly ClassFlagDef[],
): string[] {
  const set = new Set<number>();
  for (let i = 0; i < bytes.length; i++) {
    set.add((bytes[i] as number) << 0);
  }

  const out: string[] = [];
  for (const def of defs) {
    const byteIndex = def.offset - CLASS_ABILITY_BASE_OFFSET;
    const value = bytes[byteIndex];
    if (value === undefined) continue;
    if ((value & def.mask) !== 0) out.push(def.id);
  }
  return out;
}

/**
 * Mount category, `null` for foot units. The three icon flags are mutually
 * exclusive in practice; when a hack sets several, report the first in
 * wyvern > pegasus > horse order (wyvern/pegasus imply flying, more specific).
 */
export type MountKind = "wyvern" | "pegasus" | "horse" | "armour" | null;

export function classifyMount(flags: readonly string[]): MountKind {
  const has = (f: string): boolean => flags.includes(f);
  if (has("mountWyvern")) return "wyvern";
  if (has("mountPegasus")) return "pegasus";
  if (has("mountHorse")) return "horse";
  // Triangle Attack 2 is the armour-knight membership flag; FE8 sets it on
  // Armor Knight / Knight / General and nothing else.
  if (has("triangleArmour")) return "armour";
  return null;
}

/**
 * Whether the class is a "special action" class whose role is utility rather
 * than combat: dancers, bards, thieves.
 */
export function specialActionRole(flags: readonly string[]): "dancer" | "bard" | "thief" | null {
  const has = (f: string): boolean => flags.includes(f);
  if (has("dance")) return "dancer";
  if (has("play")) return "bard";
  if (has("steal") || has("thiefSkill")) return "thief";
  return null;
}
