import { candidatesOf } from "../analysis/service.ts";
import { defineDbCommand } from "./types.ts";

export const candidates = defineDbCommand({
  name: "candidates",
  input: "db",
  summary: "Audit candidate IDs, join overrides and branch-specific training facts",
  description:
    "The union of roster units and recognized joiners, joined by id with "
    + "availability, personal growths, unit-table baselines, earliest-map join "
    + "evidence and direct-branch projections/capabilities. `audit` reports exact "
    + "ID differences and evidence gaps. `baselineIssues` flags missing classes, "
    + "class/level overrides and entry autolevel without guessing which entry "
    + "is the actual one; affected plans "
    + "remain unit-table calculations, not verified entry projections. "
    + "`playOrder.lastPlayable` is a model endpoint, not a verified final chapter. "
    + "This command does not rank units, allocate items or prove recruit control, "
    + "equipment, training feasibility or a single executable story route.",
  run: async ({ extract }) => ({ data: await candidatesOf(extract) }),
});
