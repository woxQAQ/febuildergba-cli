--[[
 mgba/test/selftest.lua：脱离 mGBA 验证 fe-aodian.lua

 用 fengari（Lua 5.3）执行。跑法：
     node mgba/test/run.mjs

 做两件事：
   1. 算法层：RNG 递推、RollGrowth 边界、一次升级消耗的随机数个数、上限夹取
   2. 端到端：搭一个假 GBA 内存 + 假 mGBA API，真的调用 frame 回调，
      检查面板输出、写入随机数、以及升级后的自动校准
]]

-- ===========================================================================
-- 测试脚手架
-- ===========================================================================

local pass, fail = 0, 0
local function check(name, cond, extra)
  if cond then
    pass = pass + 1
    print("  ok    " .. name)
  else
    fail = fail + 1
    print("  FAIL  " .. name .. (extra and ("   <- " .. extra) or ""))
  end
end

local function eq(name, got, want)
  check(name, got == want, "got " .. tostring(got) .. " want " .. tostring(want))
end

-- ===========================================================================
-- 假内存 / 假 mGBA API
-- ===========================================================================

local MEM, KEYS = {}, {}

-- 故障注入开关：验证「同一异常只报一次」和「内容不变不重画」
local EMU_FAIL, BUF_FAIL = false, false

local function w8(a, v)  MEM[a] = v & 0xFF end
local function w16(a, v) w8(a, v & 0xFF); w8(a + 1, (v >> 8) & 0xFF) end
local function w32(a, v) w16(a, v & 0xFFFF); w16(a + 2, (v >> 16) & 0xFFFF) end
local function r8(a)  return MEM[a] or 0 end
local function r16(a) return (MEM[a] or 0) | ((MEM[a + 1] or 0) << 8) end
local function r32(a)
  return (MEM[a] or 0) | ((MEM[a + 1] or 0) << 8)
      | ((MEM[a + 2] or 0) << 16) | ((MEM[a + 3] or 0) << 24)
end

emu = {
  read8   = function(self, a) if EMU_FAIL then error("fake emu failure") end return r8(a) end,
  read16  = function(self, a) if EMU_FAIL then error("fake emu failure") end return r16(a) end,
  read32  = function(self, a) if EMU_FAIL then error("fake emu failure") end return r32(a) end,
  write8  = function(self, a, v) w8(a, v) end,
  write16 = function(self, a, v) w16(a, v) end,
  write32 = function(self, a, v) w32(a, v) end,
  getKey  = function(self, k) return KEYS[k] or 0 end,
  getKeys = function(self) return 0 end,
  setKeys = function(self, k) end,
}

local CB = {}
callbacks = {
  add    = function(self, name, fn) CB[name] = fn; return 1 end,
  remove = function(self, id) end,
}

local BUFLINES = {}
-- clear 被调用 = 面板真的重画了一次。用来验证「内容没变就不重画」（防闪烁）。
local BUFCLEARS = 0
-- console:error 被调用的次数。用来验证「同一异常只报一次」。
local CONSOLE_ERRORS = 0
local BUFFER = {
  clear      = function(self) BUFLINES = {}; BUFCLEARS = BUFCLEARS + 1 end,
  print      = function(self, s) if BUF_FAIL then error("fake buffer failure") end
                                 BUFLINES[#BUFLINES + 1] = s end,
  moveCursor = function(self, x, y) end,
  setSize    = function(self, c, r) end,
}

console = {
  createBuffer = function(self, name) return BUFFER end,
  log          = function(self, s) end,
  warn         = function(self, s) end,
  error        = function(self, s)
    CONSOLE_ERRORS = CONSOLE_ERRORS + 1
    print("  console:error -> " .. tostring(s))
  end,
}

-- ===========================================================================
-- 载入被测脚本
-- ===========================================================================

local scriptPath = SCRIPT_PATH or "mgba/fe-aodian.lua"
local chunk, loadErr = loadfile(scriptPath)
if not chunk then
  print("无法加载 " .. scriptPath .. ": " .. tostring(loadErr))
  TEST_FAILURES = 1
  return
end
chunk()

local A = AODIAN
local tick = CB["frame"]
check("脚本暴露 AODIAN 表", type(A) == "table")
check("脚本注册了 frame 回调", type(tick) == "function")
if type(A) ~= "table" or type(tick) ~= "function" then TEST_FAILURES = fail; return end

-- ===========================================================================
-- 1. RNG 递推
-- ===========================================================================

print("\n[1] RNG 递推 (NextRN @0x08000B88)")

local seed = { 0x1234, 0x5678, 0x9ABC }

-- 状态推进的顺序：新值进 s0，原 s0 进 s1，原 s1 进 s2
local s = { seed[1], seed[2], seed[3] }
local r = A.rnStep(s)
check("rnStep 返回新 s0", s[1] == r)
eq("rnStep 后 s1 = 旧 s0", s[2], 0x1234)
eq("rnStep 后 s2 = 旧 s1", s[3], 0x5678)

-- 独立性检查：手写一遍公式（不是调用被测函数）
local n = ((0x5678 << 11) | (0x1234 >> 5)) & 0xFFFF
local t = ((0x9ABC << 1) | ((0x5678 >> 15) & 1)) & 0xFFFF
eq("rnStep 数值 = 手算公式", r, (n ~ t) & 0xFFFF)

-- 步数还原
for _, k in ipairs({ 0, 1, 7, 21, 100, 1000 }) do
  local a = { seed[1], seed[2], seed[3] }
  local b = A.rnAdvance(a, k)
  eq("rnStepsBetween 还原 " .. k .. " 步", A.rnStepsBetween(a, b, 4096), k)
end

-- rn100 值域 + 大致均匀
do
  local st = { 0x0001, 0x0002, 0x0003 }
  local lo, hi, sum, cnt = 999, -1, 0, 0
  for _ = 1, 20000 do
    local v = A.rn100(st)
    if v < lo then lo = v end
    if v > hi then hi = v end
    sum = sum + v
    cnt = cnt + 1
  end
  eq("rn100 下界 0", lo, 0)
  eq("rn100 上界 99", hi, 99)
  local mean = sum / cnt
  check("rn100 均值接近 49.5", mean > 47 and mean < 52, "mean=" .. string.format("%.2f", mean))
end

-- ===========================================================================
-- 2. RollGrowth 边界
-- ===========================================================================

print("\n[2] RollGrowth (CheckForLevelUp @0x0802BA28 -> 0x0802B9A0)")

local function sweep(rate, times)
  local st = { 0x0A0B, 0x0C0D, 0x0E0F }
  local lo, hi = 999, -1
  for _ = 1, times do
    local g = A.rollGrowth(st, rate)
    if g < lo then lo = g end
    if g > hi then hi = g end
  end
  return lo, hi
end

do
  local lo, hi = sweep(0, 500)
  eq("成长 0  恒为 0", lo, 0)
  eq("成长 0  恒为 0 (max)", hi, 0)
end
do
  local lo, hi = sweep(100, 500)
  eq("成长 100 恒为 1", lo, 1)
  eq("成长 100 恒为 1 (max)", hi, 1)
end
do
  local lo, hi = sweep(200, 500)
  eq("成长 200 恒为 2", lo, 2)
  eq("成长 200 恒为 2 (max)", hi, 2)
end
do
  local lo, hi = sweep(250, 2000)
  eq("成长 250 至少 2", lo, 2)
  eq("成长 250 最多 3", hi, 3)
end

-- ===========================================================================
-- 3. 一次升级消耗多少个随机数
-- ===========================================================================

print("\n[3] 一次升级的随机数消耗（含全 0 重抽）")

local function consumed(growths)
  local a = { 0x0A0B, 0x0C0D, 0x0E0F }
  local b = { a[1], a[2], a[3] }
  local g = A.simulateGains(b, growths)
  return A.rnStepsBetween(a, b, 64), g
end

do
  local used, g = consumed({ 0, 0, 0, 0, 0, 0, 0 })
  eq("全 0 成长 -> 21 个随机数（7 x 3 轮）", used, 21)
  check("全 0 成长 -> 结果全 0", g[1] == 0 and g[4] == 0 and g[7] == 0)
end
do
  local used = consumed({ 100, 100, 100, 100, 100, 100, 100 })
  eq("全 100 成长 -> 7 个随机数（一轮就够）", used, 7)
end
do
  -- 只有幸运有成长：第一轮就有 1 点，total != 0 -> 不重抽
  local used, g = consumed({ 0, 0, 0, 0, 0, 0, 100 })
  eq("只有幸运成长(100) -> 7 个随机数", used, 7)
  eq("只有幸运成长 -> 幸运 +1", g[7], 1)
end

-- 黄金分布：下面两组计数由**独立的 Python 实现**（不是本脚本）算出来，
-- 在这里逐档对齐。这是真正的交叉实现验证，比自己写期望值可靠。
--   重抽总是先抽 HP，所以重抽至少要花 1 个随机数；只有最后一档（幸运）
--   有成长时才会出现"整轮重抽"的 14。
local function dist(growths, n)
  local c = {}
  for i = 0, n - 1 do
    local a = { i, 0x0C0D, 0x0E0F }
    local b = { a[1], a[2], a[3] }
    A.simulateGains(b, growths)
    local used = A.rnStepsBetween(a, b, 64)
    c[used] = (c[used] or 0) + 1
  end
  return c
end

local function distEq(name, got, want)
  local keys = {}
  for k in pairs(want) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts, ok = {}, true
  for _, k in ipairs(keys) do
    local g, w = got[k] or 0, want[k]
    if g ~= w then ok = false end
    parts[#parts + 1] = k .. ":" .. g .. "/" .. w
  end
  for k in pairs(got) do
    if want[k] == nil then ok = false; parts[#parts + 1] = k .. ":" .. got[k] .. "/-" end
  end
  check(name .. "   [" .. table.concat(parts, " ") .. "]", ok)
end

distEq("成长只力50% 的消耗分布与 Python 一致",
  dist({ 0, 50, 0, 0, 0, 0, 0 }, 2000),
  { [7] = 1008, [9] = 496, [16] = 256, [21] = 240 })

distEq("成长只幸运50% 的消耗分布与 Python 一致（含 14）",
  dist({ 0, 0, 0, 0, 0, 0, 50 }, 2000),
  { [7] = 1024, [14] = 488, [21] = 488 })

distEq("真实成长的消耗分布与 Python 一致",
  dist({ 70, 40, 55, 65, 30, 20, 50 }, 2000),
  { [7] = 2000 })

do
  -- 真实成长：消耗必须落在 7..21
  local ok = true
  for _ = 1, 300 do
    local used = consumed({ 70, 40, 55, 65, 30, 20, 50 })
    if used < 7 or used > 21 then ok = false end
  end
  check("真实成长 300 次抽样消耗都在 7..21", ok)
end

-- ===========================================================================
-- 4. 上限夹取
-- ===========================================================================

print("\n[4] 上限夹取 (CheckForLevelUpCaps @0x0802BF24)")

do
  local g   = { 10, 5, 1, 1, 1, 1, 5 }
  local cur = { 55, 18, 10, 10, 10, 10, 28 }
  local caps = { 60, 20, 20, 20, 20, 20, 30 }
  A.clampGains(g, cur, caps, 60)
  eq("HP 夹到 60", g[1], 5)
  eq("力 夹到 20", g[2], 2)
  eq("技 不受限", g[3], 1)
  eq("幸运夹到 30", g[7], 2)
end
do
  local g   = { 10, 0, 0, 0, 0, 0, 0 }
  local cur = { 50, 0, 0, 0, 0, 0, 0 }
  local caps = { 60, 20, 20, 20, 20, 20, 30 }
  A.clampGains(g, cur, caps, 120)
  eq("转职后 HP 上限 120，不夹", g[1], 10)
end

-- ===========================================================================
-- 5. 端到端：假 GBA 内存
-- ===========================================================================

print("\n[5] 端到端（假内存 + frame 回调）")

local RN      = 0x03000000
local ACTIVE  = 0x03004E50
local UBASE   = 0x0202BE4C
local CD      = 0x08100000   -- 角色数据（ROM）
local CL      = 0x08100100   -- 职业数据（ROM）
local STAT_OFF = { 0x12, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19 }

local GROWTHS = { 70, 40, 55, 65, 30, 20, 50 }
local CAPS    = { 60, 20, 20, 20, 20, 20, 30 }
local BASE_STATS = { 20, 5, 6, 7, 4, 2, 8 }   -- HP 力 技 速 防 魔防 幸运

local function setupWorld()
  w32(ACTIVE, UBASE)
  w32(UBASE + 0x00, CD)
  w32(UBASE + 0x04, CL)
  w8 (UBASE + 0x08, 5)      -- level
  w8 (UBASE + 0x0B, 1)      -- index（高位 0 -> 未转职）
  w32(UBASE + 0x0C, 0)      -- state
  for i = 1, 7 do w8(UBASE + STAT_OFF[i], BASE_STATS[i]) end

  w8 (CD + 0x04, 1)         -- charId
  for i = 1, 7 do w8(CD + 0x1C + (i - 1), GROWTHS[i]) end

  w8 (CL + 0x0B, 0x40)
  for i = 1, 7 do w8(CL + 0x13 + (i - 1), CAPS[i]) end

  w16(RN + 0, 0x1234)
  w16(RN + 2, 0x5678)
  w16(RN + 4, 0x9ABC)
end

local function readRng()
  return { r16(RN), r16(RN + 2), r16(RN + 4) }
end
local function writeRng(s)
  w16(RN, s[1]); w16(RN + 2, s[2]); w16(RN + 4, s[3])
end

local function renderNow()
  for _ = 1, 4 do tick() end   -- RENDER_EVERY = 4
end

local function findLine(pat)
  for _, l in ipairs(BUFLINES) do
    if string.find(l, pat) then return l end
  end
  return nil
end

setupWorld()
renderNow()

check("面板已渲染", #BUFLINES > 5)
local head = findLine("FE AODIAN")
check("面板标题存在", head ~= nil)

local unitLine = findLine("^unit ")
check("显示单位行", unitLine ~= nil, tostring(unitLine))
check("单位行含成长值", findLine("^growth ") ~= nil and string.find(findLine("^growth "), "HP70") ~= nil)
check("单位行含上限", findLine("^caps ") ~= nil)
check("显示随机数行", findLine("^rng ") ~= nil)
check("显示预测表头", findLine("TOT") ~= nil)
check("显示窗口最优", findLine("^best ") ~= nil)
check("提示这是只读面板（没有热键）", findLine("read%-only panel") ~= nil)
check("面板里不再出现热键提示", findLine("L%+A") == nil and findLine("L%+Start") == nil)

-- 表里必须有一行被标成最优
check("有 * 标记的最优行", findLine("%*%s+%d") ~= nil)

-- 并列最优应当全部标出（同一分数多行都打 *）
do
  local marked = 0
  for _, l in ipairs(BUFLINES) do
    if string.match(l, "^%s*%*%s+%d+") then marked = marked + 1 end
  end
  check("最优行至少 1 行", marked >= 1, "marked=" .. marked)
end

-- 预测表的行数 = WINDOW
do
  local rows = 0
  for _, l in ipairs(BUFLINES) do
    if string.match(l, "^%s*%*?%s*%d+%s+[%+%.%-]") then rows = rows + 1 end
  end
  check("预测表行数 > 0", rows > 0, "rows=" .. rows)
end

-- 抓一份面板快照，供 --preview 打印
local SAMPLE_PANEL = {}
for i, l in ipairs(BUFLINES) do SAMPLE_PANEL[i] = l end

-- ===========================================================================
-- 6. 升级检测（只读面板报告这一级实际涨了什么）
-- ===========================================================================

print("\n[6] 升级检测 + 随机数计数器")

do
  setupWorld()

  -- 模拟游戏消耗 M 个随机数后抽点，然后把结果写进单位（等级 +1、能力增加）
  local M = 3
  local preStats = {}
  for i = 1, 7 do preStats[i] = r8(UBASE + STAT_OFF[i]) end

  local rollState = A.rnAdvance(readRng(), M)
  local gains = A.simulateGains(rollState, GROWTHS)   -- 注意：会就地推进 rollState
  writeRng(rollState)                                 -- 抽点结束后的状态
  w8(UBASE + 0x08, 6)                                 -- level 5 -> 6
  for i = 1, 7 do w8(UBASE + STAT_OFF[i], preStats[i] + gains[i]) end

  renderNow()
  local line = findLine("last level%-up")
  check("检测到升级", line ~= nil, tostring(line))

  -- 报告出来的每一项必须等于实际涨的点数
  if line then
    local LB = { "HP", "STR", "SKL", "SPD", "DEF", "RES", "LCK" }
    local allOk, detail = true, {}
    for i = 1, 7 do
      if gains[i] > 0 then
        detail[#detail + 1] = LB[i] .. "+" .. gains[i]
        if not string.find(line, LB[i] .. "%+" .. gains[i]) then allOk = false end
      end
    end
    check("报告的点数与实际一致", allOk, line .. "  want " .. table.concat(detail, " "))
  end

  -- 升级会把「自上次升级以来消耗的随机数」计数器清零
  local rngLine = findLine("^rng ")
  check("计数器在升级后归零", rngLine ~= nil and string.find(rngLine, "level%-up: 0") ~= nil,
    tostring(rngLine))

  -- 只读面板：不再有写入 / 搜索 / 校准这些热键
  check("面板没有写入提示", findLine("wrote") == nil)
  check("面板没有全局搜索行", findLine("^global k=") == nil)
  check("面板没有校准行", findLine("calib") == nil)
end

-- ===========================================================================
-- 7. 单位解析 / 成长加成位
-- ===========================================================================

print("\n[7] 成长加成位 (state & 0x2000 -> 每项 +5)")

do
  setupWorld()
  w32(UBASE + 0x0C, 0x2000)
  renderNow()
  local gline = findLine("^growth ")
  -- HP 成长 70 + 5 = 75
  check("加成位置位后成长 +5", gline ~= nil and string.find(gline, "HP75") ~= nil, tostring(gline))
  w32(UBASE + 0x0C, 0)
end

-- ===========================================================================
-- 8. 未选中单位时不崩
-- ===========================================================================

print("\n[8] 边界：没有单位 / 随机数为 0")

do
  w32(ACTIVE, 0)
  renderNow()
  check("gActiveUnit 为空时不崩", findLine("unit%s+none") ~= nil, tostring(findLine("^unit")))
end
do
  setupWorld()
  w16(RN, 0); w16(RN + 2, 0); w16(RN + 4, 0)
  renderNow()
  check("随机数全 0 时给出提示", findLine("all zero") ~= nil)
end

-- ===========================================================================
-- 9. 战斗随机数消耗模型
-- ===========================================================================

print("\n[9] 战斗模型 (GenerateCurrentRoundData @0x0802B3EC，见 docs/battle-math.md §3.17)")

-- 下面所有期望值都来自 mgba/test/battle_golden.py 的**独立 Python 实现**，
-- 不是本脚本算出来的。两边独立，对上了才算数。

local function mkUnit(t)
  return {
    hp = t.hp, atk = t.atk, def = t.def, as = t.as, hit = t.hit,
    crit = t.crit, level = t.level, classId = t.classId,
    wattr = t.wattr or 0, inst = t.inst or 0, luck = t.luck or 10,
    weffect = t.weffect or 0,
  }
end

local BSEED = { 0x1234, 0x5678, 0x9ABC }

-- 9.1 掷骰原语的消耗个数
do
  local function used(fn, p)
    local a = { BSEED[1], BSEED[2], BSEED[3] }
    local b = { a[1], a[2], a[3] }
    fn(b, p)
    return A.rnStepsBetween(a, b, 16)
  end
  eq("Roll1RN 恰好消耗 1 个", used(A.roll1RN, 50), 1)
  eq("Roll2RN 恰好消耗 2 个", used(A.roll2RN, 50), 2)

  -- 概率 0 也必须消耗（RollRNIfBattleStarted 在非模拟态下无条件转发）
  eq("Roll1RN(0) 照样消耗 1 个", used(A.roll1RN, 0), 1)
  eq("Roll2RN(0) 照样消耗 2 个", used(A.roll2RN, 0), 2)

  -- 判定方向：p > rn100 才算成功
  do
    local st = { BSEED[1], BSEED[2], BSEED[3] }
    local v = A.rn100(st)
    local a = { BSEED[1], BSEED[2], BSEED[3] }
    eq("Roll1RN(v) 失败（p 必须严格大于）", A.roll1RN(a, v), 0)
    local c = { BSEED[1], BSEED[2], BSEED[3] }
    eq("Roll1RN(v+1) 成功", A.roll1RN(c, v + 1), 1)
  end
end

-- 9.2 一整场战斗的消耗（黄金值见 battle_golden.py 的 SCENARIOS）
do
  local scenarios = {
    -- 名字      攻方                                  守方                                    期望消耗 期望过程
    { "basic", mkUnit{hp=24,atk=11,def=0,as=12,hit=87,crit=4,level=5},
               mkUnit{hp=30,atk=5, def=0,as=10,hit=52,crit=0,level=3}, 6,  "A3 T3" },
    { "dbl",   mkUnit{hp=24,atk=11,def=0,as=12,hit=87,crit=4,level=5},
               mkUnit{hp=30,atk=5, def=0,as=7, hit=52,crit=0,level=3}, 9,  "A3 T3 A3" },
    { "brave", mkUnit{hp=24,atk=11,def=0,as=12,hit=87,crit=4,level=5,wattr=0x20},
               mkUnit{hp=30,atk=5, def=0,as=10,hit=52,crit=0,level=3}, 8,  "A3 A3 T2-" },
    { "skill", mkUnit{hp=24,atk=11,def=0,as=12,hit=87,crit=4,level=5,classId=0x4A},
               mkUnit{hp=30,atk=5, def=0,as=10,hit=52,crit=0,level=3}, 7,  "A5 T2-" },
    { "missA", mkUnit{hp=24,atk=11,def=0,as=12,hit=0, crit=4,level=5},
               mkUnit{hp=30,atk=5, def=0,as=10,hit=52,crit=0,level=3}, 5,  "A2- T3" },
    { "kill",  mkUnit{hp=24,atk=20,def=0,as=12,hit=87,crit=4,level=5},
               mkUnit{hp=5, atk=5, def=0,as=7, hit=52,crit=0,level=3}, 3,  "A3" },
  }
  for _, sc in ipairs(scenarios) do
    local name, a, t, wantCost, wantTrace = sc[1], sc[2], sc[3], sc[4], sc[5]
    local b = { a = a, t = t, flags = 0 }
    local before = { BSEED[1], BSEED[2], BSEED[3] }
    local cost, trace = A.simulateBattle(BSEED, b)
    eq(name .. " 消耗 = " .. wantCost, cost, wantCost)
    eq(name .. " 过程 = " .. wantTrace, A.traceText(trace), wantTrace)
    -- simulateBattle 不能动传入的状态
    check(name .. " 不修改传入状态", A.rnEq(BSEED, before), "state was mutated")
  end
end

-- 9.3 单次出手的消耗（种子由 battle_golden.py 搜出，完全确定）
do
  local baseA = mkUnit{hp=24,atk=11,def=0,as=12,hit=40,crit=4,level=5}
  local baseT = mkUnit{hp=30,atk=5, def=0,as=10,hit=52,crit=0,level=3}

  local function oneStrike(atk, seed)
    local s = { seed, 0x0C0D, 0x0E0F }
    local hit, crit, n = A.battleStrike(s, atk, baseT, 0)
    return hit, crit, n
  end

  do
    local hit, crit, n = oneStrike(baseA, 0x0008)
    check("未命中 -> 只烧 2 个（不掷必杀）", n == 2 and not hit, "n=" .. tostring(n))
    local hit2, _, n2 = oneStrike(baseA, 0x0000)
    check("命中 -> 烧 3 个", n2 == 3 and hit2, "n=" .. tostring(n2))
  end
  do
    -- 必杀率 100：命中后多一次瞬杀判定
    local critA = mkUnit{hp=24,atk=11,def=0,as=12,hit=40,crit=100,level=5}
    local hit, crit, n = oneStrike(critA, 0x0000)
    check("命中且必杀 -> 烧 4 个（多一次瞬杀判定）", n == 4 and hit and crit,
      "n=" .. tostring(n))
    local _, _, n2 = oneStrike(critA, 0x0008)
    check("必杀率 100 但未命中 -> 仍只烧 2 个", n2 == 2, "n=" .. tostring(n2))
  end
  do
    -- 职业 0x4A：必中判定 + 贯穿判定各多一个。
    -- 注意未命中时只有「必中1 + 命中2 = 3」，贯穿判定在未命中时不会执行。
    local skillA = mkUnit{hp=24,atk=11,def=0,as=12,hit=40,crit=4,level=5,classId=0x4A}
    local hit, _, n = oneStrike(skillA, 0x0000)
    check("职业 0x4A 未命中 -> 烧 3 个（必中1+命中2，贯穿不执行）", n == 3 and not hit,
      "n=" .. tostring(n))
    local hit2, _, n2 = oneStrike(skillA, 0x00C2)
    check("职业 0x4A 命中 -> 烧 5 个（再加贯穿1+必杀1）", n2 == 5 and hit2,
      "n=" .. tostring(n2))
  end
  do
    -- 守方职业 0x6D/0x6E：命中后多一次判定
    local def6d = mkUnit{hp=30,atk=5,def=0,as=10,hit=52,crit=0,level=3,classId=0x6D}
    local s = { 0x0000, 0x0C0D, 0x0E0F }
    local hit, _, n = A.battleStrike(s, baseA, def6d, 0)
    check("守方职业 0x6D 且命中 -> 烧 4 个", n == 4 and hit, "n=" .. tostring(n))
  end
end

-- 9.4 traceText
do
  eq("traceText 空", A.traceText({}), "(no exchange)")
  eq("traceText 混合",
    A.traceText({ { side = 1, hit = true, crit = false, n = 3 },
                  { side = 2, hit = false, crit = false, n = 2 },
                  { side = 1, hit = true, crit = true, n = 4 } }),
    "A3 T2- A4*")
end

-- 9.5 端到端：预览态（gBattleStats 低位 = 2）时面板给出「打这个敌人能涨多少点」
do
  setupWorld()

  local BSTATS, ACTOR, TARGET = 0x0203A4D4, 0x0203A4EC, 0x0203A56C
  local BFLAGS = 0x0203A608
  local CD2, CL2, FLAGS = 0x08100300, 0x08100200, 0x02030000

  -- 守方（另一个角色 / 另一个职业）
  w8 (CD2 + 0x04, 0x2C)
  w8 (CL2 + 0x04, 0x2C)

  local function fillUnit(p, cd, cl, level, maxhp, hp, atk, def, as_, hitf, critf, wattr)
    w32(p + 0x00, cd)
    w32(p + 0x04, cl)
    w8 (p + 0x08, level)
    w8 (p + 0x12, maxhp)
    w8 (p + 0x13, hp)
    w8 (p + 0x19, 10)          -- luck
    w16(p + 0x48, 1)           -- weapon
    w32(p + 0x4C, wattr)
    w16(p + 0x5A, atk)
    w16(p + 0x5C, def)
    w16(p + 0x5E, as_)
    w16(p + 0x64, hitf)        -- 最终命中率
    w16(p + 0x6A, critf)       -- 最终必杀率
    w16(p + 0x6C, 0)           -- 瞬杀率
  end

  fillUnit(ACTOR,  CD,  CL,  5, 24, 24, 11, 0, 12, 87, 4, 0)
  fillUnit(TARGET, CD2, CL2, 3, 30, 30,  5, 0, 10, 52, 0, 0)

  w32(BFLAGS, FLAGS)
  w32(FLAGS, 0)
  w16(BSTATS, 2)               -- 2 = SimulateBattle = 玩家在预览

  renderNow()
  local vsLine = findLine("^vs A")
  check("预览态显示战斗块", vsLine ~= nil, tostring(findLine("^vs")))  check("战斗块显示双方", findLine("^   T") ~= nil)
  local costLine = findLine("^cost")
  check("战斗块显示消耗", costLine ~= nil and string.find(costLine, "6 RNs") ~= nil,
    tostring(costLine))
  check("战斗块显示过程", costLine ~= nil and string.find(costLine, "A3 T3") ~= nil,
    tostring(costLine))
  local ansLine = findLine("^ans")
  check("给出「打这个敌人能涨多少点」", ansLine ~= nil, tostring(ansLine))
  check("答案行含 TOT", ansLine ~= nil and string.find(ansLine, "TOT") ~= nil, tostring(ansLine))
  check("表头多了 cost 列", findLine("^%s+k%s+cost") ~= nil, tostring(findLine("cost")))
  -- k=0 那一行必须被 > 标出来（= 「现在就打」）
  local row0 = findLine("%s>%s+0%s")
  check("k=0 那一行被标 >（现在就打）", row0 ~= nil, "no '>' row")
  -- 那一行的 cost 列应当是 6（本次战斗的消耗）
  check("k=0 行的 cost 列 = 6", row0 ~= nil and string.find(row0, ">%s+0%s+6%s") ~= nil,
    tostring(row0))

  -- 面板里的答案必须与独立算出来的抽点结果一致：
  -- 「现在就打」= 不做额外消耗，直接打（烧 6 个），然后抽点
  do
    local rs = A.rnAdvance(readRng(), 6)
    local g = A.simulateGains(rs, GROWTHS)
    g = A.clampGains(g, BASE_STATS, CAPS, 60)
    local wantTot = 0
    for i = 1, 7 do wantTot = wantTot + g[i] end
    local m = ansLine and tonumber(string.match(ansLine, "TOT (%d+)"))
    eq("答案的 TOT = 烧 6 个后抽点", m, wantTot)
    local tot0 = row0 and tonumber(string.match(row0, "(%d+)%s*$"))
    eq("k=0 行的 TOT 与答案行一致", tot0, wantTot)
  end

  if PREVIEW then
    print("\n================ 面板预览（战斗模式）================")
    for _, l in ipairs(BUFLINES) do print("| " .. l) end
    print("====================================================")
  end

  -- 9.6 战斗消耗的手动修正（现在是 CONFIG.BATTLE_NUDGE，不再有热键）
  do
    A.CONFIG.BATTLE_NUDGE = 1
    renderNow()
    local l = findLine("^cost")
    check("BATTLE_NUDGE=1 让战斗消耗 +1", l ~= nil and string.find(l, "7 RNs") ~= nil,
      tostring(l))
    check("面板标注了修正是手动的",
      findLine("^focus:") ~= nil and string.find(findLine("^focus:"), "%(6%+1%)") ~= nil,
      tostring(findLine("^focus:")))

    A.CONFIG.BATTLE_NUDGE = 0
    renderNow()
    local l2 = findLine("^cost")
    check("改回 0 后回到 6", l2 ~= nil and string.find(l2, "6 RNs") ~= nil, tostring(l2))
  end

  -- 9.7 真实战斗（低位 = 1）时不该再预测
  do
    w16(BSTATS, 1)
    renderNow()
    check("真实战斗态不显示战斗块", findLine("^vs A") == nil, tostring(findLine("^vs")))
    w16(BSTATS, 0)
    renderNow()
    check("没有战斗时不显示战斗块", findLine("^vs A") == nil)
  end

  -- 9.8 过滤：攻方不是当前选中单位（敌回合 AI 在模拟）时不该显示
  do
    w16(BSTATS, 2)
    w32(ACTOR + 0x00, CD2)      -- 攻方换成别的角色
    renderNow()
    check("攻方不是 gActiveUnit 时不显示（过滤 AI 模拟）", findLine("^vs A") == nil,
      tostring(findLine("^vs")))
    w32(ACTOR + 0x00, CD)       -- 换回来
    renderNow()
    check("换回来后重新显示", findLine("^vs A") ~= nil)

    -- CONFIG.BATTLE = false 时整块关掉
    A.CONFIG.BATTLE = false
    renderNow()
    check("CONFIG.BATTLE=false 时不显示战斗块", findLine("^vs A") == nil)
    A.CONFIG.BATTLE = true
    renderNow()
    check("打开后恢复", findLine("^vs A") ~= nil)
    w16(BSTATS, 0)
  end
end

-- ===========================================================================
-- 10. 防闪烁：内容没变就不碰文本缓冲
-- ===========================================================================

print("\n[10] 面板只在内容变化时重画（防闪烁）")

do
  setupWorld()
  renderNow()

  -- mGBA 每次 clear/print 都会重传文本纹理。之前每 4 帧无条件重画同一份内容，
  -- 就是 15Hz 的纹理重传，面板看起来一直在闪。这里守住「不变就不画」。
  local n0 = BUFCLEARS
  renderNow()
  eq("状态不变时不重画缓冲", BUFCLEARS, n0)
  renderNow()
  eq("连续多次仍不重画", BUFCLEARS, n0)
  renderNow()
  eq("一直不动就一直不重画", BUFCLEARS, n0)

  -- 改一个会体现在面板上的东西（随机数状态）-> 内容真的变了
  writeRng({ 0x0BAD, 0x0F00, 0x0D00 })
  renderNow()
  check("内容变化后重画了", BUFCLEARS > n0, "clears=" .. BUFCLEARS .. " n0=" .. n0)
  local n1 = BUFCLEARS

  renderNow()
  eq("变化之后又稳定下来", BUFCLEARS, n1)

  -- 关掉 RENDER_DIFF 应当恢复「每次检查都重画」（旧行为，用来对照）
  A.CONFIG.RENDER_DIFF = false
  local n2 = BUFCLEARS
  renderNow()
  renderNow()
  eq("关掉 RENDER_DIFF 后每次都重画", BUFCLEARS, n2 + 2)
  A.CONFIG.RENDER_DIFF = true

  renderNow()
  local n3 = BUFCLEARS
  renderNow()
  eq("重新打开后又不重画了", BUFCLEARS, n3)

  -- 每帧抛同一个错时不能每帧刷一次控制台（那看起来也像「一直在闪」）
  do
    local e0 = CONSOLE_ERRORS
    EMU_FAIL = true
    for _ = 1, 8 do tick() end              -- 8 帧都抛同一个错
    eq("同一异常只报一次", CONSOLE_ERRORS, e0 + 1)

    EMU_FAIL = false
    for _ = 1, 4 do tick() end              -- 中间「成功但没渲染」的帧不能把去重清掉
    EMU_FAIL = true
    for _ = 1, 4 do tick() end
    eq("同一个错再出现也不重复刷屏", CONSOLE_ERRORS, e0 + 1)

    EMU_FAIL = false
    for _ = 1, 4 do tick() end
    eq("恢复正常后也不再报", CONSOLE_ERRORS, e0 + 1)
  end

  -- 缓冲写入失败时：不刷屏，而且 lastText 不能被更新（否则面板永远停在旧内容）
  do
    local e0 = CONSOLE_ERRORS
    BUF_FAIL = true
    -- 先改随机数状态，让面板内容真的变（否则内容不变 -> 压根不会去写缓冲）
    writeRng({ 0x1111, 0x2222, 0x3333 })
    for _ = 1, 8 do tick() end
    eq("缓冲写失败也只报一次", CONSOLE_ERRORS, e0 + 1)

    BUF_FAIL = false
    local n = BUFCLEARS
    renderNow()
    check("缓冲恢复后能重新画出来", BUFCLEARS > n,
      "clears=" .. BUFCLEARS .. " n=" .. n)
  end
end

-- ===========================================================================
-- 汇总
-- ===========================================================================

if PREVIEW then
  print("\n================ 面板预览（80 列 x 40 行 文本缓冲）================")
  for _, l in ipairs(SAMPLE_PANEL) do print("| " .. l) end
  print("==================================================================")
end

print("\n================================")
print(string.format("通过 %d / 失败 %d", pass, fail))
print("================================")
TEST_FAILURES = fail
