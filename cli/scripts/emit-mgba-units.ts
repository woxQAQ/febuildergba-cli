/**
 * 生成 mgba/units.lua —— 给 mGBA 凹点助手用的「角色 id -> 名字」表。
 *
 * 用法：node scripts/emit-mgba-units.ts [db 路径]（默认 cli/out/dream-of-five.db）
 *
 * Lua 运行时能从 ROM 直接读到角色指针、成长率、职业上限，唯独名字是 u16 文本
 * id，要过 Huffman 解码；那套逻辑已在 cli/src/text/huffman.ts，故这里只把
 * id -> 名字导成一张小表。输入是 `fe-rom extract` 产出的 SQLite db：
 *     node src/index.ts extract <rom.gba> --out out/<stem>.db
 * 查 units 全量（含敌人和泛用模板，不能查 roster），不重新解析 ROM；列名显式
 * 写在 SQL 里，schema 变了会立刻报错。
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { and, asc, gt, ne } from "drizzle-orm";

import { openDb } from "../src/db/index.ts";
import { units } from "../src/db/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const dbPath = resolve(argv[0] ?? join(HERE, "..", "out", "dream-of-five.db"));

const handle = openDb(dbPath, { readOnly: true });
const rows = await handle.db
  .select({ id: units.id, name: units.name })
  .from(units)
  .where(and(gt(units.id, 0), ne(units.name, "")))
  .orderBy(asc(units.id))
  .all();
handle.close();

/** Lua 长字符串里的名字不需要转义引号，但换行和控制字符要挡掉。 */
function luaString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, " ");
}

const lines: string[] = [];

for (const u of rows) {
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
