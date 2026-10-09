import type { Command } from "./types.ts";

/**
 * `items` — the item table, with the derived price columns.
 *
 * The ROM stores a **unit price** (`+26`); the shop price is `uses x unitPrice`
 * and the sell price is half that (`ItemForm.cs:309-311`). Both are computed
 * here so nobody has to re-derive them.
 */
export const items: Command = {
  name: "items",
  summary: "Item table: type, stats, rank, durability, unit/buy/sell price",
  description:
    "One row per item. `unitPrice` is the raw `+26` field; `buyPrice` and " +
    "`sellPrice` are derived. `--all` includes slots this ROM left unnamed.",
  run: ({ rom, flags }) => {
    const table = rom.itemData?.table ?? null;
    const rows = flags.all ? rom.items : rom.items.filter((i) => i.nameTextId !== 0);

    return {
      table:
        table === null
          ? null
          : {
              recordSize: table.recordSize,
              entriesRead: table.count,
              nonEmpty: rom.items.filter((i) => i.nameTextId !== 0).length,
            },
      priceRule: "buyPrice = uses x unitPrice (+26); sellPrice = buyPrice / 2",
      entries: rows.map((i) => ({
        id: i.id,
        name: i.name,
        type: i.typeName,
        rank: i.weaponRankLetter,
        /** Raw `+28` byte; a unit can equip when its own weapon level >= this. */
        rankValue: i.weaponRank,
        uses: i.uses,
        might: i.might,
        hit: i.hit,
        crit: i.crit,
        weight: i.weight,
        range: `${i.rangeMin}-${i.rangeMax}`,
        wexp: i.wexp,
        unitPrice: i.unitPrice,
        buyPrice: i.buyPrice,
        sellPrice: i.sellPrice,
        ...(i.nameUnknownCodes.length ? { unmappedNameCodes: i.nameUnknownCodes } : {}),
      })),
      limitations: [
        "Names are stored in FE8's item-name font, not in the normal text " +
          "encoding; they are decoded via the empirical table in text/itemFont.ts. " +
          "See that file for how the alphabet was recovered and which slots are " +
          "inferred rather than observed.",
        "The type field is 0-based in this ROM (0=sword), unlike FE6/FE7.",
        "Effectiveness / stat-bonus / staff-effect are pointers or ids that this " +
          "CLI reports verbatim; it does not resolve them to class lists or boosts.",
      ],
    };
  },
};
