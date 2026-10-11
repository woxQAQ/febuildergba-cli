import { parseRom } from "../load.ts";
import { buildUnitNameMap, unitNameOrId } from "../tables/units.ts";
import type { Command } from "./types.ts";

export const supports: Command = {
  name: "supports",
  summary: "List support pairs, deduplicated from the asymmetric partner lists",
  description:
    "One row per support pair. Replaces the former `support_edges` db view: " +
    "the pair is normalized a < b, `initial`/`growth` come from the a-side " +
    "record when it exists (otherwise the b-side), `reciprocal` marks whether " +
    "both directions declare the pair, and the reverse numbers are exposed so " +
    "a mismatch is visible rather than a parse error.",
  run: ({ rom }) => {
    const parsed = parseRom(rom);
    const names = buildUnitNameMap(parsed.units);

    // Directed records keyed "unit>partner"; pairs keyed "a:b" with a < b.
    const directed = new Map<string, { initial: number; growth: number }>();
    const pairs = new Set<string>();
    for (const e of parsed.supports.entries) {
      for (const p of e.partners) {
        directed.set(`${e.unitId}>${p.unitId}`, { initial: p.initial, growth: p.growth });
        pairs.add(`${Math.min(e.unitId, p.unitId)}:${Math.max(e.unitId, p.unitId)}`);
      }
    }

    return [...pairs]
      .map((key) => {
        const [a, b] = key.split(":").map(Number) as [number, number];
        const forward = directed.get(`${a}>${b}`);
        const reverse = directed.get(`${b}>${a}`);
        return {
          a,
          b,
          aName: unitNameOrId(names, a),
          bName: unitNameOrId(names, b),
          initial: forward?.initial ?? reverse?.initial ?? null,
          growth: forward?.growth ?? reverse?.growth ?? null,
          reciprocal: reverse !== undefined,
          reverseInitial: reverse?.initial ?? null,
          reverseGrowth: reverse?.growth ?? null,
        };
      })
      .sort((x, y) => x.a - y.a || x.b - y.b);
  },
};
