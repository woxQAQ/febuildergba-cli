# 战斗数学：升级抽点 / 掷骰 / 攻速追击 / 敌人属性（§3.15 / §3.17 / §3.18 / §3.20）

> 本文件是 [`AGENTS.md`](../AGENTS.md) 的拆分件，章节编号保持原样（`§x.y` 交叉引用仍有效，
> 被引章节可能落在其他文件里）。索引与拆分原因见 [`docs/README.md`](README.md)。

## 3. FE7 / FE8 数据字典

> 下面所有偏移都是 **file offset**（不是 GBA 地址）。GBA 地址 = file offset + `0x08000000`。
> 所有 `*_pointer` 字段都是**指针槽**，用前先 `p32()`。

### 3.15 升级抽点算术 + mgba 凹点助手 ⭐⭐⭐

**产物在 `mgba/`**（与 `cli/` 平级）：`fe-aodian.lua`（mGBA Lua 脚本）、`test/selftest.lua`
（124 项自测）、`test/battle_golden.py`（战斗模型的独立 Python 黄金值，见 §3.17）、
`test/run.mjs`（fengari 运行器）、`units.lua`（名字表，生成物）、`README.md`。

**做什么**：在图上选中角色时，实时算出「从当前随机数状态出发，再消耗 k 个随机数之后升级会
得到哪些属性成长」，标出收益最大的 k；**选中敌人看到攻击预览时，直接回答「现在就打这个敌人
能涨多少点」**（把这一仗本身消耗的随机数也算进去，见 §3.17）。

⚠️ **这是只读面板 —— 没有任何热键**（不读键、不写内存、不注入按键）。早先版本有一套
`L + …` 组合键（标记基准 / 切换单位 / 搜索 / 写入随机数），因为**和游戏自己的按键冲突**
（FE8 里 `L` 是切换光标单位）且实际用不上，已全部删除；原来靠热键调的参数改成
`CONFIG` 项（`FOCUS` / `K0` / `UNIT_MODE` / `SLOT` / `BATTLE_NUDGE`），改完重载脚本生效。
§3.15.5 保留了那次写入/校准尝试的教训（别再踩）。

**下面全部来自反汇编本 ROM 自己的代码**（`asmmap_FE8.txt` + capstone），不是猜的。

#### 3.15.1 RNG（`0x03000000` 起 3 个 u16）

```
NextRN      @0x08000B88
  n = ((s1 << 11) | (s0 >> 5)) & 0xFFFF
  t = ((s2 << 1)  | (s1 >> 15)) & 0xFFFF
  r = n ^ t
  (s0, s1, s2) <- (r, s0, s1)
NextRN_100  @0x08000C64 = (NextRN() * 100) >> 16     -> 0..99
Roll1RN     @0x08000CA0 = (t > NextRN_100()) ? 1 : 0 -> 恰好消耗 1 个
```

`0x03000000` 由 `NextRN` / `LoadRNState` / `StoreRNState` **三处字面量互相印证**。
⚠️ `0x03000008` 是**另一个** RNG（`gOtherRNState` / `GetOtherRN`），与升级无关。

#### 3.15.2 抽点（`CheckForLevelUp` @`0x0802BA28`）

对 **7 项成长**各调一次 `RollGrowth` @`0x0802B9A0`：

```
g = 0
while rate > 100: g += 1; rate -= 100    -- 成长 >100 时必得的部分
if rate > NextRN_100(): g += 1           -- 余数部分
```

- **7 项顺序 = HP, 力, 技, 速, 防, 魔防, 幸运**（`+0x1C..+0x22`）
  ⚠️ **≠ 界面顺序**（界面是 速/幸/防/魔），面板要重排。
- 成长率读角色数据 `+0x1C..+0x22`；若 `unit->state(+0x0C) & 0x2000` 置位则**每项 +5**
  （Metis 类道具的成长加成）。
- **7 项全 0 时游戏会重抽**：最多再抽 **2 轮**，每轮**先抽 HP**，一旦有任意一项非 0 就立刻停止。
  → 一次升级消耗的随机数 ∈ **`{7} ∪ [8,14] ∪ [15,21]`**。
  ⚠️ 只有**最后一项**（幸运）有成长时才会出现「整轮重抽」的 14 —— 因为重抽总是先抽 HP。

#### 3.15.3 上限夹取（`CheckForLevelUpCaps` @`0x0802BF24`）

| 项 | 上限 | 来源 |
|---|---|---|
| HP | **60**（未转职）/ **120**（转职） | 立即数；判据 `unit[+0x0B] & 0xC0 == 0x80` |
| 力/技/速/防/魔防 | 职业数据 `+0x14..+0x18` | 与 `unit[+0x12..0x18]` 比较后取 `min` |
| 幸运 | **30** | 硬编码 |

#### 3.15.4 需要的 RAM 地址

| 名 | 地址 | 怎么确认的 |
|---|---|---|
| 随机数状态 | `0x03000000` | `NextRN` / `LoadRNState` / `StoreRNState` 字面量 |
| `gActiveUnit` | `0x03004E50` | 反汇编 `SetActiveUnit` @`0x080186D4` |
| `gUnitArray` | `0x0202BE4C`，**步长 `0x48`** | ROM 自带指针表 `0x0859A5D0` 实测：相邻差恒 72 |

槽位 i（**1 基**）= 基址 + (i−1)×`0x48`。

**Unit（RAM）**：`+0x00` pCharacterData / `+0x04` pClassData / `+0x08` level / `+0x09` exp /
`+0x0B` index（6-7 位为转职标志）/ `+0x0C` state(u32) / `+0x12` 最大HP / `+0x14` 力 / `+0x15` 技 /
`+0x16` 速 / `+0x17` 防 / `+0x18` 魔防 / `+0x19` 幸运 / **`+0x73..0x79` 上次抽点结果（7 字节）**。

**CharacterData（ROM）**：`+0x04` unitId、`+0x1C..0x22` 成长率。
**ClassData（ROM）**：`+0x0B` 位 6-7、`+0x13..0x19` 上限。

#### 3.15.5 ⚠️ 已删除的「写入 + 校准」尝试，以及它留下的教训

早先版本有一套热键：`L+A` 标记基准、`L+R` 全范围搜索、`L+Start` 把 RNG 状态**直接写到**
最优位置。**已全部删除**（现在是只读面板）—— 原因一是和游戏自己的按键冲突（FE8 里 `L`
是切换光标单位），二是写入绕不开下面第 1 条。**如果以后要重做，别重踩：**

1. **`m` 静态推不出来。** 从「玩家按下」到「游戏真正开始抽点」之间还会消耗 **m 个**随机数
   （战斗里的命中/必杀判定等）。只能实测标定：按下 → 正常玩 → 等升级真的发生 → 反推 m。
2. **标定必须用「随机数状态」匹配，不能用「成长值」匹配。** 成长值只有 7 个 0..3 的数，
   在几千个候选 k 里**大量撞车**，会认错 k（症状：报 `m = -716` 这种离谱值）。
   正确做法：`D = rnStepsBetween(writeState, detState)`，对 `k ∈ [appliedK, D]` 检查
   `simulateGains(advance(writeState, k)) == actual` **且**尾巴
   `rnStepsBetween(st, detState, 32)` 存在；取尾巴最短的候选，并列时报歧义让人工调。
3. **必须用「升级前」的能力快照做上限夹取。** 用升级后的 unit 去算会算错上限。
4. **批量扫 k 必须增量推进状态。** 每个 k 都 `rnAdvance(state, k)` 是 **O(K²)**：
   4096 行要跑约 840 万次递推，会卡住 mGBA 几秒。`rebuildTable` 一律「状态一路往前推 1 步」。
   自测里有耗时守卫（`< 2s`）防止退化。

> 现在面板只输出**决策**（打哪个敌人 / 先烧几个随机数），操作由玩家自己做 ——
> 不改内存、没有 `m` 的不确定性、也不用和游戏抢按键。原来靠热键调的参数
> （焦点 / 窗口起点 / 锁定槽位 / 战斗消耗修正）都改成了 `CONFIG` 项。

#### 3.15.6 mGBA 0.10.5 的能力边界（踩过才知道）

- **没有 `gui` 绘图 API** —— 只有 `console:createBuffer(name)` 文本缓冲，
  尺寸另用 `setSize(cols, rows)` 设（`clear/moveCursor/print/setSize/cols/rows`）。
- **没有命令行载入脚本** —— 只能 GUI：`Tools → Scripting → Open`。
- 控制台按**系统等宽字体**渲染（二进制里有 `Courier` / `Monospace` / `setFontFamily`）
  → **面板必须纯 ASCII**（中文双宽会破坏表格对齐）。
- `emu:read8/16/32`、`emu:write8/16/32`、`emu:getKey(k)`（0..9 = A/B/Select/Start/Right/Left/
  Up/Down/R/L）、`emu:getKeys()`、`emu:setKeys(mask)`、`emu:currentFrame()`；
  `callbacks:add("frame"|"keysRead"|..., fn)`。
- ⭐ **面板闪烁 = 每帧无条件重画。** mGBA 每写一次文本缓冲（`clear`/`print`）就把整块
  文本纹理重传一遍；「每 RENDER_EVERY 帧 clear + 重画同一份内容」= 15 Hz 纹理重传
  → 看着一直在闪。修法：**内容不变就一个字节都不碰缓冲**（`CONFIG.RENDER_DIFF`）。
  同理，异常也不能每帧上报（`console:error` 刷屏也像在闪）—— 判据要取「错误消息变了
  才再报」，**不能取「成功后复位」**：渲染每 N 帧才跑一次，中间那些「成功但没渲染」
  的帧会把状态复位，下一个失败帧又报一次，照样刷屏。

#### 3.15.7 怎么验证（本机跑不了 mGBA GUI）

- **fengari**（Lua 5.3 的 JS 实现，装在托管 node 工作区）跑 `mgba/test/selftest.lua`：
  自建假 GBA 内存 + 假 mGBA API，真的调用 `frame` 回调走端到端。`node mgba/test/run.mjs [--preview]`。
- 关键数值（升级的随机数消耗分布）另用**独立的 Python 实现**产出黄金分布做交叉验证 ——
  ⚠️ 不要靠心算重抽规则，会错。
- 名字表 `mgba/units.lua` 由 `cli/scripts/emit-mgba-units.ts` 从 `cli/out/*.units.json` 生成，
  **不要手改**。

> 唯一验证缺口：**mGBA 实机加载**（GUI、无命令行脚本载入、无显示）只能由人工做一次。

---

### 3.17 战斗掷骰模型（一次「打这个敌人」烧掉多少随机数）⭐⭐⭐

**为什么需要**：凹点的实际手法是「打敌人 → 长经验 → 升级」。要回答「当前状态下打这个敌人能涨
多少点」，就得先算出**这一仗本身消耗几个随机数**，再把这几个数加到升级抽点之前。

**下面全部来自反汇编本 ROM 自己的代码**（`asmmap_FE8.txt` + capstone）+ **全 ROM 调用点穷举**
（`.workbuddy-ai/skills/febuildergba-rom-extraction/scripts/find_calls.py`）。

#### 3.17.1 两个掷骰原语（都是 1/2 个，且概率 0 也照烧）

```
Roll1RN  @0x08000CA0 : (P > NextRN_100()) ? 1 : 0   -> 恰好消耗 1 个
Roll2RN  @0x08000CB8 : (P > ((NextRN_100()+NextRN_100()) >> 1)) ? 1 : 0  -> 恰好消耗 2 个
```

⚠️ **`P == 0` 也照样消耗** —— `RollRNIfBattleStarted` 只是**无条件转发**给 `Roll1RN`，
`Roll1RN` 也无条件抽一个 `NextRN_100`。所以「必杀率 0」的普通攻击每次出手仍烧 1 个。
（`Roll2RN` 是**带符号**平均：`lsrs r0,r4,#0x1f; adds r4,r4,r0; asrs r4,r4,#1`。）

#### 3.17.2 `RollRNIfBattleStarted` 的门 —— 模拟态不掷骰

```
RollRNIfBattleStarted  @0x0802A52C  -> 转发 Roll1RN
Roll2RNIfBattleStarted @0x0802A558  -> 转发 Roll2RN
```

两者都先读 `gBattleStats(0x0203A4D4)` 的 u16，**`& 2` 不为 0 时直接返回 0，不掷骰**。
低位是**战斗模式**：

| 值 | 写入者 | 含义 |
|---|---|---|
| `1` | `BattleGenerateReal` @`0x0802A350` | **真实战斗** —— 随机数已经在烧了 |
| `2` | `SimulateBattle` @`0x0802A318` | **模拟 / 预览** —— 一个随机数都没烧 |

⭐ **这就是预测时机**：玩家在攻击预览界面时（`& 2 != 0`），`gBattleActor` / `gBattleTarget`
已经填好、而随机数还没开始烧 —— 正好可以在「按下确认之前」把整场消耗算出来。

#### 3.17.3 一次「出手」的完整顺序（`GenerateCurrentRoundData` @`0x0802B3EC`）

```
0802B3FE  strh r0,[r4,#4]     ; 伤害 = 0
0802B402  bl 0x802B1F4        ; ① RollForSureShot
0802B41E  bl 0x802A558        ; ② 命中判定（Roll2RNIfBattleStarted，全 ROM 唯一调用点）
0802B43C  b 0x802B55E         ; ③ 未命中 → 直接跳函数尾（④⑤ 都不执行）
0802B458  bl 0x802B2E8        ; ④ 守方职业 0x6D/0x6E 时多一次判定
0802B476  bl 0x802B278        ; ⑤ RollForPierce
0802B4B2  bl 0x802A52C        ; ⑥ 必杀判定
0802B4C2  bl 0x802B38C        ; ⑦ 瞬杀判定
```

外加 `MakeNextBattleHitRound` 里的 `0x0802B600` = ⑧（武器效果 4 且 幸运 < 30）。

| # | 消耗点 | 随机数 | 触发条件 |
|---|---|---|---|
| ① | `RollForSureShot` `0x0802B1F4` | 1 | 职业 `0x4A`/`0x4B` 且武器属性 ∉ `[0x35,0x37]`；成功置 `flags |= 0x4000`（必中） |
| ② | 命中判定 `0x0802B41E` | **2** | 必中未置位（必中时整段跳过，0 个）；`Roll2RN` 的**唯一**调用点 |
| ③ | **未命中 → 跳函数尾** | **0** | ④⑤⑥⑦⑧ **全部不执行** |
| ④ | `0x0802B2E8` | 1 | 标志位干净 且 守方职业 `0x6D`/`0x6E`（另有「攻方武器效果 ≠ 1」，未建模） |
| ⑤ | `RollForPierce` `0x0802B278` | 1 | 职业 `0x4A`/`0x4B`（**无**武器属性检查）；成功置 `flags |= 0x14000` |
| ⑥ | 必杀判定 `0x0802B4B2` | 1 | 命中后 |
| ⑦ | 瞬杀判定 `0x0802B38C` | 1 | 必杀后且守方职业 ∉ `{0x4F, 0x66}`（另 `0x1E` 直接返回 0） |
| ⑧ | 武器效果 `0x0802B600` | 1 | 武器效果 = 4 且 幸运 < 30 |

**①④⑤ 的「标志位干净」前置**：`flags & 0x1C000`（bit14/15/16）任一置位就跳过；
④ 多一条 `flags & 0x1C002`（含 bit1）。

**最关键的一条推论（一次普通出手）：`未命中 → 2`、`命中 → 3`、`命中且必杀 → 4`。**

**全 ROM 消耗点的穷举结果**（这是「没有漏点」的证据）：

- `Roll1RN` 的调用点只有 4 处：`0x0802A544`（`RollRNIfBattleStarted`）、`0x0802B9B0`
  （`RollGrowth`，升级）、`0x0802F04A`、`0x0802F242`。
- `Roll2RN` 的调用点**只有 1 处**：`0x0802A570`（`Roll2RNIfBattleStarted`）。
- `RollRNIfBattleStarted` 的调用点**只有 6 处**：`0x0802B24A`（①）、`0x0802B2BC`（⑤）、
  `0x0802B358`（④）、`0x0802B3B4`（⑦）、`0x0802B4B2`（⑥）、`0x0802B6AE`（⑧）。

#### 3.17.4 轮次结构（`0x0802AED0` 顶层）

```
0802AEDE  bl 0x802AF7C           ; InitBothSidesBattleUnits
0802AF00  bl BattleCheckBrave    ; 攻方
0802AF24  bl BattleCheckBrave    ; 守方
0802AF32  bl BattleCheckDoubling
```

```
攻方一次  →  守方一次（若双方都还活着）  →  |攻速差| >= 4 时快的一方再来一次
勇者武器（武器属性 & 0x20）每次出手打两下
任一方 +0x13（当前 HP，s8）归零立即结束
```

- `BattleCheckDoubling` @`0x0802AF90`：读两侧 `+0x5E`（s16，攻速），**`|diff| > 3`** 才追击；
  顺带按攻速交换两方指针；武器类型 `== 3`（杖）或 `GetItemAttributes == 0xb5` 直接返回 0。
- ⚠️ `0x0802B094` **不是** `BattleCheckBrave`：它读 `unit+0x4C` 的 `0x20` 位（武器属性），
  置位则设置**某个全局 u32**（`[0x0203A608]` 指向的对象）的 bit 4，**不消耗随机数**。
  符号表把 `0x0802B018` 命名为 `BattleCheckBrave`，实际函数体在 `0x0802B094`。

#### 3.17.5 `BattleUnit` 字段（步长 `0x80`，前 `0x48` 字节就是 RAM Unit）

| 偏移 | 含义 | 出处 |
|---|---|---|
| `+0x04` | pClassData | `0x0802B0CC` 等 |
| `+0x08` | 等级（s8） | ①④⑤ |
| `+0x13` | 当前 HP（s8） | `MakeNextBattleHitRound` @`0x802B884` |
| `+0x19` | 幸运（s8） | `0x0802AC54` / `0x0802B600` |
| `+0x48` | 武器 id (u16) | `0x0802B2E8` / `BattleCheckDoubling` |
| `+0x4A` | 武器类型 (u16) | `BattleCheckDoubling`（== 3 杖） |
| `+0x4C` | 武器属性 (u32) | `BattleCheckBrave`（bit `0x20` = 勇者） |
| `+0x5A` | 攻击力 (u16) | `BattleLoadAttack` |
| `+0x5C` | 防御力 (u16) | `BattleLoadDefense` |
| `+0x5E` | 攻击速度 (s16) | `BattleCheckDoubling` |
| `+0x60` | 命中 (u16，**未减回避**) | `BattleLoadHit` |
| `+0x62` | 回避 (u16) | `BattleLoadAvoid` |
| **`+0x64`** | **最终命中率**（已减回避、夹 0..100） | `0x0802AC60` |
| `+0x66` | 必杀 (u16，**未减必杀回避**) | `BattleLoadCrit` |
| `+0x68` | 必杀回避 (u16) | `BattleLoadDodge` |
| **`+0x6A`** | **最终必杀率**（crit − dodge） | `0x0802AC90` |
| `+0x6C` | 瞬杀率 (u16) | `0x0802AC90` 把 `0x6C` 当条件 |

⚠️ **游戏用的是 `+0x64` / `+0x6A`（最终值），不是 `+0x60` / `+0x66`。**
证据：`0x0802B1C4`（`MakeNextBattleHitRound` 第 1 个调用）把 `+0x64` → `gBattleStats+0x0A`、
`+0x6A` → `+0x0C`。而 `0x0802AC60`/`0x0802AC90` 的**唯一调用点**是 `0x0802A9AE`/`0x0802A9B6`
（在 `0x802A6DC` 内），`0x0802A6DC` 同时被 `BattleGenerateSimulationInternal`（`0x802A1E0`）与
`BattleGenerateRealInternal`（`0x802A2AA`）调用 → **预览态下这两个字段确实会被写，可信**。

**`gBattleActor` @`0x0203A4EC`** / **`gBattleTarget` @`0x0203A56C`**（差 `0x80`）。
**战斗标志位**：`0x0203A608` 存的是**一根指针**，再解引用一次才是 u32 标志字
（`MakeNextBattleHitRound` 的 `ldr r0,[pc]; ldr r3,[r0]; ldr r1,[r3]`）。

**伤害公式**：`Damage = attack(+0x5A) − defense(+0x5C)`（`0x0802B490`），夹到 `[0, 0x7F]`
（`0x0802B530`）；瞬杀成功则 `Damage = 0x7F`；必杀再 ×3（`0x0802B522`）。

**`SimulateBattle` 的调用点**（全 ROM 3 处）：`0x08022EF8`（玩家预览）、`0x0803DEEA`
（`AiSimulateBattle` @`0x0803DEC8`）、`0x0804A36E`。⚠️ 后两处会短暂置低位 2 ——
所以面板还要**过滤「攻方 = `gActiveUnit`」**（`BATTLE_FILTER`），否则敌回合 AI 的模拟会污染预测。

#### 3.17.6 产物与验证

- 面板新增：`vs A/T` 两行（双方等级/HP/命中/必杀/攻速/伤害）、`cost N RNs (A3 T2-)`
  （每次出手的消耗 + 必杀 `*` / 未命中 `-` 标记）、**`ans  attack now -> TOT n`**
  （= 用户要的答案）；预测表加 `cost` 列，`>` 标出「现在就打」（k=0）那一行。
- 手动修正战斗消耗改成 `CONFIG.BATTLE_NUDGE`（模型不准时用；面板会在 `focus:` 行标出
  `(raw±n)`）—— 原来那个 `R + ↑/↓` 热键已随整套热键一起删除。
- **黄金值**：`mgba/test/battle_golden.py` 按同样的反汇编结论**独立重写一遍** Python 实现，
  用 `find_seed()` 搜出「第一个产生指定消耗的种子」硬写进 Lua 侧 → 完全确定、可复现。
  六组场景：`basic 6 (A3 T3)` / `dbl 9 (A3 T3 A3)` / `brave 8 (A3 A3 T2-)` /
  `skill 7 (A5 T2-)` / `missA 5 (A2- T3)` / `kill 3 (A3)`。

#### 3.17.7 ⚠️ 三处仍然没建模（要读道具表，罕见武器才触发）

1. ⑧ 那次掷骰（武器效果 = 4）—— 面板里 `weffect` 恒为 0。
2. ④ 的「攻方武器效果 ≠ 1」排除项。
3. ①⑤ 的「武器属性 ∉ `[0x35,0x37]`」排除项。

> **战斗消耗是算出来的，不是实机量出来的** —— DoF 相对原版 FE8U 改了多少没验证过。
> 第一次用请先拿 `cost` 和「标记后烧掉的随机数」对一下，不一致用 `R + ↑/↓` 修。

---

### 3.18 攻速与追击 —— `BattleLoadAS` / `BattleCheckDoubling` ⭐⭐

经济报告要用「这把武器会不会让单位掉追击」，所以必须知道攻速和追击阈值**在 ROM 里怎么算**。
两条**不是公知公式，是反汇编核实的**。

#### 3.18.1 入口：FEBuilderGBA 的两个补丁文件

`FEBuilderGBA/FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/` 下有两个 `#ENGINE` 补丁，它们**直接标出了代码地址**：

| 补丁文件 | 字段 | 值 |
|---|---|---|
| `PATCH_Eliminate attack speed penalty.txt` | `DETERMINATION_ADDRESS` | `0x02AB92` |
| 同上 | `OFF` / `FIX` | `0x40 0x1A` → `0xC0 0x46`（即 `subs r0,r0,r1` → `nop`） |
| `PATCH_Required pursuit attack speed difference.txt` | `ADDRESS` | `0x02AFBC 0x2AFCE` |

⚠️ 这些地址是**文件偏移**（`file offset`），GBA 地址 = `+ 0x08000000`。

#### 3.18.2 `BattleLoadAS @ 0x0802AB74`（U 版；J 版 `0x0802AAE4`）

`asmmap_FE8.txt` 里 `0x802ab74  BattleLoadAS  {U}`。反汇编（Thumb）：

```
0802AB82  lsrs   r1, r7, #2       ; r1 = 物品字段 >> 2   （武器重量）
0802AB84  ldrsb  r0, [r4, r0]     ; r0 = 单位某字段（体格）
0802AB86  subs   r1, r1, r0       ; r1 = 重量 - 体格
0802AB88  cmp    r1, #0
0802AB8A  bge    #0x802ab8e       ; 负数就跳过下一句
0802AB8C  movs   r1, #0           ; ← 钳位：max(0, 重量 - 体格)
0802AB8E  movs   r0, #0x16
0802AB90  ldrsb  r0, [r4, r0]     ; r0 = 单位 +0x16（有符号字节）= 速度
0802AB92  subs   r0, r0, r1       ; ★ 速度 - 惩罚   ← 补丁标的 DETERMINATION_ADDRESS
0802AB94  adds   r1, r4, #0
0802AB96  adds   r1, #0x5e
0802AB98  strh   r0, [r1]         ; 存到 战斗单位 +0x5E = 攻速
0802AB9A  lsls   r0, r0, #0x10
0802AB9C  cmp    r0, #0
0802AB9E  bge    #0x802aba4
0802ABA0  movs   r0, #0
0802ABA2  strh   r0, [r1]         ; 攻速下限 0
```

**结论（已核实）**：`攻速 = 速度 − max(0, 武器重量 − 体格)`，且攻速存在**战斗单位 `+0x5E`（u16）**。

✅ **DoF 没改这段代码** —— ROM 在 `0x02AB92` 处的字节就是 `40 1A`，与补丁里 `OFF` 的值**逐字节相同**。
所以原版 FE8U 的攻速公式对本 hack 原样成立。

#### 3.18.3 `BattleCheckDoubling @ 0x0802AF90`（U 版；J 版 `0x0802AF00`）

`asmmap_FE8.txt` 里 `0x802af90  BattleCheckDoubling  {U}`。反汇编：

```
0802AFAE  ldrsh  r3, [r1, r5]     ; r3 = A 方攻速（+0x5E）
0802AFB2  ldrsh  r2, [r2, r1]     ; r2 = B 方攻速（+0x5E）
0802AFB4  subs   r1, r3, r2       ; r1 = AS_A - AS_B
0802AFB8  cmp    r1, #0
0802AFBA  blt    #0x802afcc       ; 负 → 跳到镜像分支
0802AFBC  cmp    r1, #3           ; ★ 补丁 ADDRESS 之一
0802AFBE  ble    #0x802b010       ; ≤ 3 → 不追击
0802AFC0  b      #0x802afd2       ; > 3 → 追击
0802AFCC  subs   r0, r2, r3       ; 镜像：AS_B - AS_A
0802AFCE  cmp    r0, #3           ; ★ 补丁 ADDRESS 之二
0802AFD0  ble    #0x802b010       ; ≤ 3 → 不追击
```

**结论（已核实）**：`追击 ⟺ |攻速差| ≥ 4`，且是**双向**的（谁快都能追）。两个 `cmp #3` 的地址
与补丁文件里写的 `0x02AFBC 0x2AFCE` **完全吻合** → 这个 hack 同样没动阈值。

#### 3.18.4 用起来要注意的

- **追击是「多打一次」，不是加 50% 伤害** —— `MakeBattleRound` 按 `GetBattleHitCount` 决定出手次数，
  一次命中变两次。
- **体格没有成长**（角色表/职业表里体格是固定值），所以早期速度低时同一把武器吃掉的攻速更多。
- ⚠️ **敌方攻速静态读不到**：FE8 的条件表只有 20 个槽位、**没有 `ENEMY_UNIT`**，敌人走
  **地图变更数据**（本 CLI 未解析）。所以经济报告里的「参考敌攻速」是**拍的常数**，
  必须给敏感性，不能当成实测。
- 攻速、追击阈值都拿到了，但**命中/必杀/伤害的完整链路**是另一套函数
  （`BattleLoadHit` `0x0802ABAC`、`ComputeHit` `0x0802AC60`、`ComputeCrit` `0x0802AC90`、
  `BattleLoadAvoid` `0x0802ABE4`、`BattleLoadDodge` `0x0802AC54`）—— 需要时照 3.13 的方法挖。

#### 3.18.5 特效武器 = 武器威力 ×3（`BattleLoadAttack` / `IsSlayerApplied`）

经济报告的 §3 性价比表**不建模特效**，所以「特效系排名很低」是个假象。真实倍率已核实：

`BattleLoadAttack @ 0x0802AABC`（U 版）里，算完基础攻击力之后：

```
0802AAE8  bl       #0x8016c88      ; IsSlayerApplied  → 特效是否成立
0802AAEC  lsls/asrs r0,r0,#0x18    ; 取返回值（有符号）
0802AAF0  cmp      r0, #1
0802AAF2  bne      #0x802ab00      ; 不成立 → 跳过
0802AAF4  movs     r0, #0
0802AAF6  ldrsh    r1, [r4, r0]    ; r1 = 武器威力（攻击力存在战斗单位 +0x5A）
0802AAF8  lsls     r0, r1, #1      ; r0 = 威力 × 2
0802AAFA  adds     r0, r0, r1      ; r0 = 威力 × 2 + 威力 = 威力 × 3   ★
0802AAFC  lsls     r0, r0, #0x10
0802AAFE  lsrs     r5, r0, #0x10   ; 截回 u16
```

**结论（已核实）**：特效成立时**武器威力 ×3**（`×2 + ×1` 的写法，不是「伤害 ×3」）。

相关函数与表：

| 名字 | 地址（U 版） | 作用 |
|---|---|---|
| `IsWeaponEffective` | `0x08016BEC` | 武器对该职业是否特效 |
| `IsSlayerApplied` | `0x08016C88` | 上面这段调用的判据 |
| `GetItemEffectivenessPtr` | `0x080176D0` | 取武器特效表 |
| `gSlayerEffectivenessTable` | `0x088ADF39` | 特效倍率表（**在数据段，不在代码段**） |

⚠️ **这条直接说明「每金换多少期望伤害」这个指标的天花板**：它衡量**效率**，不衡量**够不够**。
敌人防御一高，再便宜的武器也是 0 伤害 —— 那时 `期望/金` 这个比值本身就没有意义。
所以经济报告 §3 的排名只能用来决定「日常批量采购」，**特效系和银系该买什么必须看具体地图**。

#### 3.18.6 敌方属性能不能算？（能，但有随机成分；本 CLI 还没做）⭐⭐

经济报告里「参考敌攻速 = 常数 10」是**拍的**。被问到时核了一遍，结论分三层：

**① 公式是同一个。** `BattleLoadAS`（§3.18.2）对攻守双方都跑，没有「敌人专用公式」。
缺的只是**输入**：敌人的速度 / 体格 / 装备。

**② 输入本来拿得到 —— 卡在「敌人摆在哪儿」。**

- 敌人摆放记录是 **20 字节**（`eventunit_data_size = 20`），字段见 §3.11.3 那张表：
  `+0` unit_id / `+1` class_id / `+3`–`+4` 等级增长值 / `+12`–`+15` 携带道具。
  `EventUnitForm.cs:499-501` 就是这么读的。**有职业、有等级、有装备 → 属性可推。**
- ⚠️ **但 FE8 的条件表没有 `ENEMY_UNIT` 槽。** `EventCondForm.cs:1406-1417` 写得很清楚：

  | 版本 | 敌人配置槽 | 自军配置槽 |
  |---|---|---|
  | FE8 | **无** | 10 / 11 |
  | FE7 | 6 / 7（Eliwood 普通/困难）、8 / 9（Hector） | 10–13 |
  | FE6 | 5 | 4 |

  （FE8 的 `data/eventcond_FE8.txt` 只有 20 个槽名，里面确实没有 `ENEMY_UNIT`；
  它只有 `FREEMAP_ENEMY_UNIT` ×3，那是**魔物出现图**专用的。）
  → FE8 的初始敌人从别处进来，**本 CLI 没走通那条路**，所以 `ENEMY_AS` 只能拍。

**③ ⚠️ 就算走通了，敌方属性也不是纯确定值 —— 自动升级会烧随机数。**

`GetAutoleveledStat @ 0x0802B9C4`：

```
0802B9C8  muls     r4, r1, r4        ; v = 等级 × 成长
0802B9D2  asrs     r0, r0, #3        ; r0 = v / 8
0802B9D4  bl       #0x08000C80       ; ★ NextRN_N(v/8) —— 不是除法 helper，是随机数！
0802B9E2  asrs     r0, r0, #4        ; r0 = v / 16
0802B9E4  subs     r0, r1, r0        ; r0 = RN - v/16
0802B9E6  adds     r0, r4, r0        ; r0 = v + RN - v/16
0802B9E8  bl       #0x0802B9A0       ; GetStatIncrease(...)
```

`GetStatIncrease @ 0x0802B9A0`：

```
0802B9A4  cmp      r0, #0x64
0802B9A6  ble      #0x802b9b0
0802B9A8  adds     r4, #1            ; 每满 100 点 → 保底 +1
0802B9AA  subs     r0, #0x64
0802B9B0  bl       #0x08000CA0       ; ★ Roll1RN(...) —— 决定余数进不进位
0802B9BA  adds     r4, #1
```

**结论**：敌方属性 = **`成长 × 等级 / 100`**（基准，确定）+ 一个很小的随机成分
（`±v/16` 的抖动 + 余数按概率进位 → 量级 **±1 点**）。
所以真要做的话，**输出应该是「基准值 ± 1」的区间**，不是单一确定值。

> ⭐ **教训（我在这里写错过一次）**：反汇编里看到 `bl <addr>`，**必须去 `asmmap` 查那个地址是什么**。
> 我第一遍把 `bl 0x08000C80` 当成普通的除法 helper，于是得出了「闭式算术、不烧随机数」
> 这个**完全相反**的结论，还写进了报告。`0x08000C80` = `NextRN_N`、`0x08000CA0` = `Roll1RN` ——
> 它们和 `LoadRNState` / `StoreRNState` / `NextRN_100` / `Roll2RN` 挤在 `0x08000C0C`–`0x08000CC0`
> 这**一小段里，就是 RNG 函数族**。看到 `bl` 就往这个区间瞟一眼。

**相关函数一览**（U 版）：

| 名字 | 地址 | 作用 |
|---|---|---|
| `LoadUnitStats` | `0x08017E34` | 从职业基础值 + 角色增量装载 |
| `IncreaseUnitStatsByLevelCount` | `0x08017FC4` | 按等级数自动升级（逐个属性调 `GetAutoleveledStat`） |
| `GetAutoleveledStat` | `0x0802B9C4` | 单个属性的自动升级值 |
| `GetStatIncrease` | `0x0802B9A0` | 成长点 → 实际点数（满 100 保底 +1，余数掷骰） |
| `AutolevelUnit` / `AutolevelRealistic` | `0x08018120` / `0x08018160` | 两条自动升级入口 |
| `StoreUnitStats` | `0x08018064` | 写回 |

---

### 3.20 敌人属性投影 —— 从配置记录到攻速 ⭐⭐

§3.19 解决了「敌人在哪」；这一节解决「敌人多快」。产物是 CLI 命令
**`enemy-stats`**（`src/analysis/enemyStats.ts`），经济报告的参考敌攻速就是它给的。

#### 3.20.1 公式与四项来源

```
敌攻速 = 职业基础速度 + 角色表增量 + 自动升级 − max(0, 武器重量 − 体格)
```

| 项 | 出处 |
|---|---|
| 职业基础速度 / 体格 | 职业表 `+0x0E` / `+0x11`（`CLASS_OFFSET.baseStats` 起的第 3、第 6 项） |
| 角色表增量 | 记录的 `unitId` → 角色表 `+12..19`，**有符号**（`rom.i8()`） |
| 自动升级 | `AutolevelUnit @ 0x08018120`，用**职业**的 `enemyGrowths`（`+0x1B`） |
| 武器重量 | 记录 `+12..15` → 道具表 `+23` |

⚠️ `unitId` 的**低 7 位不是 id** —— `+0` 整个字节就是 unit id（0 终止）。
但 `+1`（classId）**为 0 时表示「用角色自己的职业」**，不是「职业 0」。

#### 3.20.2 ⭐⭐ 自动升级的总开关 = `+3` bit 0

`Event2C_LoadUnits @ 0x0800FB84` 一路走到 `0x08017C10`，那里第一件事就是：

```
08017C10  ldrb r1, [r6, #3]     ; r1 = 记录[+3]
08017C12  movs r0, #1
08017C14  ands r0, r1           ; GROW = +3 & 1
08017C16  cmp  r0, #0
08017C18  beq  #0x8017cb8       ; GROW == 0 → 完全跳过自动升级
```

这一位就是编辑器里的「成長率: 成長させない / クラス依存」，而它**在阵营判断之前**。
本 ROM **11% 的敌人记录**这一位是 0（303/2805）—— 漏掉就会把这些敌人的属性算高。

#### 3.20.3 ⭐ 两条自动升级路径，分派在 `0x08017C36`

```
08017C36  ldr r2, [r5]          ; r2 = unit[+0] = pCharacter
08017C38  ldr r1, [r5, #4]      ; r1 = unit[+4] = pClass
08017C3A  ldr r0, [r2, #0x28]   ; 角色 abilityFlags
08017C3C  ldr r1, [r1, #0x28]   ; 职业 abilityFlags
08017C3E  orrs r0, r1
08017C42  lsls r1, r1, #8       ; mask 0x8000 → byte1 bit7
08017C48  bne  #0x8017c50       ; 置位 → 走「realistic」分支
08017C4A  ldrb r0, [r2, #4]     ; 角色 id
08017C4E  bhi  #0x8017c8a       ; 角色 id > 0x40 → AutolevelUnit
```

`0x08017C50` 那条分支把单位复制一份、清一个字节、对副本跑
**`AutolevelRealistic`**，再复制回来并把等级改回记录里的值 —— 所以两条路径都叫
「realistic」。

> **`unit[+0]` = pCharacter、`unit[+4]` = pClass。** 证据是 `AutolevelRealistic`
> 读 `unit[0]->+0x0B` 当「角色表初始等级」来算 `count = 等级 − 初始等级`（角色表
> `+0x0B` 就是等级），而 `IncreaseUnitStatsByLevelCount` 读 `unit[4]->+0x1B` 当成长率
> （职业表 `+0x1B` 就是 `enemyGrowths`）。**顺序反了会读成「角色成长率」**。

#### 3.20.4 `AutolevelUnit @ 0x08018120` 逐行

```
0801812E  movs r1,#0x80 / lsls r1,r1,#1   ; mask 0x100
08018132  ands r0, r1                     ; (角色.flags | 职业.flags) & 0x100
08018136  beq  #0x8018148                 ; 清零 → 跳过转职那一轮
0801813A  bl   #0x8037b44                 ; GetCurrentPromotedLevelBonus
08018144  bl   #0x8017fc4                 ; IncreaseUnitStatsByLevelCount(count = 9 / 19)
08018148  ldr r0, [r5, #4]                ; pClass
0801814A  ldrb r1, [r0, #4]               ; 职业 id（这个参数其实没被用）
0801814E  ldrsb r2, [r5, #8]              ; unit[+8] = 等级
08018150  subs r2, #1
08018154  bl   #0x8017fc4                 ; IncreaseUnitStatsByLevelCount(count = 等级 − 1)
```

要点：
- 转职那一轮的掩码是 **`0x100`**，即 `(角色.abilityFlags[1] | 职业.abilityFlags[1]) & 0x01`
  = `unitclass_checkbox_FE8.txt` 的 **特性2 bit0「上級クラス(武器S)」**。
  ⚠️ 是 **`& 0x01` 且角色与职业**都要 OR 进来 —— 只取职业、或用 `& 0x02`，都不对。
- `IncreaseUnitStatsByLevelCount @ 0x08017FC4` 读 **`unit[+4]`（= 职业表）的
  `+0x1B..0x21`**，7 个字节依次落到 `unit[+0x12, +0x14, +0x15, +0x16, +0x17, +0x18, +0x19]`
  （**`+0x13` 跳过**，那是当前 HP）。顺序 = hp / str / skl / **spd(+0x16)** / def / res / lck。
- 那个 `r1` 参数（职业 id / 角色 id）**函数里根本没读** —— 成长率永远来自 `unit[+4]`。

#### 3.20.5 `AutolevelRealistic @ 0x08018160`

```
08018170  ldrsb r0, [r4, #8]     ; 等级
08018174  ldrb r1, [r1, #0xb]    ; 角色表初始等级
0801817A  subs r0, r0, r1        ; count = 等级 − 角色表等级
0801818A  strb r0, [r4, #8]      ; 先把等级降回角色表的等级
08018192 循环 count 次:
08018196    bl #0x802a584       ; CopyUnitToBattleStruct
080181A2    bl #0x802ba28       ; CheckForLevelUp   ← 逐个等级模拟
080181AA    bl #0x802c1ec       ; 应用升级
```

所以它是「**用角色自己的成长率，逐级模拟 count 次升级**」。均值与
`角色成长率 × count / 100` 相同，但分布是二项分布，不是 §3.20.6 的窄区间。
本 ROM 只有 **44/2805** 条记录走这条路（`(角色.flags|职业.flags) & 0x80` 或
角色 id ≤ 0x40）。

#### 3.20.6 `GetAutoleveledStat` 的闭式（会烧随机数）

```
v = growth × count
q8  = v >> 3                     ; trunc(v/8)
bl  NextRN_N                     ; RN ∈ [0, q8 − 1]      ← 烧随机数
q16 = v >> 4                     ; trunc(v/16)
x   = v + RN − q16
bl  GetStatIncrease              ; floor(x/100)，余数用 Roll1RN 决定是否进位
```

→ 可达增益是 **`[floor(xMin/100), floor(xMax/100) + 1]`**，其中
`xMin = v − q16`、`xMax = v + max(0, q8 − 1) − q16`；
期望 ≈ `(v − q16 + max(0, q8 − 1)/2) / 100`。**GBA 没有硬件除法，`/8`、`/16` 都是移位。**

#### 3.20.7 转职加成 = 9（普通）/ 19（hard）

`GetCurrentPromotedLevelBonus @ 0x08037B44`：`ldrb r1,[r0,#0x14]; movs r0,#0x40; ands`
—— 即 `gChapterData[0x14] & 0x40`（hard 位）置位返回 **0x13 = 19**，否则 **9**。

#### 3.20.8 实测（本 ROM，普通模式）

```
记录 2805 条（按章去重；全 ROM 去重是 2723 条）
  AutolevelUnit 2458 / AutolevelRealistic 44 / 无自动升级 303
  转职加成生效 1040 条；记录里没有武器 291 条；攻速 < 0 共 74 条

攻速分布  min −14  p10 2.8  p25 6.0  中位 9.95  p75 13.95  p90 18.6  max 32.0

逐阶段中位数（经济报告用这个）:
  分线前 6.3 | 本线中段 9.8 | 合流 10.8 | 终盘 14.8
```

**攻速可以是负数，这不是 bug**：`BattleLoadAS` 从有符号字节里减惩罚，引擎不钳零。
本 ROM 负攻速的典型是 Gorgon Egg（速 0 拿重 10 的书 → −4）、
Artillerist（速 0 拿 Ballista w20 → −11）、Arch Mogall（体格 5 拿 w20 → −8.8）。

#### 3.20.9 口径与残余不确定性

1. **「AI 挑哪把武器」读不到。** 投影取记录 `+12..15` 里**最重**的那把（对敌人最不利、
   对玩家最有利）。换成「第一把武器」后逐阶段中位数只动 0.1–0.3 —— 所以这条不影响结论，
   但要说出来。`enemy-stats` 同时输出 `firstWeaponSummary` 供对照。
2. **自动升级烧随机数** → 每条记录是**区间**。报告取 `mean`，`bandLo/bandHi` 是边界。
   这也意味着**敌人登场会消耗 RNG**，与 `mgba/` 的凹点助手抢随机数。
3. **遍历是下界。** 只走到条件表脚本引用得到的配置块，遇到 10 条连续未知指令就放弃
   （`chapter.scriptWalks` 那条检查会报有多少次放弃）。
4. **按章去重 vs 全 ROM 去重。** `collectPlacementSites` 在**章内**去重（同一块被
   START_EVENT 和 TURN 同时引用只算一次），所以「某章的敌人」是对的；普查脚本
   （`unit-placement-census.ts`）在**全 ROM** 再去一次重，报 502 块 / 2723 条。
   两个数都对，回答的是不同问题 —— **别把 2723 和 2805 当成矛盾**。
   Lagdou Ruins 10（mapIndex 55）与 C15: Homecoming（36）共享 5 个配置块，就是这个差别。

#### 3.20.10 命令

```bash
node src/index.ts enemy-stats ../fixtures/dream-of-five.gba --compact \
  --out out/dream-of-five.enemy-stats.json      # 普通模式
node src/index.ts enemy-stats ../fixtures/dream-of-five.gba --hard ...   # hard（转职轮 9→19）
```

输出含 `totals` / `overall` / `byRoutine` / `chapters`（逐章分位数 + 逐职业）/
`samples`（逐条记录，供消费方自己按阶段聚合）/ `negativeSamples` / `limitations`。
`validate` 有三条对应检查：`enemy.records` / `enemy.statBand` / `enemy.negativeAs`。

---
