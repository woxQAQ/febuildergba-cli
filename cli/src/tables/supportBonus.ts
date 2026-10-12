/**
 * Support affinities and the support-bonus table.
 *
 * 1. Affinity names: `InputFormRef.GetAttributeName()` is a hardcoded `switch`,
 *    authoritative: 1 炎, 2 雷, 3 風, 4 氷, 5 闇, 6 光, 7 理. Each unit carries
 *    one at unit-record `+9` (`Unit.attribute`).
 * 2. Support-bonus table at `RomInfo.support_attribute_pointer`, 8 bytes/record
 *    (`SupportAttributeForm.cs`), read while `u8(addr) != 0`: byte 0 is the
 *    affinity id, the table ends at the first zero record.
 *
 * The C/B/A scaling is in the ROM's own code. `config/data/asmmap_FE8.txt`
 * (vanilla FE8U symbols; the fixture kept vanilla code) names:
 *     0802852C GetSupportBonusEntryPtr
 *     08028550 StoreAddedAffinityBonusesForSupportLevel
 *     080285B0 GetUnitSupportBonuses
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
 * The same code is `src/bmreliance.c` in `FireEmblemUniverse/fireemblem8u`; its
 * `struct SupportBonuses` names what the byte layout cannot:
 *     +00 affinity, +01 bonusAttack, +02 bonusDefense, +03 bonusHit,
 *     +04 bonusAvoid, +05 bonusCrit, +06 bonusDodge
 * agreeing with the reference labels (`J_4` 回避 next to `B4`, `J_6` 必殺回避
 * next to `B6`) and pinning `SUPPORT_EXP_C/B/A = 81/161/241`.
 *
 * Three easy mistakes:
 * 1. The stored bytes are HALF-points (`5`, not `2.5`); the final `>>1` gives the
 *    familiar 2/5/7 for C/B/A. Reading them as final doubles every value.
 * 2. Both affinities contribute: own row *plus* partner's.
 * 3. The halving is once over the total: `floor(sum/2)`, not `sum(floor(x/2))`.
 *
 * Byte 7 is unused (the store loop touches 1..6 only) but surfaced as `unknown7`
 * because it is on disk.
 */

import { RomBuffer } from "../rom/RomBuffer.ts";
import type { TextContext } from "../text/huffman.ts";
import { decodeTextId, displayName } from "../text/huffman.ts";
import type { SupportBonus } from "../model/snapshotRecords.ts";
import { SUPPORT_BONUS_FIELDS } from "../model/snapshotRecords.ts";

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

/**
 * `InputFormRef.GetAttributeName()`: the seven named affinities, else `"-"`.
 *
 * Never invents a name - see {@link AFFINITY_NAMES}.
 */
export function affinityName(id: number): string {
  return AFFINITY_NAMES[id] ?? UNNAMED_AFFINITY;
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

export const SUPPORT_BONUS_RECORD_SIZE = 8;

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
 * terminates, so that a wrong pointer slot cannot walk the whole ROM.
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
