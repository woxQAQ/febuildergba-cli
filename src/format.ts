/**
 * Shared formatting helpers. Deliberately at `src/` root rather than under
 * `cli/`: address formatting is needed by the ROM, table and analysis layers
 * too, and importing it from `cli/` would invert the dependency.
 */

/**
 * Hex formatting for ROM addresses and ids.
 *
 * Every address in the JSON output and in an error message goes through here,
 * so casing and padding stay consistent: addresses are bare `0x18480F8`, terrain
 * and item ids are zero-padded to two digits, all uppercase.
 */
export function hex(value: number, pad = 0): string {
  return `0x${value.toString(16).toUpperCase().padStart(pad, "0")}`;
}

/** An id rendered both ways, for output that has to sort and be read. */
export function hexId(value: number): string {
  return hex(value, 2);
}

/** Index display names by game id; id zero denotes an empty slot. */
export function buildUnitNameMap(
  units: readonly { id: number; name: string }[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const unit of units) {
    if (unit.id !== 0) map.set(unit.id, unit.name);
  }
  return map;
}

/** Preserve an identifiable label even for unnamed or unresolved units. */
export function unitNameOrId(nameMap: ReadonlyMap<number, string>, id: number): string {
  const name = nameMap.get(id);
  if (name && name.length > 0) return name;
  return `Unit ${hex(id, 2)}`;
}
