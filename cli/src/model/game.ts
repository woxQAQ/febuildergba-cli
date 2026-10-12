/** Game identities and classifications shared by persisted facts and rules. */
export type GameVersion = "FE6J" | "FE7J" | "FE7U" | "FE8J" | "FE8U";
/**
 * Allegiance from `L_3_UNITGROW_ASSIGN`: 自軍 / 友軍 / 敵軍 / 消滅.
 * `removed` records delete a unit on map load rather than placing it.
 */
export type UnitSide = "player" | "ally" | "enemy" | "removed";
export const UNIT_SIDES: readonly UnitSide[] = ["player", "ally", "enemy", "removed"];
/** Classification of a unit-pointer operand, independent of its display label. */
export type LoadKind = "recruit" | "load" | "cutscene" | "other";
/** Kinds of entry in the event-condition table, matching `CONDTYPE`. */
export const COND_KINDS = [
  "TURN",
  "TALK",
  "OBJECT",
  "ALWAYS",
  "TUTORIAL",
  "TRAP",
  "PLAYER_UNIT",
  "ENEMY_UNIT",
  "FREEMAP_PLAYER_UNIT",
  "FREEMAP_ENEMY_UNIT",
  "START_EVENT",
  "END_EVENT",
  "UNKNOWN",
] as const;
export type CondKind = (typeof COND_KINDS)[number];
export type MountKind = "wyvern" | "pegasus" | "horse" | "armour" | null;
