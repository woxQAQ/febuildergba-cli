import { unitsOf } from "../analysis/service.ts";
import { defineDbCommand } from "./types.ts";

export const roster = defineDbCommand({
  name: "roster",
  input: "db",
  summary: "List the units that carry support data",
  description:
    "Every unit with a support-data pointer, in unit-table order. Replaces the "
    + "former `roster` db view (`SELECT * FROM units WHERE has_support_data = 1`); "
    + "like that view, empty unit slots are excluded - the extract never persists "
    + "them either.",
  run: async ({ extract }) => ({
    data: (await unitsOf(extract))
      .filter((u) => !u.isEmpty && u.hasSupportData)
      .map((u) => ({
        id: u.id,
        name: u.name,
        classId: u.classId,
        className: u.className,
        affinityId: u.affinityId,
        level: u.level,
      })),
  }),
});
