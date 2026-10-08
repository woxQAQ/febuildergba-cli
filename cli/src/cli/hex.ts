/**
 * Hex formatting for ROM addresses and ids.
 *
 * Every address in the JSON output goes through here so padding stays
 * consistent: addresses are bare `0x18480F8`, terrain and item ids are
 * zero-padded to two digits.
 */
export function hex(value: number, pad = 0): string {
  return `0x${value.toString(16).toUpperCase().padStart(pad, '0')}`;
}

/** An id rendered both ways, for output that has to sort and be read. */
export function hexId(value: number): string {
  return hex(value, 2);
}