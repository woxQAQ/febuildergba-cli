--[[
============================================================================
 fe-aodian.lua — GBA 火纹「凹点」助手（mGBA Lua 脚本）
============================================================================

 做什么
 ------
 你在图上选中一个角色时，脚本实时算出：**从当前随机数状态出发，再消耗 k 个
 随机数之后升级，会得到哪些属性成长**，并直接标出让收益最大的那个 k。

 依据（全部来自反汇编本 ROM 自己的代码，不是猜的）
 ------------------------------------------------
 目标 ROM: fixtures/dream-of-five.gba（FE8U hack "DoF"）
 符号表:   FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt

 * 随机数状态 = 0x03000000 起的 3 个 u16
     NextRN      @0x08000B88
       n = ((s1 << 11) | (s0 >> 5)) & 0xFFFF
       t = ((s2 << 1) | (s1 >> 15)) & 0xFFFF
       r = n ^ t
       (s0, s1, s2) <- (r, s0, s1)
     NextRN_100  @0x08000C64 = (NextRN() * 100) >> 16      -> 0..99
     Roll1RN     @0x08000CA0 = (t > NextRN_100()) ? 1 : 0   -> 恰好消耗 1 个
   （0x03000000 这个地址由 NextRN / LoadRNState / StoreRNState 三处字面量
     互相印证；0x03000008 那个是另一个 RNG gOtherRNState，与升级无关。）

 * 升级抽点 = CheckForLevelUp @0x0802BA28，对 7 项成长各调一次
   RollGrowth @0x0802B9A0:
       g = 0
       while rate > 100: g += 1; rate -= 100     -- 成长 >100 时必得的部分
       if rate > NextRN_100(): g += 1            -- 余数部分
   7 项顺序 = HP, 力, 技, 速, 防, 魔防, 幸运
   成长率 = 角色数据 +0x1C..+0x22；若 unit->state(+0x0C) 的 bit 0x2000 置位
   则每一项 +5（Metis 类道具的成长加成）
   **7 项全 0 时游戏会重抽**：最多再抽 2 轮，每轮先抽 HP，一旦有任意一项非 0
   就立刻停止。所以一次升级消耗的随机数 ∈ {7, 8..14, 15..21}。

 * 抽完还要被 CheckForLevelUpCaps @0x0802BF24 夹到上限：
     HP 上限 60（未转职）/ 120（转职）—— 判据是 unit[+0x0B] & 0xC0 == 0x80
     力/技/速/防/魔防 上限 = 职业数据 +0x14..+0x18
     幸运 上限 30（硬编码）

 * 单位
     gActiveUnit = 指针 @0x03004E50        （SetActiveUnit @0x080186D4）
     gUnitArray  = 0x0202BE4C，步长 0x48，槽位 i（1 基）= 基址 + (i-1)*0x48
                   （步长由 ROM 自带的指针表 0x0859A5D0 实测：相邻差恒为 72）
     Unit(RAM):   +0x00 pCharacterData   +0x04 pClassData   +0x08 level
                  +0x09 exp               +0x0B index       +0x0C state(u32)
                  +0x12 最大HP  +0x14 力 +0x15 技 +0x16 速
                  +0x17 防      +0x18 魔防 +0x19 幸运
                  +0x73..0x79 上一次抽点结果（7 字节）
     CharacterData(ROM): +0x04 id, +0x1C..0x22 成长率(7)
     ClassData(ROM):     +0x0B 位 6-7, +0x13..0x19 上限(7)

 用法
 ----
 1. mGBA 载入 ROM -> Tools -> Scripting（工具 -> 脚本）-> Open 本文件。
 2. 脚本窗口出现「凹点助手」文本面板，每 RENDER_EVERY 帧检查一次（内容没变就不重画）。
 3. 图上选中角色（或让该角色行动），面板自动切到那个角色。
 4. 读表：k = 从当前状态还要消耗多少个随机数才开始抽点；TOT = 总成长点数。
    * 是当前评分最高的那一行。

 这是**只读面板** —— 没有任何热键，不会改内存，也不会往游戏里发按键。
    想换评分焦点 / 窗口起点 / 锁定某个槽位，改文件顶部的 CONFIG 再重新载入脚本。
    自动跟随 gActiveUnit 时，你选中谁面板就显示谁。

 关于「自上次升级以来消耗了多少随机数」
 ------------------------------------
 面板上的 `burned since level-up` 是游戏从上次升级到现在消耗掉的随机数个数。
 凹点的常规手法是「打敌人 -> 长经验 -> 升级」，这一仗本身也会烧随机数；把面板
 给的 k 和这个计数器对着看，就能验证预测准不准（见 battle cost 与 docs/battle-math.md §3.17）。

 已知不确定项
 -----------
 * m（动作本身消耗的随机数）只能实测标定，脚本推不出来。
 * 本 ROM 是 hack。若作者改过上面这些代码，脚本会失准；面板会出现
   "随机数状态异常"提示（三连全 0，或长时间不变）。
 * 换 ROM / 换版本（FE7U、FE8J 等）地址会变，需要重新反汇编，别直接套用。
============================================================================
]]

local CONFIG = {
  WINDOW          = 16,     -- 面板显示多少行预测
  FOCUS           = 0,      -- 0=总计, 1..7=HP/力/技/速/防/魔防/幸运（评分焦点）
  UNIT_MODE       = "auto", -- "auto" 用 gActiveUnit；"slot" 固定用 SLOT
  SLOT            = 1,      -- UNIT_MODE == "slot" 时用哪个槽位（1..62）
  K0              = 0,      -- 预测表窗口起点
  RENDER_EVERY    = 4,      -- 每多少帧检查一次面板（内容没变就不重画，见 RENDER_DIFF）
  RENDER_DIFF     = true,   -- true = 只在内容变化时才写缓冲（防闪烁）
  STEP_LIMIT      = 2048,   -- 单帧内最多追多少个随机数步（超过就认为测不准）
  BATTLE          = true,   -- true = 预测里计入「打这一仗」消耗的随机数（见 docs/battle-math.md §3.17）
  BATTLE_FILTER   = true,   -- 只认「攻方 = gActiveUnit」的战斗（过滤敌回合 AI 的模拟）
  BATTLE_NUDGE    = 0,      -- 战斗消耗的手动修正（模型在特殊职业/武器上可能差 1-2 个）
}

-- ===========================================================================
-- 内存布局常量
-- ===========================================================================

local RN_STATE     = 0x03000000  -- 3 x u16
local ACTIVE_UNIT  = 0x03004E50  -- u32 指针
local UNIT_ARRAY   = 0x0202BE4C  -- 玩家单位数组基址
local UNIT_STRIDE  = 0x48        -- 72 字节（玩家侧共 62 个槽位）

local U_CHAR, U_CLASS, U_LEVEL, U_INDEX, U_STATE = 0x00, 0x04, 0x08, 0x0B, 0x0C
local U_GAINS = 0x73
-- 内部顺序：HP, 力, 技, 速, 防, 魔防, 幸运
local STAT_OFF = { 0x12, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19 }

local CD_ID, CD_GROWTH = 0x04, 0x1C
local CL_FLAGS, CL_CAPS = 0x0B, 0x13

-- --- 战斗（全部由反汇编确证，见 docs/battle-math.md §3.17） ---------------------------
-- gBattleStats 的 u16 低位是**战斗模式**：BattleGenerateReal 写 1（真实战斗，
-- 掷骰），SimulateBattle 写 2（模拟/预览，Roll*IfBattleStarted 读到 &2 就跳过
-- 掷骰）。所以「玩家在攻击预览界面」= 低位为 2 —— 此时 gBattleActor /
-- gBattleTarget 已经填好，而随机数一个都还没烧。这正是要预测的时刻。
local BSTATS      = 0x0203A4D4  -- gBattleStats
local BU_ACTOR    = 0x0203A4EC  -- gBattleActor
local BU_TARGET   = 0x0203A56C  -- gBattleTarget
local BFLAGS_PTR  = 0x0203A608  -- u32 指针 -> u32 战斗标志位（bit14=必中…）

-- BattleUnit 的前 0x48 字节就是 RAM Unit（步长 0x48），战斗专用字段在其后。
local BU_CLASS                    = 0x04   -- pClassData（要解引用再读 +4）
local BU_LUCK                     = 0x19   -- 幸运（s8）
local U_HP                        = 0x13   -- 当前 HP（s8）
local BU_WPN, BU_WATTR            = 0x48, 0x4C
local BU_ATK, BU_DEF, BU_AS       = 0x5A, 0x5C, 0x5E
local BU_HIT, BU_AVO              = 0x60, 0x62
local BU_HITF                     = 0x64   -- 最终命中率 = hit - avoid（已夹 0..100）
local BU_CRIT, BU_DODGE, BU_CRITF = 0x66, 0x68, 0x6A
local BU_INSTK                    = 0x6C   -- 瞬杀率（职业特性，一般 0）

-- 职业 0x4A/0x4B 是「必中/贯穿」两个技能的职业（RollForSureShot / RollForPierce）
local SKILL_CLASS = { [0x4A] = true, [0x4B] = true }
-- 守方这两个职业免疫瞬杀判定
local INSTK_IMMUNE = { [0x4F] = true, [0x66] = true }
-- 勇者武器：武器属性位 0x20（BattleCheckBrave @0x0802B094）
local WATTR_BRAVE = 0x20
-- 追击门槛：|攻速差| >= 4（BattleCheckDoubling @0x0802AF90）
local DOUBLING_MIN = 4

-- 面板一律用 ASCII：mGBA 的脚本控制台是按等宽字体渲染的，中文是双宽字符，
-- 混进表格里列就对不齐了。中文说明放在注释和 README 里。
-- 内部顺序 = HP, 力, 技, 速, 防, 魔防, 幸运（与 ROM 里 STAT_OFF 一致）
local LABEL = { "HP", "STR", "SKL", "SPD", "DEF", "RES", "LCK" }
-- 显示顺序按 FE 习惯：HP STR SKL SPD LCK DEF RES
local DISP = { 1, 2, 3, 4, 7, 5, 6 }

-- ===========================================================================
-- 小工具
-- ===========================================================================

local function isRom(p)   return p ~= nil and p >= 0x08000000 and p < 0x0A000000 end
local function isEwram(p) return p ~= nil and p >= 0x02000000 and p < 0x02040000 end
local function h16(v)     return string.format("%04X", v & 0xFFFF) end

local function s8(v)
  if v >= 128 then return v - 256 end
  return v
end

local function s16(v)
  if v >= 32768 then return v - 65536 end
  return v
end

-- 把 u16 钳到 [lo, hi]；看起来像垃圾（>0x7FFF 或明显超范围）就当 0。
-- 战斗字段在预览路径上确实会被写（0x0802A6DC 同时被 sim / real 调用），
-- 但万一将来读到没被初始化的字节，钳一下比信它好。
local function clampStat(v, lo, hi)
  if v > 0x7FFF then return 0 end
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

-- 成长点数的显示形式：+1 / -1 / .
local function gainCell(v)
  if v > 0 then return "+" .. v end
  if v < 0 then return "-" .. (-v) end
  return "."
end

-- 把 7 项成长拼成一行文本，只列非 0 的项
local function gainsText(g)
  local parts = {}
  for _, i in ipairs(DISP) do
    if g[i] ~= 0 then parts[#parts + 1] = LABEL[i] .. gainCell(g[i]) end
  end
  if #parts == 0 then return "(none)" end
  return table.concat(parts, " ")
end

-- ===========================================================================
-- RNG 模型（与 ROM 逐条对应）
-- ===========================================================================

local function rnStep(s)
  local s0, s1, s2 = s[1], s[2], s[3]
  local n = ((s1 << 11) | (s0 >> 5)) & 0xFFFF
  local t = ((s2 << 1) | ((s1 >> 15) & 1)) & 0xFFFF
  local r = (n ~ t) & 0xFFFF
  s[1], s[2], s[3] = r, s0, s1
  return r
end

local function rn100(s)
  return (rnStep(s) * 100) >> 16
end

-- RollGrowth @0x0802B9A0：rate 可以 >100
local function rollGrowth(s, rate)
  local g = 0
  while rate > 100 do
    g = g + 1
    rate = rate - 100
  end
  if rate > rn100(s) then g = g + 1 end
  return g
end

-- Roll1RN @0x08000CA0：`p > NextRN_100()`，**恰好消耗 1 个随机数**。
-- 注意：概率为 0 也照样消耗（RollRNIfBattleStarted 只是无条件转发给 Roll1RN）。
local function roll1RN(s, p)
  return (p > rn100(s)) and 1 or 0
end

-- Roll2RN @0x08000CB8：两次 NextRN_100 取平均再比，**恰好消耗 2 个**。
local function roll2RN(s, p)
  return (p > ((rn100(s) + rn100(s)) >> 1)) and 1 or 0
end

local function rnClone(s) return { s[1], s[2], s[3] } end
local function rnEq(a, b) return a[1] == b[1] and a[2] == b[2] and a[3] == b[3] end

local function rnAdvance(s, n)
  local t = rnClone(s)
  for _ = 1, n do rnStep(t) end
  return t
end

-- 从 a 走到 b 需要多少步；超过 limit 返回 nil
local function rnStepsBetween(a, b, limit)
  local t = rnClone(a)
  for i = 0, limit do
    if rnEq(t, b) then return i end
    rnStep(t)
  end
  return nil
end

-- CheckForLevelUp 的 7 次抽点 + 全 0 重抽（最多 2 轮）
local function simulateGains(s, growths)
  local g = { 0, 0, 0, 0, 0, 0, 0 }
  local total = 0
  for i = 1, 7 do
    g[i] = rollGrowth(s, growths[i])
    total = total + g[i]
  end
  if total ~= 0 then return g end

  local pass = 0
  while pass <= 1 do
    g[1] = rollGrowth(s, growths[1])
    if g[1] ~= 0 then return g end
    for i = 2, 7 do
      g[i] = rollGrowth(s, growths[i])
      if g[i] ~= 0 then return g end
    end
    pass = pass + 1
  end
  return g
end

-- CheckForLevelUpCaps 的夹上限
local function clampGains(g, cur, caps, hpCap)
  if cur[1] + g[1] > hpCap then g[1] = hpCap - cur[1] end
  for i = 2, 6 do
    if cur[i] + g[i] > caps[i] then g[i] = caps[i] - cur[i] end
  end
  if cur[7] + g[7] > 30 then g[7] = 30 - cur[7] end
  return g
end

-- 评分：焦点项优先，其次总计
local function score(g, focus)
  local total = 0
  for i = 1, 7 do total = total + g[i] end
  if focus == 0 then return total, total end
  return g[focus], total
end

local function better(a1, a2, b1, b2)
  if a1 ~= b1 then return a1 > b1 end
  return a2 > b2
end

-- ===========================================================================
-- 战斗随机数消耗模型（全部由反汇编确证，见 docs/battle-math.md §3.17）
-- ===========================================================================
--
-- 一次「出手」= MakeNextBattleHitRound -> GenerateCurrentRoundData，顺序是：
--
--   ① RollForSureShot @0x0802B1F4  职业 0x4A/0x4B 且武器属性不在 [0x35,0x37]
--                                  -> RollRNIfBattleStarted(等级)：消耗 1
--                                  成功则置标志 bit14（必中）
--   ② 命中判定  Roll2RNIfBattleStarted(最终命中率)        消耗 2（必中时跳过）
--   ③ 未命中就到此为止！GenerateCurrentRoundData 在 0x0802B43C 直接跳函数尾，
--      **后面的 0x802B2E8 与 RollForPierce 都不会执行**（这一步很容易搞反）
--   ④ 0x0802B2E8  标志位干净且守方职业 0x6D/0x6E -> 消耗 1
--   ⑤ RollForPierce @0x0802B278    职业 0x4A/0x4B -> 消耗 1
--   ⑥ 必杀判定  RollRNIfBattleStarted(最终必杀率)        消耗 1
--   ⑦ 瞬杀判定  仅必杀后，守方职业不是 0x4F/0x66 -> 消耗 1
--   ⑧ 0x0802B600  武器效果 4 且 幸运 < 30 -> RollRNIfBattleStarted(30-幸运) 1 个
--
-- 关键：⑥⑦⑧ 的概率为 0 也照样消耗随机数 —— RollRNIfBattleStarted 在非模拟态
-- 下无条件转发给 Roll1RN，而 Roll1RN 无条件调用一次 NextRN_100。
-- 全 ROM 消耗战斗随机数的地方只有这 8 处（用调用点扫描穷举出来）。
--
-- 轮次：攻方 -> 守方（能反击时）-> |攻速差| >= 4 时快的一方再来一次。
-- 勇者武器（武器属性 & 0x20）每次出手打两下。任一方 HP 归零立即结束。

-- 一次「出手」。flags 是战斗标志位（会跨回合保留），返回新 flags。
-- 返回 (命中, 必杀, 消耗随机数, 伤害, 新flags)
local function battleStrike(s, atk, def, flags)
  local n = 0
  -- RollForSureShot / RollForPierce 的前置：bit14 | bit15 | bit16 任一置位就跳过
  local clean = ((flags & 0x1C000) == 0)
  -- 0x0802B2E8 的前置多一条 bit1
  local clean2 = ((flags & 0x1C002) == 0)

  -- ① RollForSureShot
  if clean and SKILL_CLASS[atk.classId]
     and not (atk.wattr >= 0x35 and atk.wattr <= 0x37) then
    n = n + 1
    if roll1RN(s, atk.level) == 1 then flags = flags | 0x4000 end
  end

  -- ② 命中判定（必中时整段跳过，一个随机数都不烧）
  local hit
  if (flags & 0x4000) ~= 0 then
    hit = true
  else
    n = n + 2
    hit = roll2RN(s, atk.hit) == 1
  end

  -- ③ 未命中：后面的掷骰一个都不会发生
  if not hit then
    return false, false, n, 0, flags
  end

  -- ④ 0x0802B2E8：守方职业 0x6D/0x6E 时多一次判定
  --    （真正的条件还有「攻方武器效果 != 1」；武器效果要读道具表，脚本没读，按非 1 处理）
  if clean2 and (def.classId == 0x6D or def.classId == 0x6E) then
    n = n + 1
    roll1RN(s, atk.level)
  end

  -- ⑤ RollForPierce
  if clean and SKILL_CLASS[atk.classId] then
    n = n + 1
    if roll1RN(s, atk.level) == 1 then flags = flags | 0x14000 end
  end

  -- ⑥ 必杀判定
  n = n + 1
  local crit = roll1RN(s, atk.crit) == 1

  -- ⑦ 瞬杀判定
  if crit and not INSTK_IMMUNE[def.classId] then
    n = n + 1
    roll1RN(s, atk.inst)          -- 成功则伤害 = 127（见 GenerateCurrentRoundData）
  end

  -- ⑧ 武器效果 4（0x0802B600）：幸运 < 30 才掷
  if atk.weffect == 4 and atk.luck < 30 then
    n = n + 1
    roll1RN(s, 30 - atk.luck)
  end

  local dmg = atk.atk - def.def
  if dmg < 0 then dmg = 0 end
  if crit then dmg = dmg * 3 end
  return true, crit, n, dmg, flags
end

-- 模拟一整场战斗。state 不会被推进（内部用副本）。
-- 返回 cost（消耗的随机数个数）, trace（每次出手的记录）, hp（结束时的双方 HP）
local function simulateBattle(state, b)
  local s = rnClone(state)
  local flags = b.flags or 0
  local hp = { b.a.hp, b.t.hp }
  local trace = {}
  local cost = 0

  local function unitOf(i) return (i == 1) and b.a or b.t end

  local function doStrike(ai, di)
    local atk, def = unitOf(ai), unitOf(di)
    local times = ((atk.wattr & WATTR_BRAVE) ~= 0) and 2 or 1
    for _ = 1, times do
      if hp[di] <= 0 or hp[ai] <= 0 then return end
      local hit, crit, n, dmg, f = battleStrike(s, atk, def, flags)
      flags = f
      cost = cost + n
      if hit then hp[di] = hp[di] - dmg end
      trace[#trace + 1] = { side = ai, hit = hit, crit = crit, dmg = dmg, n = n }
    end
  end

  doStrike(1, 2)                                   -- 攻方
  if hp[1] > 0 and hp[2] > 0 then doStrike(2, 1) end  -- 守方反击
  if hp[1] > 0 and hp[2] > 0 then
    local diff = b.a.as - b.t.as
    if diff >= DOUBLING_MIN then doStrike(1, 2)
    elseif diff <= -DOUBLING_MIN then doStrike(2, 1) end
  end

  return cost, trace, hp
end

-- 把 trace 压成一行短文本，例如 "A3 T2* A4"：
-- A/T = 攻方/守方，数字 = 这一次出手烧掉的随机数，* = 必杀，- = 未命中
local function traceText(trace)
  local parts = {}
  for _, e in ipairs(trace) do
    local tag = (e.side == 1) and "A" or "T"
    local suf = e.crit and "*" or (e.hit and "" or "-")
    parts[#parts + 1] = tag .. e.n .. suf
  end
  if #parts == 0 then return "(no exchange)" end
  if #parts > 8 then
    local head = {}
    for i = 1, 8 do head[i] = parts[i] end
    return table.concat(head, " ") .. " ..."
  end
  return table.concat(parts, " ")
end

-- ===========================================================================
-- 名称表（可选，由 cli/scripts/emit-mgba-units.ts 生成 mgba/units.lua）
-- ===========================================================================

local NAMES = (function()
  local candidates = {
    "mgba/units.lua", "./units.lua", "units.lua",
  }
  for _, path in ipairs(candidates) do
    local chunk = loadfile(path)
    if chunk then
      local ok, t = pcall(chunk)
      if ok and type(t) == "table" then return t end
    end
  end
  return {}
end)()

-- ===========================================================================
-- 读单位
-- ===========================================================================

local function s8at(addr)  return s8(emu:read8(addr)) end
local function s16at(addr) return s16(emu:read16(addr)) end

local function rnState()
  return { emu:read16(RN_STATE), emu:read16(RN_STATE + 2), emu:read16(RN_STATE + 4) }
end

local function readUnit(p)
  if not isEwram(p) then return nil end
  local cd = emu:read32(p + U_CHAR)
  if not isRom(cd) then return nil end

  local level = s8at(p + U_LEVEL)
  if level <= 0 or level > 40 then return nil end

  local bonus = 0
  if (emu:read32(p + U_STATE) & 0x2000) ~= 0 then bonus = 5 end

  local growths = {}
  for i = 0, 6 do
    growths[i + 1] = emu:read8(cd + CD_GROWTH + i) + bonus
  end

  local stats = {}
  for i = 1, 7 do stats[i] = s8at(p + STAT_OFF[i]) end

  local caps = {}
  local cl = emu:read32(p + U_CLASS)
  if isRom(cl) then
    for i = 1, 7 do caps[i] = emu:read8(cl + CL_CAPS + (i - 1)) end
  else
    for i = 1, 7 do caps[i] = 99 end
  end

  local charId = emu:read8(cd + CD_ID)
  local promoted = (emu:read8(p + U_INDEX) & 0xC0) == 0x80

  return {
    ptr      = p,
    charId   = charId,
    name     = NAMES[charId] or ("#" .. charId),
    level    = level,
    growths  = growths,
    stats    = stats,
    caps     = caps,
    promoted = promoted,
    hpCap    = promoted and 120 or 60,
    rawIndex = emu:read8(p + U_INDEX),
  }
end

-- 按槽位（1 基）取单位
local function unitAtSlot(i)
  return readUnit(UNIT_ARRAY + (i - 1) * UNIT_STRIDE)
end

-- ===========================================================================
-- 读战斗单位
-- ===========================================================================

local function readBattleUnit(p)
  if not isEwram(p) then return nil end
  local cd = emu:read32(p + U_CHAR)
  local cl = emu:read32(p + BU_CLASS)
  if not isRom(cd) or not isRom(cl) then return nil end

  local maxhp = s8at(p + U_HP - 1)
  local hp    = s8at(p + U_HP)
  if maxhp <= 0 or maxhp > 120 or hp < 0 then return nil end

  local charId = emu:read8(cd + CD_ID)
  return {
    ptr     = p,
    charId  = charId,
    name    = NAMES[charId] or ("#" .. charId),
    classId = emu:read8(cl + 4),
    level   = s8at(p + U_LEVEL),
    hp      = hp,
    maxhp   = maxhp,
    luck    = s8at(p + BU_LUCK),
    atk     = emu:read16(p + BU_ATK),
    def     = emu:read16(p + BU_DEF),
    as      = s16at(p + BU_AS),
    hit     = clampStat(emu:read16(p + BU_HITF), 0, 100),
    crit    = clampStat(emu:read16(p + BU_CRITF), 0, 100),
    inst    = clampStat(emu:read16(p + BU_INSTK), 0, 100),
    wpn     = emu:read16(p + BU_WPN),
    wattr   = emu:read32(p + BU_WATTR),
    weffect = 0,          -- GetItemWeaponEffect 要读道具表；罕见武器才非 0，暂不建模
  }
end

-- 战斗标志位：0x0203A608 存的是一根指针，再解引用一次才是标志字。
local function readBattleFlags()
  local p = emu:read32(BFLAGS_PTR)
  if not isEwram(p) then return 0 end
  return emu:read32(p)
end

-- 读当前战斗。只有「模拟态」（gBattleStats 低位 & 2）才是玩家在预览 ——
-- 真实战斗（低位 1）时随机数已经在烧了，预测没意义，所以返回 nil。
local function readBattle()
  if not CONFIG.BATTLE then return nil end
  local raw = emu:read16(BSTATS)
  if (raw & 2) == 0 then return nil end

  local a = readBattleUnit(BU_ACTOR)
  local t = readBattleUnit(BU_TARGET)
  if not a or not t then return nil end

  -- 攻方应当是当前选中的单位，否则多半是敌回合 AI 在模拟（AiSimulateBattle）。
  -- 只有在能**明确判定**不是的时候才拒绝：gActiveUnit 读不到就放过，
  -- 免得过滤条件太严导致功能静默失效。读不到想要的战斗就把 CONFIG.BATTLE_FILTER 关掉。
  if CONFIG.BATTLE_FILTER then
    local act = emu:read32(ACTIVE_UNIT)
    if isEwram(act) then
      local acd  = emu:read32(act + U_CHAR)
      local acd2 = emu:read32(BU_ACTOR + U_CHAR)
      if isRom(acd) and isRom(acd2) and acd ~= acd2 then return nil end
    end
  end

  return { a = a, t = t, flags = readBattleFlags() }
end

-- ===========================================================================
-- 会话状态
-- ===========================================================================

local S = {
  unit        = nil,          -- 当前跟踪的单位
  autoUnit    = nil,          -- gActiveUnit 解析结果
  slotUnit    = nil,          -- 手动槽位解析结果
  mode        = CONFIG.UNIT_MODE,
  slot        = CONFIG.SLOT,

  lastState   = nil,          -- 上一帧的随机数状态
  curState    = nil,
  burn        = 0,            -- 自上一次升级以来消耗的随机数个数
  stepErr     = false,

  k0          = CONFIG.K0,    -- 窗口起点
  focus       = CONFIG.FOCUS,
  table       = {},           -- table[i] = {k=, gains=, s1=, s2=}
  tableState  = nil,          -- 表是按哪个状态算的
  best        = nil,          -- {k=, gains=, s1=, s2=}

  prevUnit    = nil,          -- 升级前快照（用来算这一级涨了什么）
  lastLevel   = nil,
  lastCharId  = nil,

  battle      = nil,          -- 当前战斗（预览态才非 nil）：{a=, t=, flags=}
  battleCost  = 0,            -- 模拟出的战斗随机数消耗（已含 CONFIG.BATTLE_NUDGE）
  battleRaw   = 0,            -- 未加 nudge 的模拟值
  battleTrace = nil,          -- 每次出手的记录
  battleKey   = nil,          -- 战斗身份（变了就重算表）
  battleNow   = nil,          -- 「现在就打」那一行（k=0）：{burn=, gains=, tot=}

  msg         = "",
  err         = "",
}

-- ===========================================================================
-- 战斗刷新
-- ===========================================================================

-- 读战斗 + 从当前随机数状态模拟一遍，算出消耗与过程。
--
-- 为什么「从当前状态出发模拟」是对的：预览态（gBattleStats 低位 = 2）下游戏
-- 一个随机数都还没烧，玩家一按 A 就会按这个顺序烧。所以这里模拟出来的就是
-- 真正会发生的那场战斗，cost 就是「打这个敌人要烧几个随机数」。
local function refreshBattle()
  local b = (S.curState and readBattle()) or nil
  if b then
    local n, trace, hp = simulateBattle(S.curState, b)
    b.raw       = n
    b.cost      = n + CONFIG.BATTLE_NUDGE
    if b.cost < 0 then b.cost = 0 end
    b.trace     = trace
    b.traceText = traceText(trace)
    b.endHp     = hp
    b.dmgA      = math.max(0, b.a.atk - b.t.def)
    b.dmgT      = math.max(0, b.t.atk - b.a.def)
  end
  S.battle      = b
  S.battleCost  = b and b.cost or 0
  S.battleRaw   = b and b.raw or 0
  S.battleTrace = b and b.trace or nil
end

-- ===========================================================================
-- 预测
-- ===========================================================================

-- 一行预测：state 已经推进到「开打前」。
--   battle == nil  -> 第 k 行的语义是「再烧 k 个随机数就抽点」
--   battle ~= nil  -> 先打这一仗（消耗 N 个），再抽点
-- 注意这是 O(k) 的。批量扫 k 时不要用它（会变成 O(K^2)，几千行能卡住 mGBA 几秒），
-- 用下面 rebuildTable 里那种「状态一路往前推」的增量写法。
-- 返回 (该行的战斗消耗, 七项成长已夹上限)
local function rowGains(state, unit, battle)
  local n = 0
  if battle then
    n = simulateBattle(state, battle) + CONFIG.BATTLE_NUDGE
    if n < 0 then n = 0 end
  end
  local g = simulateGains(rnAdvance(state, n), unit.growths)
  return n, clampGains(g, unit.stats, unit.caps, unit.hpCap)
end

-- 表里每一行：k -> 七项成长（已夹上限）。k 从 k0 起，共 WINDOW 行。
local function rebuildTable()
  local u = S.unit
  if not u or not S.curState then
    S.table, S.best, S.tableState = {}, nil, nil
    S.bestS1, S.bestS2 = nil, nil
    return
  end
  local battle = S.battle
  local t, best = {}, nil
  local s = rnAdvance(S.curState, S.k0)   -- 一次 O(k0)，然后逐行只推 1 步
  for k = S.k0, S.k0 + CONFIG.WINDOW - 1 do
    local n, g = rowGains(s, u, battle)   -- rowGains 内部只动副本，s 不被推进
    local s1, s2 = score(g, S.focus)
    t[#t + 1] = { k = k, gains = g, s1 = s1, s2 = s2, cost = n }
    if not best or better(s1, s2, best.s1, best.s2) then
      best = { k = k, gains = g, s1 = s1, s2 = s2, cost = n }
    end
    rnStep(s)
  end
  S.table, S.best, S.tableState = t, best, rnClone(S.curState)
  S.bestS1 = best and best.s1 or nil
  S.bestS2 = best and best.s2 or nil

  -- 「现在就打」= k=0 那一行（不做额外消耗，直接开打）。
  -- 注意它不等于「cost 那一行」：cost 列显示的是从**该行**出发再打这一仗要烧
  -- 多少，而抽点落在 k + cost(k) 处。单独算一遍，因为窗口滚动后 k=0 可能不在表里。
  if battle then
    local n0, g0 = rowGains(S.curState, u, battle)
    local _, t0 = score(g0, S.focus)
    S.battleNow = { burn = n0, gains = g0, tot = t0 }
  else
    S.battleNow = nil
  end
end

-- ===========================================================================
-- 升级检测
-- ===========================================================================

-- preUnit = 升级**之前**的快照，用来算这一级实际涨了什么
local function onLevelUp(preUnit, actual)
  S.msg = "last level-up: " .. gainsText(actual)
  S.burn = 0          -- 计数器按「自上次升级以来」重新起算
  S.stepErr = false
end

local function checkLevelUp(u)
  if not u then
    S.prevUnit, S.lastCharId, S.lastLevel = nil, nil, nil
    return
  end
  -- 用 charId 跟踪而不是指针：战斗时会切到临时战斗单位，指针会变
  if S.lastCharId == u.charId and S.lastLevel and u.level > S.lastLevel and S.prevUnit then
    local actual = {}
    for i = 1, 7 do actual[i] = u.stats[i] - S.prevUnit.stats[i] end
    onLevelUp(S.prevUnit, actual)
  end
  S.prevUnit = { growths = u.growths, stats = u.stats, caps = u.caps, hpCap = u.hpCap }
  S.lastCharId = u.charId
  S.lastLevel = u.level
end

-- ===========================================================================
-- 单位解析
-- ===========================================================================

local function resolveUnit()
  local autoU = nil
  local p = emu:read32(ACTIVE_UNIT)
  if isEwram(p) then autoU = readUnit(p) end
  S.autoUnit = autoU

  local slotU = unitAtSlot(S.slot)
  S.slotUnit = slotU

  if S.mode == "slot" then
    return slotU or autoU
  end
  return autoU
end

-- ===========================================================================
-- 面板
-- ===========================================================================

local buf = nil

-- 异常去重：如果某一帧开始每帧都抛同一个错，旧写法会把同样的消息每帧往
-- Scripting 控制台里灌一次 —— 看起来也像「一直在闪」。改成「只有错误消息
-- 变了才上报」：同一个错不管重复多少帧都只出现一次。
-- 不能用「成功后复位」来做：渲染每 RENDER_EVERY 帧才跑一次，中间那些
-- 「成功但没渲染」的帧会把状态复位，于是下一个失败帧又报一次 → 照样刷屏。
local lastErr = nil
local function reportError(err)
  local s = tostring(err)
  if s == lastErr then return end
  lastErr = s
  pcall(function() console:error("凹点助手异常: " .. s) end)
end

-- 上一次真正画到缓冲里的文本（行以 "\n" 连接）。
-- 这是防闪烁的关键：mGBA 每次 clear/print 都会把文本纹理重传一遍。
-- 之前是「每 RENDER_EVERY 帧无条件重画同一份内容」→ 15 Hz 的纹理重传 →
-- 面板看起来一直在闪。改成内容不变就一个字节都不碰缓冲。
local lastText = nil

local function initBuffer()
  if buf then return end
  -- mGBA 0.10.5 的签名是 createBuffer(name)，尺寸用 setSize(cols, rows) 另设
  local ok, b = pcall(function() return console:createBuffer("FE AODIAN") end)
  if ok and b then
    buf = b
    lastText = nil   -- 新缓冲是空的，下次 render 必须重画
    pcall(function() buf:setSize(80, 40) end)
  end
end

local function render()
  if not buf then return end
  local lines = {}

  lines[#lines + 1] = "=== FE AODIAN (RNG-abuse helper) ===  FE8U / DoF"
  lines[#lines + 1] = ""

  local u = S.unit
  if not u then
    lines[#lines + 1] = "unit   none  (gActiveUnit is null)"
    lines[#lines + 1] = "       (set CONFIG.UNIT_MODE=\"slot\" + CONFIG.SLOT to pin a slot)"
  else
    lines[#lines + 1] = string.format(
      "unit   %-14s Lv%-3d %-10s [%s]",
      u.name, u.level, u.promoted and "promoted" or "unpromoted",
      (S.mode == "auto") and "auto" or ("slot " .. S.slot)
    )
    local gl, cl = {}, {}
    for _, i in ipairs(DISP) do
      gl[#gl + 1] = LABEL[i] .. u.growths[i]
      -- 上限要显示**实际生效**的：HP 用 60/120，幸运硬编码 30，
      -- 而不是职业数据里那两个游戏根本不读的字节
      local cap = u.caps[i]
      if i == 1 then cap = u.hpCap end
      if i == 7 then cap = 30 end
      cl[#cl + 1] = LABEL[i] .. cap
    end
    lines[#lines + 1] = "growth " .. table.concat(gl, " ")
    lines[#lines + 1] = "caps   " .. table.concat(cl, " ")
  end

  lines[#lines + 1] = ""

  local st = S.curState
  if st then
    lines[#lines + 1] = string.format(
      "rng    %s %s %s   burned since level-up: %s",
      h16(st[1]), h16(st[2]), h16(st[3]),
      S.stepErr and "?" or tostring(S.burn)
    )
  else
    lines[#lines + 1] = "rng    unreadable"
  end

  lines[#lines + 1] = string.format(
    "focus: %s   battle cost: %d%s",
    (S.focus == 0) and "TOTAL" or LABEL[S.focus],
    S.battleCost,
    (CONFIG.BATTLE_NUDGE ~= 0)
      and string.format(" (%d%+d)", S.battleRaw, CONFIG.BATTLE_NUDGE) or ""
  )
  if S.err ~= "" then lines[#lines + 1] = "!! " .. S.err end
  lines[#lines + 1] = ""

  -- --- 战斗块 -------------------------------------------------------------
  local b = S.battle
  local hasBattle = (b ~= nil)
  if b then
    lines[#lines + 1] = string.format("vs A  %-13s Lv%-2d HP%3d/%-3d hit%4d crit%4d AS%4d dmg%3d",
      b.a.name, b.a.level, b.a.hp, b.a.maxhp, b.a.hit, b.a.crit, b.a.as, b.dmgA)
    lines[#lines + 1] = string.format("   T  %-13s Lv%-2d HP%3d/%-3d hit%4d crit%4d AS%4d dmg%3d",
      b.t.name, b.t.level, b.t.hp, b.t.maxhp, b.t.hit, b.t.crit, b.t.as, b.dmgT)
    lines[#lines + 1] = string.format("cost   %d RNs  (%s)", b.cost, b.traceText)
    -- 这是用户真正要的那一行答案：「当前状态下我去打这个敌人，能涨多少点」
    local now = S.battleNow
    if now then
      lines[#lines + 1] = string.format("ans    attack now -> TOT %d   %s",
        now.tot, gainsText(now.gains))
    else
      lines[#lines + 1] = "ans    attack now -> (no unit)"
    end
  else
    lines[#lines + 1] = "vs     no battle preview   (open the attack forecast to fill this in)"
  end
  lines[#lines + 1] = ""

  if hasBattle then
    lines[#lines + 1] = "-- burn k RNs, then fight, then level up (cost = battle RNs) --"
  else
    lines[#lines + 1] = string.format(
      "-- gains if the level-up roll starts after k more RNs (window %d..%d) --",
      S.k0, S.k0 + CONFIG.WINDOW - 1
    )
  end

  local head = string.format("%5s", "k")
  if hasBattle then head = head .. string.format("%5s", "cost") end
  for _, i in ipairs(DISP) do head = head .. string.format("%5s", LABEL[i]) end
  head = head .. "   TOT"
  lines[#lines + 1] = head

  for _, row in ipairs(S.table) do
    -- 并列最优全部标出来：随便挑哪一行都行，玩家可以选最容易凑到的 k
    local isBest = S.bestS1 and row.s1 == S.bestS1 and row.s2 == S.bestS2
    local m1 = isBest and "*" or " "
    -- > = 「现在就打」那一行（k=0，不做额外消耗直接开打）
    local m2 = (hasBattle and row.k == 0) and ">" or " "
    local s = string.format("%s%s %3d ", m1, m2, row.k)
    if hasBattle then s = s .. string.format("%5d", row.cost) end
    for _, i in ipairs(DISP) do s = s .. string.format("%5s", gainCell(row.gains[i])) end
    s = s .. string.format("   %3d", row.s2)
    lines[#lines + 1] = s
  end

  lines[#lines + 1] = ""

  if S.best then
    lines[#lines + 1] = string.format("best   k=%-6d TOT %-3d %s", S.best.k, S.best.s2, gainsText(S.best.gains))
  end

  if S.msg ~= "" then lines[#lines + 1] = "msg    " .. S.msg end
  lines[#lines + 1] = ""
  lines[#lines + 1] = "read-only panel: no hotkeys. tune CONFIG at the top of the .lua and reload."

  -- 内容没变就直接返回：不 clear、不 print → 不重传纹理 → 不闪。
  -- （mGBA 只会在缓冲被写过之后才重新上传它，所以「什么都不做」= 画面完全静止。）
  local text = table.concat(lines, "\n")
  if CONFIG.RENDER_DIFF and text == lastText then return end

  -- 故意不在这里 pcall：写失败就让它抛到 tick 的 pcall 里，由 reportError
  -- 去重后上报。这样既不会每帧刷屏，也能保证 lastText 不被错误地更新
  -- （否则缓冲一旦出问题，面板会永远停在旧内容）。
  buf:clear()
  for i = 1, math.min(#lines, 40) do
    buf:moveCursor(0, i - 1)
    buf:print(lines[i])
  end
  lastText = text
end

-- ===========================================================================
-- 主循环
-- ===========================================================================

local frame = 0

local function tick()
  frame = frame + 1
  if not emu then return end

  local ok, err = pcall(function()
    -- 1. 随机数状态 + 计步
    local cur = rnState()
    if cur[1] == 0 and cur[2] == 0 and cur[3] == 0 then
      S.err = "RNG state is all zero - wrong ROM, or not on the map yet"
    else
      S.err = ""
      if S.lastState then
        local n = rnStepsBetween(S.lastState, cur, CONFIG.STEP_LIMIT)
        if n then
          if not S.stepErr then S.burn = S.burn + n end
        else
          S.stepErr = true
        end
      end
    end
    S.lastState = cur
    S.curState = cur

    -- 2. 单位
    local u = resolveUnit()
    if u then checkLevelUp(u) end
    S.unit = u

    -- 2.5 战斗（只有预览态读得到；此时随机数还没开始烧，正好可以预测）
    refreshBattle()
    local bkey = nil
    if S.battle then
      bkey = string.format("%d|%d|%d|%d|%d|%d|%d",
        S.battle.a.ptr, S.battle.t.ptr,
        S.battle.a.hit, S.battle.t.hit,
        S.battle.a.crit, S.battle.t.crit, CONFIG.BATTLE_NUDGE)
    end
    local bchanged = (bkey ~= S.battleKey)
    S.battleKey = bkey

    -- 3. 需要时重算预测表
    if u and cur then
      if bchanged or not S.tableState or not rnEq(S.tableState, cur) then
        rebuildTable()
      end
    else
      S.table, S.best, S.tableState = {}, nil, nil
    end

    -- 4. 画面
    if frame % CONFIG.RENDER_EVERY == 0 then
      initBuffer()
      render()
    end
  end)

  if not ok then
    reportError(err)
  end
end

-- ===========================================================================
-- 启动
-- ===========================================================================

-- 对外暴露纯计算部分，方便脱离 mGBA 做单元测试
AODIAN = {
  rnStep = rnStep,
  rn100 = rn100,
  rollGrowth = rollGrowth,
  roll1RN = roll1RN,
  roll2RN = roll2RN,
  battleStrike = battleStrike,
  simulateBattle = simulateBattle,
  traceText = traceText,
  rnClone = rnClone,
  rnEq = rnEq,
  rnAdvance = rnAdvance,
  rnStepsBetween = rnStepsBetween,
  simulateGains = simulateGains,
  clampGains = clampGains,
  score = score,
  CONFIG = CONFIG,
}

if emu and callbacks then
  -- 只挂 frame：本脚本是只读面板，不读键、不改内存。
  callbacks:add("frame", tick)

  pcall(function() console:log("fe-aodian.lua loaded (read-only panel). See Tools > Scripting.") end)
else
  pcall(function() print("fe-aodian.lua: pure-computation mode (not running under mGBA)") end)
end
