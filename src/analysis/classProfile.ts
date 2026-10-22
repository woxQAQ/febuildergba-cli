import type { ClassRecord } from "../model/records.ts";

export type Mobility = "flying" | "mounted" | "armour" | "normal";

/** Mount flags take precedence over movement/terrain-based flier detection. */
export function mobilityOf(c: ClassRecord): Mobility {
  if (c.mount === "wyvern" || c.mount === "pegasus") return "flying";
  if (c.mount === "horse") return "mounted";
  if (c.mount === "armour") return "armour";
  if (c.flying || c.terrainBonusImmune) return "flying";
  return "normal";
}

const WEAPON_SLOTS = ["sword", "lance", "axe", "bow", "staff", "anima", "light", "dark"] as const;

/** Class capability, not unit weapon rank, equipment or runtime rescue capacity. */
export function classProfile(c: ClassRecord) {
  const weapons = WEAPON_SLOTS.filter((_, index) => (c.weaponLevels[index] as number) > 0);
  const mobility = mobilityOf(c);
  const special = c.specialAction === null ? "" : `@${c.specialAction}`;
  return {
    classId: c.id,
    name: c.name,
    weapons,
    mobility,
    specialAction: c.specialAction,
    niche: `${weapons.length === 0 ? "none" : weapons.join("+")}|${mobility}${special}`,
  };
}
