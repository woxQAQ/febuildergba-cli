import type { AnalysisClass } from "../analysis/data.ts";
import { defineDbCommand } from "./types.ts";

export type Mobility = "flying" | "mounted" | "armour" | "normal";

/**
 * Mobility classification of one class. The mount flag decides first; the two
 * mechanical flier cross-checks (uniform movement costs / total terrain-bonus
 * immunity) only catch the airborne monster classes that carry no mount flag.
 * Stable mount flags remain decodable without config/data display labels.
 * Inferring more from movement costs is an analysis convention.
 */
function mobilityOf(c: AnalysisClass): Mobility {
  if (c.mount === "wyvern" || c.mount === "pegasus") return "flying";
  if (c.mount === "horse") return "mounted";
  if (c.mount === "armour") return "armour";
  if (c.flying || c.terrainBonusImmune) return "flying";
  return "normal";
}

export const roles = defineDbCommand({
  name: "roles",
  input: "db",
  summary: "Classify every class's mobility (flying/mounted/armour/normal)",
  description:
    "One row per non-empty class with its mobility role. Replaces the former " +
    "`class_roles` db view; the classification rule is unchanged: mount icon " +
    "flags first (wyvern/pegasus -> flying, horse -> mounted, armour -> " +
    "armour), then the mechanical flier checks on the movement-cost and " +
    "terrain-bonus tables.",
  run: async ({ extract }) => {
    return (await extract.classes())
      .filter((c) => !c.isEmpty)
      .map((c) => ({ classId: c.id, name: c.name, mount: c.mount, mobility: mobilityOf(c) }));
  },
});
