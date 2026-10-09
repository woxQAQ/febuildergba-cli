/**
 * 生成 mgba/units.lua —— 给 mGBA 凹点助手用的「角色 id -> 名字」表。
 *
 * 用法：node scripts/emit-mgba-units.ts [db 路径]
 *   默认 cli/out/dream-of-five.db
 *
 * 为什么需要它：Lua 脚本运行时能从 ROM 里直接读到角色数据指针、成长率、
 * 职业上限，唯独**名字**是 u16 文本 id，要过 Huffman 解码才出得来 —— 那套
 * 逻辑已经在 cli/src/text/huffman.ts 里实现过了，没必要在 Lua 里再写一遍。
 * 所以这里把 id -> 名字 单独导出成一张小表。
 *
 * 输入是 `fe-rom extract` 产出的 SQLite db：
 *
 *     node src/index.ts extract <rom.gba> --out out/<stem>.db
 *
 * 直接查 units 表全量（含敌人和泛用模板 —— Lua 侧要给他们也显示名字，
 * 所以不能查 roster 视图），不重新解析 ROM。列名显式写在 SQL 里，
 * schema 变了这里会立刻报错，而不是拼出一张半空的 Lua 表。
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const dbPath = resolve(argv[0] ?? join(HERE, "..", "out", "dream-of-five.db"));

const db = new DatabaseSync(dbPath, { readOnly: true });
let rows: { id: number; name: string }[];
try {
  rows = db
    .prepare("SELECT id, name FROM units WHERE id != 0 AND name != '' ORDER BY id")
    .all() as { id: number; name: string }[];
} finally {
  db.close();
}

/** Lua 长字符串里的名字不需要转义引号，但换行和控制字符要挡掉。 */
function luaString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, " ");
}

const lines: string[] = [];
const seen = new Set<number>();

for (const u of rows) {
  // 同一个 id 出现两次时以第一条为准（角色表是定长表，理论上不会重复）
  if (seen.has(u.id)) continue;
  seen.add(u.id);
  lines.push(`  [${u.id}] = "${luaString(u.name)}",`);
}

const lua = `-- 由 cli/scripts/emit-mgba-units.ts 生成，不要手改。
-- 数据来源：${dbPath}（units 表，${lines.length} 条）
-- 用途：mgba/fe-aodian.lua 显示单位名字。读不到这张表时脚本会退化显示 "#<id>"。
return {
${lines.join("\n")}
}
`;

const target = join(REPO, "mgba", "units.lua");
writeFileSync(target, lua, "utf8");
console.log(`wrote ${target} (${lines.length} units)`);
