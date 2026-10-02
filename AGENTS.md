# AGENTS.md

## 0. 先读这段：这个仓库对你的意义

**这个仓库不是你要开发的项目。** `FEBuilderGBA/` 是上游仓库的 git submodule：一个成熟的 C# WinForms
工具，用来编辑 GBA 火焰纹章 ROM。**它的 C# 代码是只读参考资料** —— 不要修改、不要重构、
不要给它加功能、不要试图修它的 bug。

我们要的是它写死的那些东西：**GBA 火纹 ROM 的内存布局、指针表、数据结构** —— 那是我们的「权威规格」。
我们的产物是 **`cli/`**（TypeScript/Node，与 `FEBuilderGBA/` 平级）。

```
FEBuilderGBA/   ← submodule（只读参考）；C# 源码 768 个 .cs 平铺在 FEBuilderGBA/FEBuilderGBA/
                  bin/Debug/config/data/  ← 上游 config/data，422 个文件（§1.1）
cli/            ← 我们写的 CLI              docs/  ← 本文件拆出去的深度内容（§0.1）
mgba/           ← mGBA Lua 凹点助手（§3.15 / §3.17）
```

> **路径基准（2026-10-01 起）**：仓库根 = 本文件所在目录；
> **C# 源码目录 = `FEBuilderGBA/FEBuilderGBA/`**（两层同名是 submodule 决定的，**不是笔误**）。
> **2026-10-01 之前的旧文档路径都少一层** —— 看到「`FEBuilderGBA/` 后紧接 `bin/Debug` / `config/` /
> 某个 `.cs` 文件名」时，自己补一层。
> **唯一的例外**：必要时可以构建并运行参考程序做**交叉验证**（仅 Windows，见 §8）。

### 0.1 文档地图

**本文件只放「不看就会犯错」的东西，且必须短到最后一行也能被读到；深度内容在 `docs/`。**
**章节编号一律保持原样**（`§3.18`、`§4.11` 这类引用全仓通用）。

| 想看什么 | 文件 |
|---|---|
| 版本识别 / 关键指针 / 角色表 / 职业表 / 地形名表（§3.1–§3.4、§3.12） | [`docs/rom-layout.md`](docs/rom-layout.md) |
| 支援关系 / 支援会话 / 相性加成 / Huffman 文本（§3.5–§3.9） | [`docs/supports-and-text.md`](docs/supports-and-text.md) |
| 出场加入 / 编队与强制出击 / 敌人摆放 / 战役结构（§3.11、§3.14、§3.16、§3.19） | [`docs/chapters-and-events.md`](docs/chapters-and-events.md) |
| 升级抽点 / 战斗掷骰 / 攻速追击 / 敌人属性投影（§3.15、§3.17、§3.18、§3.20） | [`docs/battle-math.md`](docs/battle-math.md) |
| **挖表方法论 + 代码样例**（§2） | [`docs/methodology.md`](docs/methodology.md) |
| 反汇编 ROM 自己的代码（§3.10、§3.13） | [`docs/disassembly.md`](docs/disassembly.md) |
| **陷阱清单全文 14 条**（§4）—— §0.2 是它的一句话版 | [`docs/traps.md`](docs/traps.md) |
| **「想查 X → 读哪个 .cs」索引**（§7） | [`docs/reference-index.md`](docs/reference-index.md) |
| CLI 工程约定 / 验证策略 / 14 个命令（§5、§6） | [`docs/cli-conventions.md`](docs/cli-conventions.md) |
| 参考程序构建与运行（§8，仅 Windows） | [`docs/reference-build.md`](docs/reference-build.md) |
| 五条系统链路图 + 全部章节一行摘要 | [`docs/README.md`](docs/README.md) |

> 这份表是「文件 ↔ 章节」映射的**唯一**一份，`docs/README.md` 不再维护第二份（两份必然漂移）。

### 0.2 判据速查 —— 不看的代价是静默出错

> 每条都**不报错、结果看着合理**，只能事先记住。长文与证据见 [`docs/traps.md`](docs/traps.md)（§4）。

**读表之前**

1. **`RomInfo.*_pointer` 是「指针槽」偏移，不是表地址** —— 读表前必须 `rom.p32()`；
   例外是以 `*_address` 结尾的字段（§2.2 / §4.2）。
2. **`p32()` 出来的是 GBA 地址**，要 `- 0x08000000`；用现成的 `rom.toOffset()`，**别另写一份** ——
   边界判断不一致会让个别表整体错位（§4.1）。
3. **角色 ID 从 1 开始、职业 ID 从 0 开始**（偏移 `(n-1)*52` / `n*84`）（§4.5）。
4. **定长表不能读满** —— 表尾后面是别的数据，读满会**静默污染 ID→名字 映射**；
   自检：打印 `id === index` 成立的记录数（§4.9）。
5. **角色表按固定条数读、职业表扫终止符读**，别「统一处理」，**每张表读它自己的 `Init()`**（§4.10）。
6. **角色表 `+12..+19` 是相对职业基础值的「有符号增量」，必须 `rom.i8()`** ——
   用 `u8` 不报错，只会让「体格 −2」变成 254；>127 的基础值先怀疑是负数（§4.11）。
7. **支援表没有固定条数、也不按 ID 排序** —— 走「角色记录 `+44` → 支援指针」（§4.4）。
8. **支援关系是双向冗余存储** —— A→B / B→A 两条独立记录，建图要去重（§4.6）。
9. **未标注字段不要臆测**（`docs/` 标「（未标注）」= C# 标签本身就是 `??`）（§4.8）。

**文本**

10. **一半的字符串是「未压缩」存的**（指针带 `+0x80000000`）—— 只做 Huffman 会**静默丢一半名字**：
    一部分正常、一部分空串，而空串记录的其他字段全正常。
    判据：条目 ∈ `0x88xxxxxx` → 未压缩；∈ `0x08xxxxxx` → Huffman（§4.3 / §3.9）。
11. **单位名要过 `displayName`（剥 `@XXXX`）** —— 本 ROM 有 17 个名字尾部带 `@001F`（§3.12）。

**准备写「拿不到」之前**

12. **「参考代码里没有这段计算」≠「数据不在 ROM 里」** —— FEBuilderGBA 是**编辑器**不是模拟器，
    从不算战斗结果，「搜不到公式」是它的正常状态。该问的是「有没有一个 `Form` 在读这个字段」（§4.12）。
13. **值看起来像脏数据时，先怀疑自己漏了一层变换**（×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量），
    **别先怀疑 ROM**（§3.13）。
14. **`bl <addr>` 必须去 `asmmap_FE8.txt` 查那个地址是什么，不能凭形状猜** ——
    曾把 RNG 函数当成除法 helper，得出**完全相反**的结论（§3.13）。
15. **写「拿不到 / 不可得 / 无法确定 / 和公版不一致」之前，先重跑 §4.12 的排查 1–4 步。**

**静态判不了的，如实说明，别二选一**

16. **和运行时比较的字段** —— 强制出击表的 `route` 比的是 RAM 里的 `ChapterData+0x1B`：
    原样输出 + 在 `limitations` 里写清楚 + 给出「两种读法差多少」（§4.14）。
17. **部署槽位不是「空的」，是模板填的** —— 683 条配置记录里 534 条是填充。**数条数**才是出击位数；
    按 `unitId` 去重会得出「这一章只有 2 个角色」（§4.13）。
18. **地图设置表的索引不是章号** —— 79 条里只有约 30 张是单周目能打到的剧情图（§3.11.2.1）。

**曾经判错、后来推翻的（别再手工编）**

- ~~出场时间 / 加入章节拿不到~~ → **已实现**（§3.11）。~~「骑马 / 重甲」分不开~~ → 特性位能分开（§3.4.1）。
  ~~地形名拿不到~~ → 就是 65 条那个表（§3.12）。
- ~~支援 C/B/A 换算拿不到~~ → 门槛在 `SupportUnitForm.Designer.cs:460`，缩放算术在 ROM 代码里（§3.5.1 / §3.7.2）。
  ~~相性表「被改过」~~ → 是**未改动的公版**，只是存**半点值**（§3.7.1）。
- **移动消耗表是 65 项不是 64**（少读一列静默丢地形 `0x40` "Mast"，§3.4）。
  **别暴力扫字节找 unitId**（218 万候选，纯噪声，§3.10）。
  **`40050200....` 是增援不是招募**（靠 `0x2C` opcode 过滤，§3.11.4）。

---

## 1. 当前目标与进度

**目标：把 ROM 解析成结构化 JSON，交给 AI 分析「哪些角色值得练、支援关系怎么搭配」。**
四类数据：**角色**（基础能力 / 成长率 / 初始职业 / 武器等级 / 体格 / 移动力）·
**支援关系**（谁能支援谁 + 初始值 + 成长值 + C/B/A 加成）·
**队伍搭配**（武器 / 机动 / 治疗魔法 / 相性覆盖，§3.4.1 / §3.7）· **出场时间**（§3.11）。

### 进度

> **每完成或推翻一项就当场更新。进度表落后于代码比没有进度表更糟** ——
> 下一条「已实现 / 未验证」的错误结论往往就是从一张过期表长出来的。

| 项 | 状态 |
|---|---|
| FE8U 角色表 / 职业表 / 支援关系 / 地形名表（65 条） | 已跑通 |
| 文本解码（Huffman + 反 Huffman 双格式） | 已跑通，249/255 角色名可解 |
| 相性加成表（7 条）+ 加成随 C/B/A 放大（×0/1/2/3 再 ÷2） | 已跑通（反汇编，§3.7.2） |
| 支援门槛 81/161/241、对话封顶 80/160/240、加成 3 格攒点 1 格 | 已跑通（§3.5.1） |
| 职业特性位→机动性；移动消耗表交叉校验；职业地形回避/防御/魔防 | 已跑通（§3.4.1） |
| 出场章节 / 加入顺序（79 图、330 条 `LOAD*`，62/62 支援角色有证据） | 已跑通（§3.11） |
| 每章编队人数 `deploySlots`/`deploySlotsHard`；强制出击 28 条 | 已跑通（§3.14） |
| 14 个 CLI 命令（`info` `units` `classes` `roles` `supports` `terrain` `chapters` `items` `shops` `objects` `enemy-stats` `text` `dump` `validate`） | 全部可用（`validate` 49 项检查；权威清单 = `cli/src/index.ts:1331` 的 `switch`） |
| **mgba 凹点助手**（`mgba/fe-aodian.lua`，只读面板） | 自测 124 项全绿（fengari 假内存）；**未在 mGBA 实机加载验证**（§3.15 / §3.17） |
| FE7U | 指针常量已核实（§3.2 / §3.11），代码路径就绪但**未在真实 ROM 上验证** |
| FE7J / FE8J / FE6J | 未支持（SJIS 文本解码未实现；FE6 记录结构不同） |

> **上表所有「已跑通」当前都无法现场复现** —— `fixtures/` 不存在，见 §9 的前置条件。
>
> **`fixtures/dream-of-five.gba` 的真实身份**：游戏代码 `BE8E01`（FE8U），标题字段却被改成了
> `FIREEMBLEM2E`（FE7U 的标题）—— **以游戏代码为准，不要信标题**。这是个大幅改造过的 FE8U hack：
> 职业表 128 条、部分角色用未压缩文本（§3.9）、部分成长率 >100（合法）、
> 地图设置表 79 条且每条记录的 `+0` 被改写成了指针（§3.11.2）。
>
> FE7 有 **FE7U**（美版）/ **FE7J**（日版）两套完全不同的指针布局（`ROMFE7U.cs` / `ROMFE7JP.cs`）。
> **先做哪个取决于你手上 ROM 的版本**（§3.1）。中文汉化版通常基于 FE7U 或 FE7J，且可能打了文本补丁（§4.3）。

### 1.1 `config/data` 在哪里

**上游源头（422 个文件）**：`FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/`。
`U.ConfigDataFilename()`（`U.cs:3180`）拼的是 `Path.Combine(BaseDirectory, "config", "data", ...)`，
而 `BaseDirectory` 是**可执行文件所在目录** —— 所以源码树里的 `config/` 确实不存在，
但 `bin/Debug` 下那份一直在。**先 `ls` 再下结论。**

**CLI 不读上游那份**（那会把 CLI 和 C# 仓库耦合，单独 clone `cli/` 就跑不起来），只读
**`cli/data/`** —— vendored 的最小副本 27 个文件（3 前缀 × 3 游戏 × 3 语言）：`unitclass_checkbox_*`
（职业特性位名，key 是**十六进制**，§3.4.1）、`event_*`（事件 opcode 表，§3.11.4）、
`eventcond_*`（20 个章节条件槽，§3.11.3）。搜索路径（`cli/src/config/data.ts`）：
`$FEBUILDERGBA_CONFIG` → `cli/data/`；上游更新后重拷这 27 个文件即可。

**判据：断言「某数据不可得」之前，先 `find . -name '<文件名>'` 或 `ls FEBuilderGBA/FEBuilderGBA/bin/Debug`，
不要只看源码目录。** 早期在这里下过错误结论，白扔了一整轮工作（§4.7）。

### 1.2 CLI 与 agent 的边界 —— 什么该写进 CLI，什么不该

**CLI 的职责是「把 ROM 变成 agent 能直接推理的事实」，不是「替 agent 下结论」。**
越界一次，代价是 ~2500 行 TS 里塞满拍脑袋的常数和排版，而且**同一份结论在两个脚本里各写了一遍**
（`training-plan.ts` / `economy-plan.ts`，**已删除**，见 §3.16）。

**判据（两条都要过）：**

1. **能追到出处吗？** 这个值能不能指到某个 ROM 字节，或 `FEBuilderGBA/` 里的某个 `.cs` / `Form`？
2. **两个人会不会吵？** 换个人来做，会不会对它的定义有不同意见？

**两条都过 → 写进 CLI；有一条不过 → 那是判断，留给 agent。**

| 性质 | 例子 | 归属 |
|---|---|---|
| **ROM 事实** | 角色表字段、支援边、`deploySlots`、宝箱金额 | CLI |
| **机械派生**（纯函数，无口味） | `攻速 = 速度 − max(0, 重量 − 体格)`、`自由位 = 槽位 − 必上`、自动升级分派（§3.20） | CLI |
| **判断** | 评分权重、「这个单位值得练」、「Rophon 是调试单位」、阶段划分、报告排版 | **agent** |

**这不等于「CLI 只准吐原始字节」** —— `enemy-stats` 那套自动升级分派 + RNG 区间是花大代价反汇编
出来的（§3.20），无争议且容易算错，那种派生留在 CLI 是对的。
**分界线是「有没有作者的口味」，不是「离 ROM 有多远」。**

**三条硬性做法：**

- **不要在 CLI 里放作者选的数。** 权重、阈值、`ATTACKS_PER_CHAPTER = 6` 这类「拍的常数」，
  要么删掉，要么做成命令行参数让调用方传。注释里写「这是拍的」不算交代 —— 它照样会被下游当成事实。
- **同一份结论需要两个消费方各写一遍 = 放错层的铁证。** 事实只有一个家；判断根本不该有家。
- **排名是结论，不是事实。** `dump` 里的 `derived.*`（`growthRanking` / `bestGrowthPerStat` /
  `roleCoverage` 等）已删除：从 `units[]` 一行就能重算，而且「按什么排」本身就是口味。

**判断类结论去哪了**：不写进代码，写进 `docs/` 并标注「结论存档」（如 §3.16 的分线结构、
§3.16.3 的加入点回退规则）。下次分析可复用，但不要再落回 CLI。

---

## 2. 如何从这个 C# 代码库里挖 ROM 结构

> **完整版（五种手法 + 可直接跑的代码样例）在 [`docs/methodology.md`](docs/methodology.md)**；
> 「想查 X → 读哪个 C# 文件」的索引在 [`docs/reference-index.md`](docs/reference-index.md)（§7）；
> 项目级 skill `.workbuddy-ai/skills/febuildergba-rom-extraction/` 里有完整的标准作业流程
> （步骤 1–5）与常用 grep 速查。
>
> 这里只留最容易忘的三条：
>
> 1. **一切指针都在 `ROMFEINFO` 的子类里**（`ROMFE7U.cs` / `ROMFE8U.cs` … 每个游戏一个类）——
>    这是 ROM 里所有已知表的位置和大小。
> 2. **这些值几乎都是「指针槽」偏移，不是表地址** —— 表地址 = `p32(RomInfo.xxx_pointer)`。
> 3. **字段偏移藏在控件名里** —— WinForms 控件命名是 `<类型字母><字节偏移>`
>    （换算表 `InputFormRef.cs:5033`的 `GetTypeLength`），旁边 Label 的 `Text` 就是字段名。
>    **控件上的 `AccessibleDescription = "@XXXX"` 更好用** —— 去 `InputFormRef.cs` 搜这个串，
>    能直接读到参考程序对这个字段的完整说明文字。

---

## 3–8. 深度内容 →全在 `docs/`

> **§3.1 – §3.20 全部在 `docs/` 下 5 个文件里，章节编号不变**，对应关系见 §0.1 文档地图。
> 原因：这一节有 110KB，占原文 66%，把 `AGENTS.md` 撑到 167KB，而它每次会话都会被注入 —— 会被截断。

| 章 | 主题 | 文件 |
|---|---|---|
| §3.1 – §3.4、§3.12 | 版本识别 / 指针 / 角色表 / 职业表 / 地形名 | `docs/rom-layout.md` |
| §3.5 – §3.9 | 支援关系 / 会话 / 相性加成 / Huffman 文本 | `docs/supports-and-text.md` |
| §3.10、§3.13 | 参考代码答不上来时反汇编 ROM 自己的代码 | `docs/disassembly.md` |
| §3.11、§3.14、§3.16、§3.19 | 出场加入 / 编队强制出击 / 敌人摆放 / 战役结构 | `docs/chapters-and-events.md` |
| §3.15、§3.17、§3.18、§3.20 | 升级抽点 / 战斗掷骰 / 攻速追击 / 敌人属性投影 | `docs/battle-math.md` |
| §4 | 陷阱清单全文 14 条 —— §0.2 是它的一句话版 | `docs/traps.md` |
| §5、§6 | CLI 工程约定 / 14 个命令一览 / 验证策略 | `docs/cli-conventions.md` |
| §7 | 「想查什么 → 读哪个 C# 文件」完整索引 | `docs/reference-index.md` |
| §8 | 参考程序（FEBuilderGBA）的构建与运行，仅 Windows | `docs/reference-build.md` |

**通用前提**（每个数据字典文件开头也重复了一遍）：所有偏移都是**file offset**
（GBA 地址 = file offset + `0x08000000`）；所有 `*_pointer` 字段都是**指针槽**，用前先 `p32()`。

---

## 9. 快速参考

> **前置条件：下面这些命令在干净 checkout 下都跑不起来。**
>
> 1. **ROM** —— `fixtures/` **目录不存在**（`.gba` 被 `.gitignore` 排除）。要跑端到端验证
>    （`validate` / `chapters` / `enemy-stats` …），自己把 ROM 放到 `fixtures/dream-of-five.gba`。
>    没有 ROM 时，§1 的进度表只是历史记录。
> 2. **`cli/node_modules`** —— 只是为了 `tsc --noEmit`（`typescript` 是 devDependency），
>    在 `cli/` 下 `npm install` 即可。CLI 命令本身**零运行时依赖**。
> 3. **`fengari`** —— `mgba/test/run.mjs` 需要它，但**仓库里没有任何地方声明这个依赖**。
>    **不要**照它的错误提示在仓库根 `npm install`（会生成根目录 `package.json` + `node_modules`，
>    而 `.gitignore` 只忽略了 `cli/node_modules/`）。正解：装在仓库外的目录，再
>    `MGBA_TEST_WORKSPACE=<那个目录> node mgba/test/run.mjs`。

```bash
cd cli && node src/index.ts validate ../fixtures/dream-of-five.gba   # 自洽检查，退出码 0 = 无 error 级失败
cd cli && node src/index.ts chapters ../fixtures/dream-of-five.gba   # 出场/加入 + 编队人数 + 必上
cd cli && node src/index.ts dump     ../fixtures/dream-of-five.gba --compact --out out/report.json
cd cli && ./node_modules/.bin/tsc --noEmit
node mgba/test/run.mjs                                               # mgba 自测（依赖见上面第 3 条）
```

**14 个命令的完整清单与说明**在 [`docs/cli-conventions.md`](docs/cli-conventions.md) §5；
**反汇编 ROM 自己的代码**（`asmmap_FE8.txt` 查符号、patch2 补丁找地址、`bl` 目标必须查表）
在 [`docs/disassembly.md`](docs/disassembly.md)；
**五条主链路**（加载 / 出场加入 / 敌人摆放 / 编队必上 / 敌人属性→攻速）的流程图在
[`docs/README.md`](docs/README.md)；
**挖表的标准作业流程 + 常用 grep 速查**在项目级 skill
`.workbuddy-ai/skills/febuildergba-rom-extraction/SKILL.md`。
