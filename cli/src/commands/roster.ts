import type { Command } from "./types.ts";

export const roster: Command<"db"> = {
  name: "roster",
  input: "db",
  summary: "List the units that carry support data",
  description:
    "Every unit with a support-data pointer, in unit-table order. Replaces the " +
    "former `roster` db view (`SELECT * FROM units WHERE has_support_data = 1`); " +
    "like that view, empty unit slots are excluded - the extract never persists " +
    "them either.",
  run: ({ data }) => {
    return data.units
      .filter((u) => !u.isEmpty && u.hasSupportData)
      .map((u) => ({
        id: u.id,
        name: u.name,
        classId: u.classId,
        className: u.className,
        affinityId: u.attribute,
        level: u.level,
      }));
  },
};
