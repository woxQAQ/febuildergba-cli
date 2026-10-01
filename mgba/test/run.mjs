#!/usr/bin/env node
/**
 * 用 fengari（Lua 5.3 的 JS 实现）跑 mgba/test/selftest.lua。
 *
 *   node mgba/test/run.mjs
 *
 * 为什么用 fengari：本机没有独立的 lua 解释器，而 mGBA 也不支持命令行载入脚本。
 * fengari 默认从本文件位置向上找 node_modules；装在别处时用 MGBA_TEST_WORKSPACE
 * 指到那个工作区（含 node_modules/fengari 的目录）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const WORKSPACE = process.env.MGBA_TEST_WORKSPACE;

const require = WORKSPACE
  ? createRequire(path.join(WORKSPACE, "package.json"))
  : createRequire(import.meta.url);

let fengari;
try {
  fengari = require("fengari");
} catch {
  console.error(`找不到 fengari。任选其一：`);
  console.error(`  在仓库根 npm install fengari（run.mjs 会向上找到 node_modules）`);
  console.error(`  或装在别处后设 MGBA_TEST_WORKSPACE=<那个目录>`);
  process.exit(2);
}

const { lua, lauxlib, lualib, to_luastring } = fengari;

const toJsString = (L, idx) => {
  if (typeof lua.lua_tojsstring === "function") return lua.lua_tojsstring(L, idx);
  return fengari.to_jsstring(lua.lua_tostring(L, idx));
};

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

// 告诉 selftest.lua 去哪里找被测脚本
const scriptPath = path.join(REPO, "mgba", "fe-aodian.lua");
lua.lua_pushstring(L, to_luastring(scriptPath));
lua.lua_setglobal(L, to_luastring("SCRIPT_PATH"));

// --preview：把面板渲染结果打出来，用来核对版式
lua.lua_pushboolean(L, process.argv.includes("--preview") ? 1 : 0);
lua.lua_setglobal(L, to_luastring("PREVIEW"));

const testPath = path.join(HERE, "selftest.lua");
const code = fs.readFileSync(testPath, "utf8");

const status = lauxlib.luaL_dostring(L, to_luastring(code));
if (status !== lua.LUA_OK) {
  console.error("Lua 执行失败：");
  console.error(toJsString(L, -1));
  process.exit(1);
}

lua.lua_getglobal(L, to_luastring("TEST_FAILURES"));
const failures = lua.lua_tointeger(L, -1);
process.exit(failures > 0 ? 1 : 0);
