/**
 * Support affinities and the support-bonus table.
 *
 * Two separate things live here:
 *
 * 1. **Affinity names** - `InputFormRef.GetAttributeName()` in the reference is
 *    a plain hardcoded `switch`, so these are authoritative:
 *    1 = 炎 (Fire), 2 = 雷 (Thunder), 3 = 風 (Wind), 4 = 氷 (Ice),
 *    5 = 闇 (Dark), 6 = 光 (Light), 7 = 理 (Anima).
 *
 *    Each *unit* carries one at unit-record `+9` (read as `Unit.attribute`).
 *
 * 2. **The support-bonus table** at `RomInfo.support_attribute_pointer`,
 *    8 bytes per record (`SupportAttributeForm.cs`). The read-count predicate is
 *    `u8(addr) != 0`, i.e. the first byte is the affinity id and the table ends
 *    at the first zero record.
 *
 * ## The scaling across C/B/A - recovered from the ROM's own code
 *
 * The reference ships only an *editor* for this table, so for a long time the
 * rank scaling was listed here as "not documented; do not assume". That was the
 * wrong conclusion: the game itself implements it, and the ROM ships a symbol
 * map that names the functions.
 *
 * `config/data/asmmap_FE8.txt` is a vanilla FE8U symbol map (the fixture is a
 * hack of FE8U that kept the vanilla code layout), and it names three functions
 * around the table:
 *
 *     0802852C  GetSupportBonusEntryPtr                 {U}
 *     08028550  StoreAddedAffinityBonusesForSupportLevel {U}
 *     080285B0  GetUnitSupportBonuses                    {U}
 *
 * Disassembling them gives the whole mechanic:
 *
 * ```asm
 * GetSupportBonusEntryPtr(affinity):
 *     ldr  r2, [pc, #0]        ; = 0x088B05F8  <- THE SLOT ITSELF (offset 0x28534)
 *   loop:
 *     ldrb r1, [r2]
 *     cmp  r1, r3              ; u8(addr) == affinity ?
 *     beq  found
 *     adds r2, #8              ; 8-byte stride
 *     ldrb r1, [r2]
 *     cmp  r1, #0              ; terminator
 *     bne  loop
 *
 * StoreAddedAffinityBonusesForSupportLevel(dest, affinity, level):
 *     bl   GetSupportBonusEntryPtr
 *     ldrb r1, [r0, #1]        ; entry.atk
 *     muls r1, r5, r1          ; entry.atk * level
 *     ldrb r2, [r4, #1]        ; dest.atk
 *     adds r1, r1, r2
 *     strb r1, [r4, #1]        ; dest.atk += entry.atk * level
 *     ... repeated for offsets 2,3,4,5,6 - and NEVER for offset 7
 *
 * GetUnitSupportBonuses(unit, dest):
 *     InitSupportBonuses(dest)                 ; zero dest[1..6]
 *     for i in 0..GetROMUnitSupportCount(unit):
 *         partner = GetUnitSupportingUnit(unit, i)
 *         if !partner: continue
 *         if |dx| + |dy| > 3: continue         ; support range is 3 tiles
 *         if partner->state & MASK: continue   ; undeployed / dead
 *         idx = GetSupportDataIdForOtherUnit(partner, unit->pinfo[4])
 *         StoreAdded(dest, partner->pinfo[9], GetSupportLevelBySupportIndex(partner, idx))
 *         StoreAdded(dest,     unit->pinfo[9], GetSupportLevelBySupportIndex(unit, i))
 *     for off in 1..6: dest[off] >>= 1         ; <-- THE HALVING
 * ```
 *
 * and `GetSupportLevelBySupportIndex` (0802823C) hardcodes the thresholds:
 *
 * ```asm
 *   ldrb r0, [r0, #0x32 + index]   ; the unit's raw support value for that slot
 *   cmp  r0, #0xF0 ; bgt -> 3      ; A : 241+
 *   cmp  r0, #0xA0 ; bgt -> 2      ; B : 161..240
 *   cmp  r0, #0x50 ; ble -> 0      ; no support: <= 80
 *                  ; else 1        ; C : 81..160
 * ```
 *
 * So, with `L` = 0 / 1 / 2 / 3 for none / C / B / A:
 *
 *     bonus[stat] = floor( SUM over partners (  entry[myAffinity][stat] * L(me->p)
 *                                             + entry[pAffinity][stat] * L(p->me) ) / 2 )
 *
 * The same code is published as `src/bmreliance.c` + `include/bmreliance.h` in
 * the `FireEmblemUniverse/fireemblem8u` decomp, which names every field and
 * every constant. That matters because the *byte layout* alone does not say
 * which of offsets 1..6 is "avoid" and which is "crit avoid" - the decomp's
 * `struct SupportBonuses` does, and its order is
 *
 *     +00 affinity, +01 bonusAttack, +02 bonusDefense, +03 bonusHit,
 *     +04 bonusAvoid, +05 bonusCrit, +06 bonusDodge
 *
 * which agrees with the reference's own designer labels (`J_4` 回避 next to
 * `B4`, `J_6` 必殺回避 next to `B6`). The header also pins the thresholds as
 * `SUPPORT_EXP_C = 81 / B = 161 / A = 241` and the levels as
 * `SUPPORT_LEVEL_NONE/C/B/A = 0/1/2/3`, which is what makes the `muls` above
 * the rank multiplier rather than a plain index.
 *
 * Three consequences that are easy to get wrong:
 *
 * 1. **The stored bytes are HALF-points.** The table holds `5`, not `2.5`, and
 *    the final `>>1` turns it into the familiar 2 / 5 / 7 for C / B / A. Reading
 *    the bytes as final bonuses makes every value look 2x too large.
 * 2. **Both affinities contribute.** A support's bonus is your affinity's row
 *    *plus* your partner's row - not just yours.
 * 3. **The halving happens once, over the total.** It is `floor(sum/2)`, not
 *    `sum(floor(x/2))`. With several adjacent partners the two differ.
 *
 * Byte 7 is genuinely unused: the game's store loop touches offsets 1..6 only,
 * which is why the reference labels it `??`. It is still surfaced as `unknown7`
 * because it is on disk.
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextId, displayName } from "../text/huffman.ts";

/**
 * `InputFormRef.GetAttributeName()` - hardcoded in the reference.
 *
 * The reference names exactly these seven and returns `"-"` for every other
 * id. Hacks do extend the table past 7 (Vision_Quest carries ids up to 16),
 * and for those the game has no name to look up either - the id in the bonus
 * table is the only thing that identifies them. So we report the reference's
 * `"-"` rather than inventing an `affinity 11` label: a fabricated name reads
 * like real data, while `-` is honest about being unnamed. Callers that need
 * the id itself should print `id` alongside.
 */
export const AFFINITY_NAMES: Readonly<Record<number, string>> = {
  1: "Fire",
  2: "Thunder",
  3: "Wind",
  4: "Ice",
  5: "Dark",
  6: "Light",
  7: "Anima",
};

/** The label the reference prints for an affinity it has no name for. */
export const UNNAMED_AFFINITY = "-";

/** True when the reference (and therefore the game) has a name for this id. */
export function isNamedAffinity(id: number): boolean {
  return id in AFFINITY_NAMES;
}

/**
 * `InputFormRef.GetAttributeName()`: the seven named affinities, else `"-"`.
 *
 * Never invents a name - see {@link AFFINITY_NAMES}.
 */
export function affinityName(id: number): string {
  return AFFINITY_NAMES[id] ?? UNNAMED_AFFINITY;
}

/**
 * `affinityName` but always carrying the id, for contexts where the reader
 * needs to tell `Fire` from `affinity 11`. Affinities the reference names are
 * printed bare; anything else becomes `11 (-)`, which stays a single token and
 * so cannot run into column-padding bugs the way a spaced label does.
 */
export function affinityLabel(id: number): string {
  const named = AFFINITY_NAMES[id];
  if (named !== undefined) return named;
  return `${id} (${UNNAMED_AFFINITY})`;
}

/**
 * The text ids the game itself uses for the affinity names.
 *
 * `GetAffinityName` in the FE8 decomp (`src/bmreliance.c`) is a text-id lookup
 * indexed by affinity id:
 *
 *     int textIdLookup[] = { 0x534, 0x510, 0x511, 0x512, 0x513, 0x50C, 0x50B, 0x50A };
 *
 * Index 0 is unused (the function is never called with affinity 0 - see the
 * `if (!affinity) return -1;` guard in `GetUnitAffinityIcon`). Decoding these
 * out of the fixture ROM returns exactly Fire / Thunder / Wind / Ice / Dark /
 * Light / Anima, which is an independent confirmation of
 * {@link AFFINITY_NAMES} - and gives the localised spelling for free.
 */
export const AFFINITY_TEXT_IDS: Readonly<Record<number, number>> = {
  1: 0x510,
  2: 0x511,
  3: 0x512,
  4: 0x513,
  5: 0x50c,
  6: 0x50b,
  7: 0x50a,
};

/**
 * Support bonuses only apply while the two units are within this many tiles
 * (`SUPPORT_BONUSES_MAX_DISTANCE`, `include/bmreliance.h`).
 *
 * Note this is the **bonus** range. Support *points* accumulate at a shorter
 * range - see {@link SUPPORT_EXP_DISTANCE}.
 */
export const SUPPORT_BONUSES_MAX_DISTANCE = 3;

/**
 * Support points accumulate only when the pair is adjacent, or when one is
 * carrying the other (`ProcessTurnSupportExp` in `src/bmreliance.c`, whose
 * `RECT_DISTANCE` switch accepts `0` - same tile, must be a rescue - and `1`).
 */
export const SUPPORT_EXP_DISTANCE = 1;

/**
 * A unit may hold at most this many support *levels* in total
 * (`MAX_SIMULTANEOUS_SUPPORT_COUNT`, `include/bmreliance.h`).
 *
 * This is not a partner count: the levels are summed, so one A (3) plus one B
 * (2) already fills a unit's allowance, while five C supports (5) would too.
 * `CanUnitSupportNow` refuses a new support once `GetUnitTotalSupportLevel`
 * reaches this on *either* side of the pair.
 */
export const MAX_SIMULTANEOUS_SUPPORT_LEVELS = 5;

export const SUPPORT_BONUS_RECORD_SIZE = 8;

/**
 * Field names for bytes 1..7 of a record, in offset order.
 *
 * Transcribed from the labels adjacent to `B1`-`B7` in
 * `SupportAttributeForm.Designer.cs`. Byte 7's label is literally `??` in the
 * reference, and the disassembly above shows the game never reads it, so it
 * stays unnamed here rather than being guessed.
 */
export const SUPPORT_BONUS_FIELDS = [
  "atk", // 攻撃
  "def", // 防御
  "hit", // 命中
  "avoid", // 回避
  "crit", // 必殺
  "critAvoid", // 必殺回避
  "unknown7", // J_7, labelled "??" in the reference; never read by the game
] as const;

/** The six stats a support actually modifies, in record-offset order. */
export const SUPPORT_BONUS_STATS = ["atk", "def", "hit", "avoid", "crit", "critAvoid"] as const;

export type SupportBonusStat = (typeof SUPPORT_BONUS_STATS)[number];

export interface SupportBonus {
  /** Affinity id, 1..7. */
  affinity: number;
  affinityName: string;
  /** Raw 8 bytes, exactly as stored. */
  raw: number[];
  /** Bytes 1..7 keyed by {@link SUPPORT_BONUS_FIELDS} - always all six. */
  bonuses: Record<SupportBonusStat, number>;
}

/**
 * Read the support-bonus table.
 *
 * `slot` is `layout.support.attributePointer`. Returns an empty array when the
 * pointer is unusable.
 */
/**
 * Hard cap on how many bonus records {@link readSupportBonuses} will read.
 *
 * The format's own terminator is a zero id; this only bounds a table that never
 * terminates, so that a wrong pointer slot cannot walk the whole ROM. Exported
 * so the validator can tell "the table ended" from "we hit the ceiling".
 */
export const SUPPORT_BONUS_MAX_RECORDS = 0x20;

export function readSupportBonuses(rom: RomBuffer, slot: number): SupportBonus[] {
  const table = rom.p32(slot);
  if (!rom.isSafeOffset(table)) return [];

  const out: SupportBonus[] = [];
  for (let index = 0; index < SUPPORT_BONUS_MAX_RECORDS; index++) {
    const addr = table + index * SUPPORT_BONUS_RECORD_SIZE;
    if (!rom.isSafeOffset(addr) || addr + SUPPORT_BONUS_RECORD_SIZE > rom.length) break;

    const raw = Array.from(rom.bytes(addr, SUPPORT_BONUS_RECORD_SIZE));
    const affinity = raw[0] as number;
    // `SupportAttributeForm.Init`: `return rom.u8(addr) != 0;`
    if (affinity === 0) break;

    const bonuses: Record<string, number> = {};
    SUPPORT_BONUS_FIELDS.forEach((field, i) => {
      bonuses[field] = raw[i + 1] as number;
    });

    out.push({ affinity, affinityName: affinityName(affinity), raw, bonuses });
  }

  return out;
}

/**
 * Decode the affinity names straight out of the ROM's text table.
 *
 * Falls back to {@link AFFINITY_NAMES} per entry when a text id fails to
 * decode, so the result is never worse than the hardcoded table.
 */
export function readAffinityNames(rom: RomBuffer, text: TextContext): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, textId] of Object.entries(AFFINITY_TEXT_IDS)) {
    const affinity = Number(key);
    const decoded = displayName(decodeTextId(rom, textId, text));
    out.set(affinity, decoded === "" ? affinityName(affinity) : decoded);
  }
  return out;
}

/**
 * The multiplier `StoreAddedAffinityBonusesForSupportLevel` is handed for each
 * rank. `GetSupportLevelBySupportIndex` returns exactly these four values.
 */
export const SUPPORT_LEVEL_MULTIPLIER: Readonly<Record<string, number>> = {
  none: 0,
  C: 1,
  B: 2,
  A: 3,
};

/**
 * One stored half-point value at one rank.
 *
 * `(stored * multiplier) >> 1`, matching the game's `muls` followed by the
 * final `lsrs #1`.
 */
export function scaleBonus(stored: number, rank: "none" | "C" | "B" | "A"): number {
  return (stored * (SUPPORT_LEVEL_MULTIPLIER[rank] as number)) >> 1;
}

/** The six real stats at each of the three ranks, derived from the stored bytes. */
export type RankedBonus = Record<"C" | "B" | "A", Record<SupportBonusStat, number>>;

/** Derive the C/B/A bonus a unit with this affinity adds to a single support. */
export function rankedBonus(bonus: SupportBonus): RankedBonus {
  const out = { C: {}, B: {}, A: {} } as RankedBonus;
  for (const rank of ["C", "B", "A"] as const) {
    const row = out[rank] as Record<SupportBonusStat, number>;
    for (const stat of SUPPORT_BONUS_STATS) {
      row[stat] = scaleBonus(bonus.bonuses[stat] as number, rank);
    }
  }
  return out;
}

/** Index the table by affinity id for the pair calculation. */
export function bonusByAffinity(bonuses: readonly SupportBonus[]): Map<number, SupportBonus> {
  return new Map(bonuses.map((b) => [b.affinity, b]));
}

/**
 * The bonus a single two-unit support contributes, before the final halving.
 *
 * Both rows are added, each scaled by that side's own rank, exactly as
 * `GetUnitSupportBonuses` does. Callers wanting the finished numbers should use
 * {@link pairBonus} rather than halving this themselves - the game halves the
 * sum across *all* partners once, not each contribution.
 */
function pairContribution(
  table: ReadonlyMap<number, SupportBonus>,
  stat: SupportBonusStat,
  selfAffinity: number,
  selfRank: "none" | "C" | "B" | "A",
  otherAffinity: number,
  otherRank: "none" | "C" | "B" | "A",
): number {
  const mine = table.get(selfAffinity);
  const theirs = table.get(otherAffinity);
  let sum = 0;
  if (mine !== undefined) sum += scaleBonus(mine.bonuses[stat] as number, selfRank);
  if (theirs !== undefined) sum += scaleBonus(theirs.bonuses[stat] as number, otherRank);
  return sum;
}

export interface AdjacentSupport {
  /** Affinity id (1..7) of the unit the bonus is being computed for. */
  selfAffinity: number;
  /** That unit's rank toward the partner. */
  selfRank: "none" | "C" | "B" | "A";
  /** Affinity id (1..7) of the partner. */
  otherAffinity: number;
  /** The partner's rank toward the unit. Usually equal to `selfRank`. */
  otherRank: "none" | "C" | "B" | "A";
}

/**
 * The finished bonus a unit receives, following `GetUnitSupportBonuses`.
 *
 * `adjacent` should list only the supports the game would actually count: the
 * partner deployed, alive, and within `|dx| + |dy| <= 3`. The halving is applied
 * once here, over the total, as the game does.
 */
export function pairBonus(
  table: ReadonlyMap<number, SupportBonus>,
  adjacent: readonly AdjacentSupport[],
): Record<SupportBonusStat, number> {
  const totals = {} as Record<SupportBonusStat, number>;
  for (const stat of SUPPORT_BONUS_STATS) totals[stat] = 0;

  for (const link of adjacent) {
    for (const stat of SUPPORT_BONUS_STATS) {
      totals[stat] += pairContribution(
        table,
        stat,
        link.selfAffinity,
        link.selfRank,
        link.otherAffinity,
        link.otherRank,
      );
    }
  }

  for (const stat of SUPPORT_BONUS_STATS) totals[stat] >>= 1;
  return totals;
}
