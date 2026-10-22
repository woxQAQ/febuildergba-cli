import { buildUnitNameMap, unitNameOrId } from "../format.ts";
import { unitsOf } from "../analysis/service.ts";
import { defineDbCommand } from "./types.ts";

export interface SupportPair {
  a: number;
  b: number;
  aName: string;
  bName: string;
  /** 小 ID 单位指向大 ID 单位的原始记录；缺失方向保持 null。 */
  aToB: { initial: number; growth: number } | null;
  /** 大 ID 单位指向小 ID 单位的原始记录。 */
  bToA: { initial: number; growth: number } | null;
  /** 两个方向都存在，不保证数值相同或运行时可培养。 */
  reciprocal: boolean;
}

export const supports = defineDbCommand({
  name: "supports",
  input: "db",
  summary: "List support pairs, deduplicated from the asymmetric partner lists",
  description:
    "One row per support pair. Replaces the former `support_edges` db view: "
    + "the pair is normalized a < b. `aToB` and `bToA` retain each direction's "
    + "raw initial points and growth, or null when absent. `reciprocal` is true "
    + "only when both directions exist; it does not mean their values agree. "
    + "These are relationship facts, not achieved ranks, trained combat bonuses "
    + "or proof that the two units can share a deployment. Check availability, "
    + "affinity bonus data and this ROM's support rules before valuing a pair.",
  run: async ({ extract }) => {
    const names = buildUnitNameMap(await unitsOf(extract));
    const supportPartners = await extract.supportPartners();

    // Directed records keyed "unit>partner"; pairs keyed "a:b" with a < b.
    const directed = new Map<string, { initial: number; growth: number }>();
    const pairs = new Set<string>();
    for (const p of supportPartners) {
      directed.set(`${p.unitId}>${p.partnerId}`, { initial: p.initial, growth: p.growth });
      pairs.add(`${Math.min(p.unitId, p.partnerId)}:${Math.max(p.unitId, p.partnerId)}`);
    }

    return {
      data: [...pairs]
        .map((key): SupportPair => {
          const [a, b] = key.split(":").map(Number) as [number, number];
          const forward = directed.get(`${a}>${b}`);
          const reverse = directed.get(`${b}>${a}`);
          return {
            a,
            b,
            aName: unitNameOrId(names, a),
            bName: unitNameOrId(names, b),
            aToB: forward ?? null,
            bToA: reverse ?? null,
            reciprocal: forward !== undefined && reverse !== undefined,
          };
        })
        .sort((x, y) => x.a - y.a || x.b - y.b),
    };
  },
});
