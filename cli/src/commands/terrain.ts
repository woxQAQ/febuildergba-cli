import { terrainHint } from "../tables/terrainNames.ts";
import type { Command } from "./types.ts";

export const terrain: Command = {
  name: "terrain",
  summary: "Terrain names by terrain id (the ids the cost tables use)",
  description:
    "These ids are the same index space a class's movement-cost table is " +
    'read by, so this is what turns "cost 0xFF at id 0x12" into "Peak". ' +
    "`--all` also emits the slots this ROM left unnamed.",
  run: ({ rom, flags }) => {
    const { table, names } = rom.terrainNames;
    const isMultibyte = table?.isMultibyte ?? rom.layout.text.isMultibyte;

    return {
      table:
        table === null
          ? null
          : {
              recordSize: table.recordSize,
              count: table.count,
            },
      entries: (flags.all ? names : names.filter((n) => n.name !== "")).map((n) => ({
        id: n.id,
        name: n.name,
        hint: terrainHint(n.id, isMultibyte) || null,
        textId: n.textId,
        decoded: n.decoded,
      })),
      limitations: [
        "Terrain ids run 0..0x40 (65 entries) and match the movement-cost table " +
          "column order, so a class cost table and this table share an index.",
        "Japanese releases store these as raw Shift-JIS strings with no Huffman " +
          "layer; this CLI cannot decode Shift-JIS yet, so those entries come " +
          "back with decoded=false and the raw bytes.",
        "A name is only a label. The mechanical properties (cost, avoid, defence, " +
          "heal) live in the class cost table and the terrain avoid/defence/" +
          "resistance pointers, not here.",
      ],
    };
  },
};
