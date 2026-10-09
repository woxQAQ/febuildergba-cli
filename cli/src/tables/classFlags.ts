/**
 * Class ability flags - the bytes at class record `+40`..`+43`.
 *
 * ## Where the bit names come from
 *
 * Not from the C# code and not from the ROM: from
 * `config/data/unitclass_checkbox_<game>.txt`, which FEBuilderGBA loads via
 * `InputFormRef.LoadCheckboxesResource` (InputFormRef.cs:12584) with the label
 * prefixes `L_40_BIT_`, `L_41_BIT_`, `L_42_BIT_`, `L_43_BIT_`.
 *
 * ## Key encoding
 *
 * A key is two hex digits. `LoadCheckboxesResource` decodes it as:
 *
 *   - **high nibble** selects the byte: `1` -> `+40`, `2` -> `+41`,
 *     `3` -> `+42`, `4` -> `+43`
 *   - **low nibble** selects the bit: `1` -> `0x01`, `2` -> `0x02`, ... `8` -> `0x80`
 *
 * So `13` = byte `+41`, mask `0x04` = the cavalry icon flag, and `34` = byte
 * `+43`, mask `0x08` = Summoning.
 *
 * ## Why this matters
 *
 * An earlier pass concluded that "mounted vs. armour" was underivable because
 * the flag names were missing. That was wrong - the names are right here, and
 * `13` (Cavalry Unit Icon) / `27` (Triangle Attack 2, the armour flag) separate
 * them cleanly. `analysis/roles.ts` still cross-checks against the terrain
 * movement-cost table, but the flags are now the primary source.
 */

import { parseKeyedTable, readTextFile, resolveDataFile } from '../config/data.ts';

/** Byte offset of the first ability byte within a class record. */
export const CLASS_ABILITY_BASE_OFFSET = 40;
/** Number of ability bytes: `+40`, `+41`, `+42`, `+43`. */
export const CLASS_ABILITY_BYTE_COUNT = 4;

/**
 * Stable identifiers for the flags we actually reason about.
 *
 * Keyed by the two-hex-digit key from the config file so the mapping is
 * auditable against the source. Names are ours; the display strings come from
 * the file.
 */
export const CLASS_FLAG_KEYS: Readonly<Record<string, string>> = {
  '01': 'mountedAid', // Mounted Aid Calc
  '02': 'canto',
  '03': 'steal',
  '04': 'thiefSkill',
  '05': 'dance',
  '06': 'play',
  '07': 'critBoost',
  '08': 'ballista',
  '11': 'promoted',
  '12': 'supply',
  '13': 'mountHorse',
  '14': 'mountWyvern',
  '15': 'mountPegasus',
  '16': 'lord',
  '17': 'female',
  '18': 'boss',
  '21': 'weaponLock1',
  '22': 'weaponLockMyrmidon',
  '23': 'monsterWeapon',
  '24': 'maxLevel10',
  '25': 'unselectable',
  '26': 'trianglePegasus',
  '27': 'triangleArmour',
  '28': 'npc',
  '31': 'noExp',
  '32': 'lethality',
  '33': 'magicSeal',
  '34': 'summon',
  '35': 'weaponLockEirika',
  '36': 'weaponLockEphraim',
  '37': 'weaponLockLyn',
  '38': 'weaponLockAthos',
};

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
 * Decode a config key into (byte offset, bit mask).
 *
 * The key is read as **hexadecimal** - `U.LoadDicResource` stores it via
 * `U.atoh(sp[0])` (U.cs:3385). The authoritative bit arithmetic is
 * `GetInfoByBitFlag` (InputFormRef.cs:7453):
 *
 *     shift = (key & 0xf) - 1 + ((key & 0xf0) >> 4) * 8;
 *     bit   = 1 << shift;
 *
 * i.e. the high nibble is the byte index within the 4-byte block and the low
 * nibble is the bit number, 1-based. `LoadCheckboxesResource` agrees: keys
 * below 0x10 land on `L_40_BIT_`, below 0x20 on `L_41_BIT_`, and so on.
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
 * Load the ability-flag table for a game.
 *
 * `game` is the `TitleToFilename` fragment (`FE6` / `FE7` / `FE8`). Returns an
 * empty array when `config/data` is unavailable - callers must then fall back
 * to deriving roles from movement costs alone.
 */
export function loadClassFlags(
  configDir: string,
  game: string,
  language?: string,
): ClassFlagDef[] {
  const path = resolveDataFile(configDir, 'unitclass_checkbox_', game, language);
  if (path === null) return [];

  const out: ClassFlagDef[] = [];
  for (const entry of parseKeyedTable(readTextFile(path))) {
    const decoded = decodeFlagKey(entry.key);
    if (decoded === null) continue;
    const id = CLASS_FLAG_KEYS[entry.key] ?? `flag${entry.key}`;
    out.push({ key: entry.key, id, label: entry.name, ...decoded });
  }
  return out;
}

/** Read the raw ability bytes from a class record. */
export function readAbilityBytes(
  read: (offset: number) => number,
  recordOffset: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < CLASS_ABILITY_BYTE_COUNT; i++) {
    out.push(read(recordOffset + CLASS_ABILITY_BASE_OFFSET + i));
  }
  return out;
}

/**
 * Which flags are set in a 4-byte ability block.
 *
 * Returns stable ids (`mountHorse`, `canto`, ...) in table order. Unknown bits
 * are reported as `flag<key>` so nothing is silently dropped.
 */
export function decodeAbilityFlags(bytes: readonly number[], defs: readonly ClassFlagDef[]): string[] {
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
 * Mount category, or `null` for foot units.
 *
 * The three icon flags are mutually exclusive in practice; when a hack sets
 * several we report the first in wyvern > pegasus > horse order, because
 * wyvern and pegasus both imply flying and are the more specific claim.
 */
export type MountKind = 'wyvern' | 'pegasus' | 'horse' | 'armour' | null;

export function classifyMount(flags: readonly string[]): MountKind {
  const has = (f: string): boolean => flags.includes(f);
  if (has('mountWyvern')) return 'wyvern';
  if (has('mountPegasus')) return 'pegasus';
  if (has('mountHorse')) return 'horse';
  // Triangle Attack 2 is the armour-knight membership flag; FE8 sets it on
  // Armor Knight / Knight / General and nothing else.
  if (has('triangleArmour')) return 'armour';
  return null;
}

/**
 * Whether the class is a "special action" class whose role is utility rather
 * than combat: dancers, bards, thieves.
 */
export function specialActionRole(flags: readonly string[]): 'dancer' | 'bard' | 'thief' | null {
  const has = (f: string): boolean => flags.includes(f);
  if (has('dance')) return 'dancer';
  if (has('play')) return 'bard';
  if (has('steal') || has('thiefSkill')) return 'thief';
  return null;
}
