import { parseRom } from "../load.ts";
import type { UnitClass } from "../tables/classes.ts";
import type { Command } from "./types.ts";

export type Mobility = "flying" | "mounted" | "armour" | "normal";

/**
 * Mobility classification of one class. The mount flag decides first; the two
 * mechanical flier cross-checks (uniform movement costs / total terrain-bonus
 * immunity) only catch the airborne monster classes that carry no mount flag.
 * When config/data is absent every mount is null and non-fliers read as
 * "normal" - inferring more is an analysis convention, not a fact of the ROM.
 */
function mobilityOf(c: UnitClass): Mobility {
  if (c.mount === "wyvern" || c.mount === "pegasus") return "flying";
  if (c.mount === "horse") return "mounted";
  if (c.mount === "armour") return "armour";
  if (c.flying || c.terrainBonusImmune) return "flying";
  return "normal";
}

export const roles: Command = {
  name: "roles",
  summary: "Classify every class's mobility (flying/mounted/armour/normal)",
  description:
    "One row per non-empty class with its mobility role. Replaces the former " +
    "`class_roles` db view; the classification rule is unchanged: mount icon " +
    "flags first (wyvern/pegasus -> flying, horse -> mounted, armour -> " +
    "armour), then the mechanical flier checks on the movement-cost and " +
    "terrain-bonus tables.",
  run: ({ rom }) => {
    const parsed = parseRom(rom);
    return parsed.classes
      .filter((c) => !c.isEmpty)
      .map((c) => ({ classId: c.id, name: c.name, mount: c.mount, mobility: mobilityOf(c) }));
  },
};
