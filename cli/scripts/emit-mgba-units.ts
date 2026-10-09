/**
 * 生成 mgba/units.lua —— 给 mGBA 凹点助手用的「角色 id -> 名字」表。
 *
 * 用法：node scripts/emit-mgba-units.ts [--stem=dream-of-five]
 *
 * 为什么需要它：Lua 脚本运行时能从 ROM 里直接读到角色数据指针、成长率、
 * 职业上限，唯独**名字**是 u16 文本 id，要过 Huffman 解码才出得来 —— 那套
 * 逻辑已经在 cli/src/text/huffman.ts 里实现过了，没必要在 Lua 里再写一遍。
 * 所以这里把 id -> 名字 单独导出成一张小表。
 *
 * 输入是 `cli/out/<stem>.units.json`，由
 *
 *     node src/index.ts units <rom.gba> --all --out out/<stem>.units.json
 *
 * 产出（顶层是数组，不是 `{units:[...]}`），不重新解析 ROM。
 *
 * `--all` 不能省：Lua 侧要给敌人和泛用模板也显示名字，而 `units` 不带 `--all`
 * 时只输出有支援数据的名册（62 条 vs 249 条）。这条依赖以前只存在于生成结果
 * 的注释里，一旦用默认参数重跑，units.lua 会静默少掉四分之三。
 *
 * 这个脚本是 JSON payload 的消费者，而 payload 没有 schema 也没有版本戳，所以
 * 它对 shape 唯一能做的检查就是读进来时验一遍：字段不对就报错退出，而不是拿
 * undefined 拼出一张半空的 Lua 表。改动 `units` 命令的输出时，这里会立刻响。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'out');
const REPO = join(HERE, '..', '..');

const argv = process.argv.slice(2);
const stem = argv.find((a) => a.startsWith('--stem='))?.slice(7) ?? 'dream-of-five';

/**
 * The fields of a `units` row this script actually reads - deliberately not
 * the whole row, so a change to a field we ignore does not break us and a
 * change to one we use does.
 */
interface UnitRow {
  id: number;
  name: string;
}

function isUnitRow(value: unknown): value is UnitRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'number' && typeof row['name'] === 'string';
}

const parsed: unknown = JSON.parse(readFileSync(join(OUT, `${stem}.units.json`), 'utf8'));
if (!Array.isArray(parsed) || !parsed.every(isUnitRow)) {
  throw new Error(
    `${join(OUT, `${stem}.units.json`)} is not an array of {id, name} rows - ` +
      'the `units` payload changed shape. Regenerate it with ' +
      '`node src/index.ts units <rom.gba> --out out/<stem>.units.json`.',
  );
}
const units: readonly UnitRow[] = parsed;

/** Lua 长字符串里的名字不需要转义引号，但换行和控制字符要挡掉。 */
function luaString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ');
}

const rows: string[] = [];
const seen = new Set<number>();

for (const u of units) {
  if (u.id === 0) continue;
  if (!u.name || u.name.length === 0) continue;
  // 同一个 id 出现两次时以第一条为准（角色表是定长表，理论上不会重复）
  if (seen.has(u.id)) continue;
  seen.add(u.id);
  rows.push(`  [${u.id}] = "${luaString(u.name)}",`);
}

const lua = `-- 由 cli/scripts/emit-mgba-units.ts 生成，不要手改。
-- 数据来源：cli/out/${stem}.units.json（${rows.length} 条）
-- 用途：mgba/fe-aodian.lua 显示单位名字。读不到这张表时脚本会退化显示 "#<id>"。
return {
${rows.join('\n')}
}
`;

const target = join(REPO, 'mgba', 'units.lua');
writeFileSync(target, lua, 'utf8');
console.log(`wrote ${target} (${rows.length} units)`);
