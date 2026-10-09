import { affinityLabel as affinityLabelForId } from "../tables/supportBonus.ts";
import type { LoadedRom } from "../load.ts";

/**
 * Affinity name preferring the ROM's own text table, falling back to the
 * reference's hardcoded switch. See `readAffinityNames`.
 *
 * Ids the ROM has no name for (hacks extend the table past the seven the
 * reference knows) fall back to `affinityLabel`, which carries the id - the
 * affinity is real and its bonuses apply, it just has no name to show.
 */
export function affinityLabel(rom: LoadedRom, id: number): string {
  return rom.affinityNames.get(id) ?? affinityLabelForId(id);
}
