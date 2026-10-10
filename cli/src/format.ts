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
