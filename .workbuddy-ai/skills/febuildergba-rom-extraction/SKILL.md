---
name: febuildergba-rom-extraction
description: 从 FEBuilderGBA 的 C# 源码里挖出 GBA 火焰纹章 ROM 的数据结构（指针表、记录布局、字段偏移），用于写自己的解析 CLI。当任务是「解析 FE7/FE8/FE6 ROM」「提取角色/职业/支援/道具数据」「这个表在 ROM 里什么结构」「FEBuilderGBA 里怎么读 XX」「继续做 fecli / cli 的某个表」「某个数值/公式参考代码里找不到」时使用。含「参考代码答不上来时反汇编 ROM 自己的代码」的完整方法（符号表 + capstone）。
description_zh: "从 FEBuilderGBA 参考源码挖 ROM 数据结构（含反汇编 ROM 自身代码）"
description_en: "Extract GBA Fire Emblem ROM structures from FEBuilderGBA source, incl. disassembling the ROM itself"
agent_created: true
---

# 从 FEBuilderGBA 源码挖 ROM 数据结构

## 0. 背景与定位

`FEBuilderGBA/FEBuilderGBA/`（仓库根下 `FEBuilderGBA/` 这个 **git submodule** 之内）是一个
C# WinForms 的 GBA 火纹 ROM 编辑器。
**它不是要开发的项目，是只读参考资料** —— 它把 ROM 的内存布局、指针表、结构体全部硬编码了，
这就是权威规格。

> ⚠️ **路径基准（2026-10-01 起）**：仓库根 = `/Users/woxqaq/FEBuilderGBA`。
> **C# checkout 根 = `FEBuilderGBA/`（submodule 挂载点），源码目录 = `FEBuilderGBA/FEBuilderGBA/`。**
> 名字重复两层不是笔误。**旧文档里「`FEBuilderGBA/` 后面紧接 `bin/Debug` 或某个 `.cs` 文件名」
> 这类写法都少了一层 `FEBuilderGBA/`** —— 见到就自己补上（本次已全仓修正）。

产出物是仓库根目录 `cli/` 下的 **TypeScript + Node CLI**（零运行时依赖，只用 `Buffer`）。
**动手前先读两份**：
- 仓库根的 **`AGENTS.md`** —— 项目约定、路径基准、**§0.2 八条最贵的教训**、§2 挖结构方法论、§4 陷阱清单。
- **`docs/README.md`** —— 已挖出的数据字典（原 `AGENTS.md` §3，2026-10-01 拆出来）。
  ⚠️ **章节编号仍是 `§3.x`**：`§3.3` 角色表 / `§3.4` 职业表在 `docs/rom-layout.md`，
  `§3.11` 出场链路 / `§3.19` 敌人摆放在 `docs/chapters-and-events.md`，
  `§3.17` 战斗掷骰 / `§3.18` 攻速追击 / `§3.20` 敌人属性在 `docs/battle-math.md`，
  `§3.13` 反汇编在 `docs/disassembly.md`。**查 `§x.y` 时按 `docs/README.md` 的索引定位文件。**

**绝对不要修改 `FEBuilderGBA/`（submodule）下的 C# 代码。**

> **本 skill 是「项目级」的** —— 存放在 `<仓库根>/.workbuddy-ai/skills/`，只在 FEBuilderGBA 这个
> 工作区生效。**不要把它复制/移动到全局的 `~/.workbuddy-ai/skills/`**（用户明确要求过）。
> 相对路径有两种基准，命令块里都会显式 `cd`：**挖 C# 用源码目录 `FEBuilderGBA/FEBuilderGBA/`，
> 跑 CLI 用仓库根**。脚本路径是绝对路径，因此放在哪一层目录都能跑。

## 1. 必须先读的六条机制与边界

> §1.4 与 §1.6 是最贵的两课：前者曾经断言「出场时间拿不到」（数据一直在
> `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/`），后者曾经断言「支援换算拿不到」「相性表和公版对不上」
> （答案都在 ROM 自己的代码里）。§1.6.8 是同一类：断言「敌人摆放表找不到」，
> 真相是**这张表不存在** —— 敌人和自军共用同一种记录，阵营写在记录自己身上。
> §1.6.9 顺着 §1.6.8 往下走：那条记录最后会变成什么攻速（`+3` bit 0 总开关、
> `unit[+0]`/`unit[+4]` 是谁、自动升级会烧随机数 → **要给区间不给点值**）。

### 1.1 `RomInfo.*_pointer` 是「指针槽」的偏移，不是表地址

```
表 file offset = p32(RomInfo.xxx_pointer)
p32(a) = u32(a)，若值在 [0x08000000, 0x0A000000) 则减 0x08000000
p32p(a) = p32(p32(a))     // 二级指针
```

例外：以 `_address` 结尾的字段（`max_level_address`、`text_recover_address`）是**直接偏移**，不要解引用。

证据：`PatchForm.cs:9372 ReplacePointerSub()` 把 `u32(RomInfo.item_pointer)` 当原始 GBA 指针用；
`InputFormRef.cs:5792 Init()` 里 `BaseAddress = p32(BasePointer)`。

### 1.2 字段偏移藏在 WinForms 控件名里

控件命名 = **`<类型字母><字节偏移>`**：`B`=1 字节、`W`=2、`D`=4、`P`=4（指针）。
定义在 `InputFormRef.cs:5037 GetDataSize()`。

控件旁 Label 的 `Text` 就是字段名（日文）。

**另一条更省事的路径**：控件名里的数字**就是字节偏移**，而且很多控件带
`AccessibleDescription = "@XXXX"` —— 去 `InputFormRef.cs` 搜这个串，能直接读到
参考程序对这个字段的**完整说明文字**（常包含符号性、取值范围、特殊语义）。
实测靠这条找到了 `@UNITBASE`（有符号增量）、`@CLASS_BASE`、`@MAPSETTING_CHAPTOR_ID`（章号）。
**比读控件名猜字段含义快得多，优先用。**

### 1.2.1 「初期値 / 増減値 / 補正」类字段先确认符号性 ⭐⭐

**这是「看起来对、实际全错」的典型。** 角色表 `+12..+19`（HP/力/技/速/防/魔防/幸/体格）
在参考程序里叫 **`ユニット別能力`**（`X_BASE.AccessibleDescription = "@UNITBASE"`），
说明文字（`InputFormRef.cs:12022`）：

> 「ユニットの基礎値です。この値に、クラスの能力値を加えたものがユニットの初期値になります。
> **マイナス値にすることもできますが、合算した時に -1 以下になると、2 の補数により、
> ロード時に最大数になります。**」

对应地，职业表那边是 `@CLASS_BASE`（`InputFormRef.cs:11886`）。

**三条必须照做的推论：**

1. **实际初始能力 = 职业基础值 + 角色增量。** 只报原始字节是错的。
   实测 Kolbane 的 HP 增量是 **0**，但 Soldier 职业基础 HP 是 24 → 实际初始 HP **24**。
2. **字段有符号。** `0xFF` = **−1**。用 `u8()` 读会把每个负调整变成「+255」。
   实测 10 个槽位带负增量（Juger 体格 −1、Lyndra 体格 −2）。
   **TS 用 `rom.i8()`。症状是某项 ≥128 而其他项正常 —— 先怀疑负数。**
3. **增量为 0 是最常见的值**（实测 255 槽位里 70 个 HP 增量为 0），含义只是
   「不比职业基础值多」，**不是缺数据、不是 hack 怪癖**。

（曾经把这个 0 写成「基础 HP 读出来是 0，需实机确认」——**那是错的**。）

### 1.3 文本表条目有「两种存储格式」

拿到 `text_base + id*4` 的 4 字节后，**先分类再解码**（`FETextDecode.cs:73 DecodeAddr`）：

| 条目值的范围 | 格式 | 解码函数 |
|---|---|---|
| `0x88000000` – `0x8A000000` | **未压缩**（un-huffman 补丁） | `UnHffmanPatchDecode` |
| `0x08000000` – `0x0A000000` | 正常 Huffman 位流 | `huffman_decode` |
| 其他 | 无效 | 返回 `""` |

未压缩指针 = 正常指针 `+ 0x80000000`（`FETextEncode.cs:518 IsUnHuffmanPatchPointer`）。
减回去就是普通 GBA 指针。

**一个 hack 里两种格式常常混用。** 只实现 Huffman，症状是「一部分名字正常、一部分莫名是空串」，
而那些空名字的记录**其他字段全都正常** —— 极易误判成「文本表有洞」。

未压缩格式不是位流，是**变长字节游走**（`UnHffmanPatchDecodeLow`）：
`0x80` 吃 2 字节、`0x10` 吃 3 字节、`< 0x20` 或 `== 0x40` 或 `IsEnglishSPCode` 吃 1 字节，
其余原样输出 1 字节。`IsEnglishSPCode(c) = c >= 0x81 || c ∈ {0x1F,0x7B,0x7C,0x7D,0x7F}`。

### 1.4 数据在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data` —— 别急着划「拿不到」的边界

> **这一节曾经写错，代价是一整轮返工。** 早期版本断言「出场时间拿不到」「职业特性位拿不到」，
> 理由是 `FEBuilderGBA/FEBuilderGBA/config` 目录不存在。**这个理由本身就是错的。**

`U.ConfigDataFilename()`（`U.cs:3180`）拼的是
`Path.Combine(BaseDirectory, "config", "data", type + TitleToFilename + "." + lang + ".txt")`，
而 `BaseDirectory` 是**可执行文件所在目录**：

```
FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/     ← 上游源头，422 个文件（且被 git 跟踪）
FEBuilderGBA/FEBuilderGBA/config/data/               ← 不存在，别再找这里
cli/data/                                            ← 我们 vendored 的副本，27 个文件
```

**下「某数据不可得」的结论之前，先 `find . -name '<文件名>'` 或
`ls FEBuilderGBA/FEBuilderGBA/bin/Debug`。**
`7-zip32.dll` 同样在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/` —— 运行参考程序**不需要额外补任何东西**。

⚠️ **不要直接读 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/`** —— 那会把 CLI 和 C# 仓库耦合，
单独 clone `cli/` 就跑不起来。把用到的**最小子集复制进 `cli/data/`**，只读副本。
副本 = 3 前缀（`unitclass_checkbox_` / `event_` / `eventcond_`）× 3 游戏（FE6/FE7/FE8）
× 3 语言（`''`/`.en`/`.zh`）= **27 文件**。`event_category_*` 用不到。

三样关键数据（读取逻辑见 `cli/src/config/data.ts`）：

| 文件 | 内容 | 用在哪 |
|---|---|---|
| `unitclass_checkbox_*.txt` | 职业特性位名（key 是**十六进制**） | 机动性/再移动 |
| `event_*.txt` | 事件 opcode 表（583 条 pattern） | 事件反汇编 |
| `eventcond_*.txt` | 章节条件槽的名字与顺序 | 出场/加入推导 |

| 想要的输入 | 能否得到 | 原因 |
|---|---|---|
| **初始能力**（职业基础值 + 角色增量，见 §1.2.1） | ✅ | 两张表相加，**注意有符号** |
| 成长率 / 武器等级 / 职业 | ✅ | 表结构在 Form 里 |
| 支援对象 / 初始值 / 成长值 | ✅ | `+44` 索引 |
| 相性（炎雷風氷闇光理）+ 相性加成原始值 | ✅ | 名可从 ROM 文本表解出（§1.6.4） |
| **加成如何随 C/B/A 放大** | ✅ | **反汇编 ROM 自己的代码**（§1.6） |
| 机动性（飞行 / 骑马 / 重甲 / 普通） | ✅ | 职业特性位 `+40..+43`（主判据），消耗表交叉校验 |
| 能否用杖 / 是否魔法 | ✅ **派生** | 武器等级 > 0 |
| **出场时间 / 加入章节 / 加入顺序** | ✅ | 见下，完整链路已跑通 |
| **地形名字**（65 条） | ✅ | `map_terrain_name_pointer` + `MapTerrainNameForm` |
| **支援 C/B/A 门槛（81/161/241）** | ✅ | `SupportUnitForm.Designer.cs:460` 的 `EXPLAIN.Text`（§1.6.6） |
| **支援对话解锁点数（80/160/240）** | ✅ | **反汇编**（§1.6.6） |

> ⚠️ 上表曾经把「支援 C/B/A 换算」和「地形名字」都标成 ❌。**两处都是错的**，
> 原因见 §1.6 开头。**下「不可得」的结论前，先读 §1.6。**

**职业特性位怎么读**（机动性主判据）：记录 `+40..+43` 四个字节，位名来自
`unitclass_checkbox_*.txt`，key 是**十六进制**。`InputFormRef.GetInfoByBitFlag`（`InputFormRef.cs:7453`）：

```
byteIndex = key >> 4          // 高半字节 = 第几个字节
bit       = (key & 0xF) - 1   // 低半字节 = 第几位（1-based）
mask      = 1 << bit
```

关键位：`13`=骑马（`+41 0x04`）、`14`=飞龙（`+41 0x08`）、`15`=天马（`+41 0x10`）、
`27`=鎧△（`+42 0x40`）、`05`=踊る、`06`=奏でる、`03`/`04`=盗贼。
**key 是十六进制，`13` 不是十进制 13 —— 搞错会把 Thief/Bard 读成飞行单位。**

**出场时间链路**（`cli/src/tables/chapters.ts`）：

```
p32(map_setting_pointer) → 148 字节地图记录
  → +0x80 = 章号 ×2（游戏自己的 Chapter Number）  ← 判断「第几章」看这个
  → +0x70 = 章节标题文本 id（`C7A: ...`）
  → +116 = 事件 plist 索引
  → p32(map_event_pointer + i*4) 条件表（20 槽，顺序来自 eventcond_*.txt）
  → slot 10/11 = PLAYER_UNIT 初始配置块（20 字节/条，u8(+0)==0 终止）
  → START_EVENT 脚本 → 事件反汇编器（opcode 表来自 event_*.txt）
  → LOAD1 (402C....) = 加入章节；LOAD2 (412C....) = 过场预载
```

### 1.5 地图设置表的索引**不是**章号 ⭐⭐

**这是最容易得出错误结论的地方。** 表**每张地图 id 一行**，所以它同时计入：

- **未使用槽位**（全零、标题空、章号 0）
- **世界地图 / 遭遇图**（标题解码成 `@001F`，章号与它变体的那张剧情章**重复**）
- **bonus / 调试 / checkpoint 图**（`Lagdou Ruins`、`Castle Frelia`、`Act N Checkpoint`）

**不要**把索引当「第几章」报给人类。实测 `dream-of-five.gba`：79 条记录里
**51 条**有真标题、**20 条**未使用、**8 条**遭遇图，**单周目只有约 30 张是剧情图**。
按索引算会报出「第 60 章」和「11 章招募空窗」这种**不存在的东西**。

| 字段 | 含义 | 来源 |
|---|---|---|
| `+0x70` (u16) | **マップ名1** = 章节标题文本 id | 控件 `J_112_TEXT`；也是 `IsMapSettingEnd` 的探针之一 |
| `+0x72` (u16) | マップ名2(X) | 控件 `J_114_TEXT` |
| `+0x80` (u16) | **章号 ×2** = 游戏自己的 `Chapter Number` | 控件 `J_128`，`AccessibleDescription = "@MAPSETTING_CHAPTOR_ID"`；说明文字 `InputFormRef.cs:12097` |

**为什么 ×2**：外传要占半格。`C8x` 存 17 → 8.5、`C10x` 存 21 → 10.5、`C23x` 存 47 → 23.5、
`Postscript` 存 55 → 27.5、`Crossroads` 存 13 → 6.5。序章存 **0**（与未使用槽位同值，
**所以不能只看章号判「是否空槽」**）。

**自检**（最强的一条）：把标题里的 `C<n>` 与 `+0x80/2` 逐一比对，
外传允许落在 `n` 或 `n+1`。实测 39 条**全部吻合** —— 这基本能证明该字段的解读正确。

**两个必须知道的有意偏差**：
1. **记录条数**：参考代码用 `MapSettingForm.IsMapSettingEnd`（`MapSettingForm.cs:64`）判终止。
   但 hack 常把每条记录 `+0` 改写成指针 → 参考代码**第一条就返回 true，报 0 张地图**。
   对策：先按参考代码跑，若为 0 且首条结构合法，退化为**结构扫描**（连续 4 条空记录即停）。
2. **职业覆盖**：初始配置记录 `+0` 是 unitId、`+1` 是 classId。hack 常拿同一 unitId
   当泛型模板（实测 583/683 条是「角色 2 / 职业 13」这类填充）。只有
   `classId == 0 || classId == 自己职业` 时才归因到具名角色。

**⚠️ 不要暴力扫表找出场**（在 ROM 里搜 `u8 == unitId`）：角色 ID `1..255` 全部合法、
记录只有 20 字节，实测 **2,186,116** 个候选 —— 纯噪声。**走指针链路，别扫字节。**

**⚠️ `40050200....` 是增援分派，不是招募** —— 它同样携带 `POINTER_UNIT` 参数。
靠 `0x2C` opcode + 前导字节（`0x40`=recruit / `0x41`=load / `0x42`=cutscene）过滤。

**机动性的交叉校验**（`analysis/roles.ts`，现在降为副判据）：

```
costs = rom.bytes(p32(classAddr + 56), 65)     // 65 项，0xFF = 不可通行
步兵基线 = ROM 里出现次数最多的那张消耗表
  全部可通行消耗相同        → flying      （飞行无视地形）
  从不比基线便宜、且有更贵处 → restricted  （骑马/重甲特征）
  其余                      → normal
```

⚠️ **是 65 项，不是 64。** 三条独立测量：① `MoveCostForm.Designer.cs` 有 `B0..B64` 共 65 个
`NumericUpDown`，`MoveCostForm.cs` 给 65 列贴 `J_0..J_64`；② 地形名表也是 65 条（同一套 id）；
③ 实测 16 张消耗表在 ROM 里**间隔全是 `0x41`**。只读 64 会**静默丢掉地形 `0x40`（"Mast"）**，
而且因为静止职业本来就没这张表，「都读到 64 字节」看起来完全正常。

特性位与消耗表不一致时列进 `mobilityDisagreements`（实测 127 个职业仅 3 处，
来自 hack 改了其中一处）。**骑马 vs 重甲现在由特性位干净分开，不再需要回避。**

⚠️ **移动力为 0 的职业没有消耗表**（Gorgon Egg、Arcane Lock、空白槽），
`p32(+56)` 会失败。这是合法的，校验时必须加 `movementRange > 0` 条件，
否则会把 9 个合法职业误报成错误。

### 1.6 参考代码答不上来时：反汇编 ROM 自己的代码 ⭐⭐⭐

**这一节是本 skill 里最有力的一节。** 它解决的是前几节都解决不了的一类问题。

#### 1.6.1 为什么要做，什么时候做

`FEBuilderGBA` 是**编辑器**，不是模拟器 —— 它只需要把 ROM 里的表显示出来让你改，
**从来不需要算战斗结果**。所以「C# 里搜不到某个公式」是它的**正常状态**，
**完全不能推出「这个数据不在 ROM 里」**。

这个思维定式已经让本项目白扔过三轮工作：

| 错误结论 | 真相 |
|---|---|
| 「出场时间拿不到」（理由是 `FEBuilderGBA/FEBuilderGBA/config` 不存在） | 数据在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/`（§1.4） |
| 「地形名字拿不到」 | `MapTerrainNameForm.cs` 就在读它 |
| 「支援 C/B/A 门槛拿不到」 | 门槛写在 `SupportUnitForm.Designer.cs:460` 的 `EXPLAIN.Text` 里 |
| 「相性加成表和公版对不上 / 被改过」 | 表没被改；**存的是半点值**，游戏最后 `>>1`（§1.6.5） |

**后两条的教训不同，要分开记：**

- 前三条：**「参考代码里没有这段计算」≠「数据不在 ROM 里」。**
  正确的问法是「这个字段有没有一个 `Form` 在读它」，而不是「有没有一段代码在用它」。
- 第四条：**「值看起来像脏数据」时，先怀疑自己漏了一层变换**
  （×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量），**别先怀疑 ROM。**

**两条都指向同一个动作：去反汇编 ROM 自己的代码。ROM 里的代码是终审法官。**

#### 1.6.2 三个前提，仓库里都已经有

**① 原版函数符号表。** `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_<game>.txt`
（也有 `.en` / `.zh` 变体）是**原版**的「函数名 → 地址」映射，tab 分隔：

```
0802852C	GetSupportBonusEntryPtr	{U}
08028550	StoreAddedAffinityBonusesForSupportLevel	{U}
080285B0	GetUnitSupportBonuses	{U}
```

`{U}` = 美版，`{J}` = 日版。**这等于给原版 ROM 附了一份带注释的反汇编清单。**
hack 通常保留原版的代码布局，所以符号表直接可用。

**② 反汇编器。** 需要解 Thumb。本机的 `objdump` 是 LLVM 21，**不支持裸二进制**
（`-b binary` 是 GNU 专属参数），所以用 Python 的 `capstone`：

```bash
# 一次性准备（venv 在隔离目录，不污染用户环境）
/Users/woxqaq/.workbuddy-ai/binaries/python/versions/3.13.12/bin/python3 \
  -m venv /Users/woxqaq/.workbuddy-ai/binaries/python/envs/default
/Users/woxqaq/.workbuddy-ai/binaries/python/envs/default/bin/pip install capstone
```

**反汇编脚本已随本 skill 提供**：`scripts/disasm.py`

```bash
PY=/Users/woxqaq/.workbuddy-ai/binaries/python/envs/default/bin/python
$PY /Users/woxqaq/FEBuilderGBA/.workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py \
   <rom.gba> <startOffset> <endOffset> [baseAddress]

# 例：支援加成的算术
$PY .../scripts/disasm.py /Users/woxqaq/FEBuilderGBA/fixtures/dream-of-five.gba 0x2852C 0x285B0
```

**工作流**：`grep -i <关键词> asmmap_FE8.txt` 找符号 → 从符号表读出地址 →
反汇编「该地址到下个符号」→ 读寄存器流。
**不要试图反汇编整个 ROM**，按符号切是最省力的。

> 符号表地址是 **GBA 地址**（`0x08xxxxxx`），文件偏移 = 地址 − `0x08000000`。
> 脚本接受的是**文件偏移**（base 默认 `0x08000000 + start`）。

**③ ⭐⭐ 找地址的最快路径：`patch2/` 里的 `#ENGINE` 补丁直接写出「要改哪条指令」。**

比 `grep asmmap` 更快，而且**不需要先知道函数名**。FEBuilderGBA 的引擎级补丁是「改 ROM 里某几条
指令」的开关，所以补丁文件里必然带地址和原始字节：

```bash
ls FEBuilderGBA/FEBuilderGBA/bin/Debug/config/patch2/FE8U/            # 按功能分目录：SYSTEM/ skill*/ stairs/ ...
grep -n "ADDRESS\|DETERMINATION_ADDRESS\|^OFF\|^FIX\|^COMBO" \
  FEBuilderGBA/FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/<补丁>.txt
```

读法：

| 字段 | 含义 |
|---|---|
| `ADDRESS=` / `DETERMINATION_ADDRESS=` | **文件偏移**（不是 GBA 地址，别再 −0x08000000） |
| `OFF:` / `FIX:` | **改前 / 改后的原始字节**（`0x…=AA BB …`） |
| `CONFLICT_IF` | 冲突时该处应有的字节 —— 反过来也能当「这是不是原版布局」的探针 |

**关键动作：拿 `OFF:` 的字节去 ROM 对应偏移核对。一致 = 这条指令还在原地 = 补丁标的地址有效。**
（hack 改了这段代码的话字节就不一致，此时符号表也会失效。）

实例（2026-10-01，攻速公式）：

| 补丁 | 字段 | 值 |
|---|---|---|
| `PATCH_Eliminate attack speed penalty.txt` | `DETERMINATION_ADDRESS` | `0x02AB92` |
| 同上 | `OFF` | `40 1A`（= Thumb `subs r0,r0,r1`） |
| `PATCH_Required pursuit attack speed difference.txt` | `ADDRESS` | `0x02AFBC 0x2AFCE` |

→ 反汇编 `0x2AB74` 得到 `BattleLoadAS`（攻速公式），`0x2AF90` 得到 `BattleCheckDoubling`
（追击阈值）。**「攻速」「追击」这两个词在 `asmmap` 里根本搜不到**（函数名是英文缩写 AS），
但补丁文件名是自然语言，一眼就命中。**先 `ls patch2/`，再 `grep asmmap`。**

#### 1.6.2.1 ⚠️⚠️ 看到 `bl <addr>` 必须去 `asmmap` 查那个地址 —— 不能凭形状猜

**这是本 skill 里最容易犯、代价最大的一个错。** `bl` 的目标可能是算术 helper，
也可能是**随机数**；两者在反汇编里长得一模一样，而结论是**相反的**。

踩过的实例（2026-10-01，敌方属性是否可算）：

```
0802B9D4  bl       #0x8000c80       ; 看起来像除法 helper
0802B9E8  bl       #0x802b9a0
```

`grep` 一下 `asmmap_FE8.txt`：

| 地址 | 名字 |
|---|---|
| `0x08000C34` | `LoadRNState` |
| `0x08000C4C` | `StoreRNState` |
| `0x08000C64` | `NextRN_100` |
| **`0x08000C80`** | **`NextRN_N`** ← 就是它 |
| `0x08000CA0` | `Roll1RN` |
| `0x08000CB8` | `Roll2RN` |
| `0x0802B9A0` | `GetStatIncrease`（里面又 `bl Roll1RN`） |

→ 结论从「闭式算术、不烧随机数、敌方属性完全确定」**翻转**成
「基准 = 成长 × 等级 / 100，但带 ±1 的随机成分」。
（这个错误结论当时已经写进了报告和 `AGENTS.md`，是查符号表时自己抓回来的。）

**规则**：

1. 反汇编窗口里**每一个 `bl` / `b` 的目标地址都查一遍**（`grep -i '^08000c80' asmmap_FE8.txt`，
   或者把 `asmmap` 按地址排序后看区间）。
2. **`0x08000C0C`–`0x08000CC0` 是 RNG 函数族**（FE8U）—— 见到落在这个区间的 `bl`，
   立刻停下来想「随机成分有多大」。
3. 说「这个量是确定的」之前，先确认调用链上**没有任何 `bl` 落进 RNG 区**。
   确定 vs 带随机是**相反的两个结论**，猜错等于整个分析的性质变了。

#### 1.6.3 实测收获：支援系统的全部算术

`grep -i support asmmap_FE8.txt` 直接给出整条函数链
（`GetSupportLevelBySupportIndex` / `GetSupportBonusEntryPtr`
/ `StoreAddedAffinityBonusesForSupportLevel` / `GetUnitSupportBonuses` /
`ProcessTurnSupportExp` …），反汇编后得到：

| 结论 | 证据（反汇编片段） |
|---|---|
| 表步长 8、按 `u8(a)==相性` 匹配、`u8(a)==0` 终止 | `adds r2,#8` / `cmp r1,r3` / `cmp r1,#0` |
| **`support_attribute_pointer` 这个「槽」就是函数字面量池里的那个字** | `ldr r2,[pc,#0]` 落在 `0x28534`，字面量 `0x088B05F8` |
| 加成 = `存值 × level`，level ∈ {0,1,2,3} | `ldrb r1,[r0,#1]` + `muls r1,r5,r1` |
| **六项各 `>>1`，只除一次** | 函数末尾 6 组 `ldrb`/`lsrs #1`/`strb` |
| 门槛 `>0x50→C, >0xA0→B, >0xF0→A` | `GetSupportLevelBySupportIndex` 的 3 个 `cmp` |
| 距离判据是 `|dx|+|dy|`（曼哈顿） | `subs`+abs+`adds r0,r1,r0`+`cmp r0,#3` |
| 只写偏移 1–6，**偏移 7 从不被读** | `StoreAdded` 里只有 `#1`–`#6` 六组 |

> ⚠️ **`support_attribute_pointer = 0x28534` 落在代码段里** ——
> 它是 `GetSupportBonusEntryPtr` 自己的字面量池。这是「指针槽」规则（§1.1）的极端例子：
> 槽位可以在**代码段**，所以「槽位偏移」和「表偏移」之间没有任何地址规律，只能反汇编确认。

#### 1.6.4 反编译源码是第二意见（需要字段名时用）

`asmmap` 给的是**函数名**，不给**结构体字段名**。字节布局本身说明不了
「偏移 4 是回避还是必杀回避」，这时查反编译源码的头文件
（`FireEmblemUniverse/fireemblem8u`）：

| 想要 | 文件 |
|---|---|
| 支援系统结构体与常量 | `include/bmreliance.h` |
| 支援系统实现 | `src/bmreliance.c` |

**⚠️ FE8 反编译把 support 叫 `reliance`** —— `grep support` 在 `include/` 里搜不到，
要找 `bmreliance.h`。头文件给出的关键定义：

```c
enum { MAX_SIMULTANEOUS_SUPPORT_COUNT = 5, SUPPORT_BONUSES_MAX_DISTANCE = 3 };
enum { SUPPORT_LEVEL_NONE, SUPPORT_LEVEL_C, SUPPORT_LEVEL_B, SUPPORT_LEVEL_A };  // 0,1,2,3
enum { SUPPORT_EXP_C = 81, SUPPORT_EXP_B = 161, SUPPORT_EXP_A = 241 };
struct SupportData {
    /* 00 */ u8 characters[7];      /* 07 */ u8 supportExpBase[7];
    /* 0E */ u8 supportExpGrowth[7];/* 15 */ u8 supportCount;   // ← 计数在 +0x15
};
struct SupportBonuses {
    /* 00 */ u8 affinity;
    /* 01 */ u8 bonusAttack;  /* 02 */ u8 bonusDefense; /* 03 */ u8 bonusHit;
    /* 04 */ u8 bonusAvoid;   /* 05 */ u8 bonusCrit;    /* 06 */ u8 bonusDodge;
};
```

**相性名也能从 ROM 里解出来。** `GetAffinityName` 是一张文本 id 表
（`src/bmreliance.c`）：

```
相性 1..7 → 文本 id 0x510, 0x511, 0x512, 0x513, 0x50C, 0x50B, 0x50A
（index 0 → 0x534，未使用）
```

实测解码出来正是 `Fire / Thunder / Wind / Ice / Dark / Light / Anima` ——
和参考程序硬编码的 `GetAttributeName()` 完全一致，**是相性 ID 顺序的独立验证**。

#### 1.6.5 ⚠️⚠️ 相性加成表存的是**半点值**

**这是本节最贵的坑。** 表里每行 `atk` 都是 1、`critAvoid` 都是 5，很容易误判成
「这 ROM 的数据被改坏了 / 和公版对不上」。**两个结论都是错的。**

真相：游戏在 `GetUnitSupportBonuses` 末尾对六个字段各做一次 `>>1`。所以

```
存 1 → C: 1×1>>1 = 0   B: 1×2>>1 = 1   A: 1×3>>1 = 1     即 atk +0/+1/+1
存 5 → C: 5×1>>1 = 2   B: 5×2>>1 = 5   A: 5×3>>1 = 7     即 hit/crit/critAvoid +2/+5/+7
```

展开后 7 行**精确落在公版 GBA FE 相性表上**：

| 相性 | atk | def | hit | avoid | crit | critAvoid |
|---|---|---|---|---|---|---|
| Fire | 0/1/1 | 0/0/0 | 2/5/7 | 0/0/0 | 2/5/7 | 2/5/7 |
| Thunder | 0/1/1 | 0/1/1 | 0/0/0 | 0/0/0 | 2/5/7 | 2/5/7 |
| Wind | 0/1/1 | 0/0/0 | 0/0/0 | 2/5/7 | 2/5/7 | 2/5/7 |
| Ice | 0/1/1 | 0/1/1 | 0/0/0 | 2/5/7 | 0/0/0 | 2/5/7 |
| Dark | 0/1/1 | 0/0/0 | 2/5/7 | 2/5/7 | 0/0/0 | 2/5/7 |
| Light | 0/1/1 | 0/0/0 | 2/5/7 | 2/5/7 | 0/0/0 | 2/5/7 |
| Anima | 0/1/1 | 0/1/1 | 2/5/7 | 0/0/0 | 0/0/0 | 2/5/7 |

**`Dark` 与 `Light` 完全相同是公版行为**，不是 hack 改的。

**完整公式**（三个反直觉点）：

```
bonus[stat] = floor( Σ_相邻伙伴 ( 行[我方相性][stat] × L(我方→对方)
                              + 行[对方相性][stat] × L(对方→我方) ) / 2 )
L = 0/1/2/3 对应 无/C/B/A
```

1. **双方相性都算** —— 不是只算自己的。
2. **`>>1` 只做一次，作用在总和上**，不是每项各自除。多个相邻伙伴时两种算法结果不同。
3. **`+7` 不是 `+2×3`** —— A 级 = 原始值 ×3 再取整（`5×3>>1 = 7`），
   而不是 `C 级取整后 ×3`（`2×3 = 6`）。

#### 1.6.6 ⚠️ 门槛与「能升级的点数」差 1 —— 中间隔着一次支援对话

支援点数**会被封顶**，必须真的去看支援对话才能进下一级：

```
等级「无」时点数最多涨到 80  → 对话可用 → 对话后变 81  → 等级 C
等级 C  时点数最多涨到 160  → 对话可用 → 对话后变 161 → 等级 B
等级 B  时点数最多涨到 240  → 对话可用 → 对话后变 241 → 等级 A
```

- **80 / 160 / 240 是「解锁对话」的点数**（`SUPPORT_EXP_x - 1`，`sSupportMaxExpLookup`）。
- **81 / 161 / 241 是「对话之后持有」的点数**（`SUPPORT_EXP_x`，也是参考程序
  `EXPLAIN.Text` 里写的 81–160 / 161–240 / 241+）。

所以「还要相邻几回合才能升到 C」= `ceil((80 − 初始值) / 成长值)`，
**不是** `ceil((81 − 初始值) / 成长值)`。对话本身不消耗回合。

**其他由代码核实的机制**：

| 机制 | 值 |
|---|---|
| 加成生效距离 | `|dx| + |dy| ≤ 3` |
| 点数增长距离 | `|dx| + |dy| ≤ 1`（相邻）；**一人背另一人也算** |
| 单人可持有支援**等级**总数 | **5**（A=3, B=2, C=1，求和） |
| 每对每章可升级次数 | 1 |

> ⚠️ 「上限 5」是**等级数之和**，不是「5 个伙伴」。一个 A(3) + 一个 B(2) 就满了。

#### 1.6.7 实测收获：攻速与追击（靠 §1.6.2 ③ 的补丁地址找到的）

**「攻速」「追击」在 `asmmap_FE8.txt` 里搜不到**（函数名是 `BattleLoadAS` / `BattleCheckDoubling`），
但 `patch2/FE8U/SYSTEM/` 里两个补丁的文件名是自然语言，直接给出地址。

`BattleLoadAS @ 0x0802AB74`（J 版 `0x0802AAE4`）：

```
0802AB82  lsrs   r1, r7, #2      ; 物品字段 >> 2 = 武器重量
0802AB84  ldrsb  r0, [r4, r0]    ; 体格
0802AB86  subs   r1, r1, r0      ; 重量 - 体格
0802AB88  cmp    r1, #0
0802AB8A  bge    #0x802ab8e
0802AB8C  movs   r1, #0          ; ← max(0, …) 的钳位
0802AB8E  movs   r0, #0x16
0802AB90  ldrsb  r0, [r4, r0]    ; 速度（单位 +0x16 有符号字节）
0802AB92  subs   r0, r0, r1      ; ★ 速度 - 惩罚   ← 补丁 DETERMINATION_ADDRESS
0802AB96  adds   r1, #0x5e
0802AB98  strh   r0, [r1]        ; 存到 战斗单位 +0x5E = 攻速（u16，之后钳到 0）
```

`BattleCheckDoubling @ 0x0802AF90`（J 版 `0x0802AF00`）：

```
0802AFAE  ldrsh  r3, [r1, r5]    ; A 方攻速（+0x5E）
0802AFB2  ldrsh  r2, [r2, r1]    ; B 方攻速（+0x5E）
0802AFB4  subs   r1, r3, r2      ; AS_A - AS_B
0802AFBC  cmp    r1, #3          ; ★ 补丁 ADDRESS 之一
0802AFBE  ble    #0x802b010      ; ≤3 → 不追击
0802AFCC  subs   r0, r2, r3      ; 镜像分支
0802AFCE  cmp    r0, #3          ; ★ 补丁 ADDRESS 之二
```

| 结论 | 证据 |
|---|---|
| `攻速 = 速度 − max(0, 武器重量 − 体格)` | `cmp/bge` + `movs r1,#0` 钳位，再 `subs` |
| 攻速存在 **战斗单位 `+0x5E`（u16）** | 写入处与两处读取处都是 `+0x5E` |
| 速度是 **`+0x16` 的有符号字节**（`ldrsb`） | `movs r0,#0x16` + `ldrsb` |
| `追击 ⟺ |攻速差| ≥ 4`，**双向**（谁快都能追） | 两处 `cmp #3` + `ble` + 镜像分支 |
| **hack 没改这段代码** | `0x02AB92` 的 ROM 字节 = 补丁 `OFF` 的 `40 1A`；两个 `cmp` 地址与补丁 `ADDRESS` 吻合 |

> ⚠️ **`asmmap` 里同一函数有 `{U}`/`{J}` 两份地址**（美版/日版），选一个并全程一致。
> 上表的 `0x0802AB74` 是 `{U}`。别把两个版本的行混着用。

**敌方攻速：是「本工具还没解析」，不是「读不到」—— 别把这两件事混为一谈。**

- 敌人和自军走**同一个公式**（`BattleLoadAS` 对双方都跑），缺的只是**输入**。
- ✅ **「敌人在哪」已经走通，见 §1.6.8**：FE8 **没有敌人表** —— 敌人和自军共用同一种
  20 字节配置记录，阵营由记录自己 `+3` 字节的 bits 1–2 决定，记录块由事件脚本引用。
- ✅ **「敌人属性/攻速怎么算」也已经走通，见 §1.6.9**：四项来源（职业基础速度、角色表增量、
  自动升级、武器重量）全部有地址级证据。
- ⚠️ **但属性不是确定值**：自动升级 `GetAutoleveledStat` / `GetStatIncrease`
  **会烧随机数**（见 §1.6.2.1）→ 基准 `成长 × 等级 / 100`，随机成分 ±1 点。**要输出区间，不要挑一个数。**

**措辞纪律**：说「读不到」之前先问自己「是数据不存在，还是我没解析？」——
后者要写成「本工具未解析」，并说明**缺什么、为什么缺、要补哪一步**。
**这类「确实拿不到」要如实说明并给区间，不要挑一个数装作是实测值。**

#### 1.6.8 实测收获：敌人摆放在哪（结论：**没有这张表**）⭐⭐

搜「敌人表」会一无所获，因为 **FE8 没有这张表**。正确的心智模型是：

> 玩家 / 友军 / 敌人用的是**同一种 20 字节记录**，块由**事件脚本**引用，
> **是不是敌人由记录自己 `+3` 字节的 bits 1–2 决定**。

**① 阵营位**（`+3`，u8 —— 注意 `+4` 就是坐标，别按 u16 读）：

| 位 | 掩码 | 控件（`EventUnitForm.Designer.cs`） | 取值 |
|---|---|---|---|
| 0 | `& 0x01` | `L_3_UNITGROW_GROW` | 0 成長させない / 1 クラス依存 |
| 1–2 | `>>1 & 0x3` | `L_3_UNITGROW_ASSIGN` | **0 自軍 / 1 友軍 / 2 敵軍 / 3 消滅** |
| 3–7 | `>>3 & 0x1F` | `L_3_UNITGROW_LV` | レベル |

⭐ 掩码不是猜的：`InputFormRef.cs:993-1094`（`linktype == "UNITGROW"`）是**逐字节读改写**，
下拉项文字就在 Designer 里。对应 `U.ParseUnitGrowAssign` / `U.ParseUnitGrowLV`。

**② 块由谁引用** —— 带 `POINTER_UNIT` 的指令只有这几类（`event_FE8.txt`）：

| 指令 | 名字 | 用途 |
|---|---|---|
| `402C0100XXXXXXXX20300000` / `402C0000XXXXXXXX` | LOAD1 | 招募 **+ 章节初始敌人** |
| `412C0100XXXXXXXX`（`20300000`） | LOAD2 | 读入既有成员 / 开局重放自军块 |
| `422C0000XXXXXXXX` | LOAD3 | 过场 |
| `40050200XXXXXXXX400A0000…` | 増援 | 增援（多数是敌人） |
| `40050200XXXXXXXX4005030001000000400A0000…` | 増援（普通以上） | 仅普通及以上 |
| `40050200…40050300ZZ…40050400WW…400A0000YY…` | 特殊事件（带 3 组单位） | 一次最多 3 块 |

ROM 侧处理器 = **`Event2C_LoadUnits @ 0x0800FB84`**（事件 opcode `2C`）。

**③ ROM 侧访问器**（决定性证据，别只看 C#）：

| 函数 | 地址 | 读什么 |
|---|---|---|
| `GetChapterAllyUnitDataPointer` | `0x08083348` | `+0x28`（槽 10）；`gChapterData[0x14]&0x40`（hard）→ `+0x2c`（槽 11）；魔物图 → `+0x30/34/38`（槽 12–14） |
| `GetChapterEnemyUnitDefinitions` | `0x080833B0` | `+0x3c/40/44` = **槽 15/16/17 = `FREEMAP_ENEMY_UNIT`** ← **只给魔物图用** |
| `GetChapterAllyUnitCount` | `0x08012344` | 20 字节步长数到 `u8(+0)==0`，**不过滤阵营** |
| `GetChapterEventDataPointer` | `0x080346B0` | 拿 mapId 取条件表（所以 `+0x28` 就是槽 10） |

⭐ `0202BCF0 = @ChapterData`，符号表里逐字写着 `@0E = マップID`、`@14 ... &40 = Set for hard mode`。

**④ 常规章节初始敌人 → `START_EVENT`（槽 18）**；增援 → `TURN`（槽 0）/ `ALWAYS`（槽 3）。
FE8 条件表 20 槽里**没有 `ENEMY_UNIT`**（FE7 才有，槽 6–9；FE6 槽 5）。

**⑤ 参考程序的「ユニット配置」表单不是入口。** `EventCondForm.MakeUnitPointer` 只扫
TURN/TALK/OBJECT/ALWAYS/TUTORIAL，跳过 PLAYER_UNIT / FREEMAP_* / TRAP / START/END ——
它列的是**脚本引用的块**，不是「玩家初始配置」。

**⑥ 普查工具**：`cli/scripts/unit-placement-census.ts`（`--chapter N` 看单章明细）。
DoF 实测 502 块 / 2723 条敌人记录 / 88 个敌人职业 / 等级 0–20（均值 9.7），
0 空块 / 0 职业 id 落在职业表外 / 0 `unitId==0`。

> ⚠️ **做「全 ROM 有没有某种字节形态」的结论时，扫描必须加语义约束。**
> 我扫 `40050200 <ptr> 40050300 <ptr>` 时第一遍没校验指针，得到 210 个"命中"——
> 全是 `0x00020540` 这类小整数被当成指令的假阳性。加上「两个参数都必须是合法 GBA 指针」
> 之后是 **0 例**。**4 字节字面量在全 ROM 里几乎必然撞上。**
> 更稳的做法是**用反汇编器走脚本**（只在指令边界上取参数），而不是裸扫字节。

> ⚠️ **别把 hack 的数据怪癖当成解析 bug 去"修"。**
> DoF 的 `mapIndex 22`（C10B）是全 ROM 唯一 `槽11 ≠ 槽10` 的章节：槽 11 是 9 条全友軍。
> 因为 `GetChapterAllyUnitCount` 不过滤阵营，hard 模式出击位**真的是 9** ——
> 这是游戏会算出来的数，不是我们读错了。**如实记录 + 标注待上机核实**，不要擅自改数。

#### 1.6.9 实测收获：敌人属性 → 攻速（接上 §1.6.8 的下半段）⭐⭐

§1.6.8 解决了「敌人在哪」，这一节解决「那条记录最后会变成什么攻速」。

**闭式公式**（四项，全部有地址级证据）：

```
敌攻速 = 职业基础速度 + 角色表增量 + 自动升级 − max(0, 武器重量 − 体格)
          ↑ +0x0E      ↑ +12..19     ↑ 见下        ↑ 道具表 +23   ↑ 职业表 +0x11
```

| 项 | 来源 | 地址级证据 |
|---|---|---|
| 职业基础速度 | 职业表 `+0x0E` | `ClassForm.designer.cs` 控件名 `B_0E` |
| 角色表增量 | 角色表 `+12..19`，**有符号** | 见 §1.2.1（`i8()`，不是 `u8()`） |
| 体格 | 职业表 `+0x11` | `BattleLoadAS` 里 `ldrsb [r4, #?]` 读的就是它 |
| 武器重量 | 道具表 `+23` | `BattleLoadAS`：`lsrs r1, r7, #2`（物品字段 `>>2`） |
| 自动升级 | `AutolevelUnit` / `AutolevelRealistic` | 见下 |
| 公式本体 | `BattleLoadAS @ 0x0802AB74` | 见 §1.6.7 |

**① ⭐⭐ `+3` bit 0 是自动升级的总开关，而且在阵营判断之前。**

`Event2C_LoadUnits @ 0x0800FB84` 走到 `0x08017C10` 第一件事就是查这一位：

```
08017C10  ldrb r1, [r6, #3]     ; 记录[+3]
08017C12  movs r0, #1
08017C14  ands r0, r1           ; GROW = +3 & 1
08017C16  cmp  r0, #0
08017C18  beq  #0x8017cb8       ; GROW == 0 → 完全跳过自动升级
```

编辑器里这一位叫 `L_3_UNITGROW_GROW`，下拉项是「**成長させない / クラス依存**」
（`EventUnitForm.Designer.cs:1274-1276`）。DoF 实测 **303/2805 = 11%** 的敌人记录为 0。

> ⭐ **编辑器里的标签就是运行时语义。** 不用去猜「这位是什么意思」——
> 下拉项的**两个选项文字**已经把它说完了：0 = 不成长（等级写多少就是多少），
> 1 = 依赖职业（跑自动升级）。**门控条件可以直接照抄标签。**

**② 自升级有两条路径，分派在 `0x08017C36`：**

```
(角色.abilityFlags[1] | 职业.abilityFlags[1]) & 0x80 置位  →  AutolevelRealistic @ 0x08018160
否则 角色 id > 0x40                                        →  AutolevelUnit      @ 0x08018120
否则                                                        →  AutolevelRealistic
```

DoF 实测 **2458 realistic / 44 unit / 303 none**（realistic 是绝大多数）。

**③ ⚠️ `unit[+0]` = pCharacter、`unit[+4]` = pClass —— 要先反推指针身份，别凭顺序猜。**

反汇编里 `unit[N]->off` 这种写法，`unit[N]` 到底是哪个指针表**必须用已知字段反推**：

| 证据 | 反推结论 |
|---|---|
| `AutolevelRealistic` 读 `unit[0]->+0x0B` 当「角色表初始等级」算 `count = 等级 − 初始等级` | 角色表 `+0x0B` = 等级 → **`unit[+0]` = pCharacter** |
| `IncreaseUnitStatsByLevelCount` 读 `unit[4]->+0x1B..+0x21` 当成长率 | 职业表 `+0x1B` = `enemyGrowths` → **`unit[+4]` = pClass** |

**规则**：遇到 `unit[N]->off`，先在**已知表**里找「哪个字段的语义能解释这条读」，
对上了才敢断言 `unit[N]` 是谁。**按声明顺序猜 = 迟早翻车。**

**④ `AutolevelUnit @ 0x08018120` 逐行：**

```
0801812E  movs r1, #0x80
08018130  lsls r1, r1, #1        ; 掩码 = 0x100 → 测 (角色.flags | 职业.flags) & 0x01
```

即**特性 2 的 bit 0「上級クラス(武器S)」**。置位 → 先跑一轮
`IncreaseUnitStatsByLevelCount(count = GetCurrentPromotedLevelBonus())`，**然后再无条跑**
`count = 等级 − 1`。（未置位只跑后者。）

**⑤ `GetCurrentPromotedLevelBonus @ 0x08037B44`：** `gChapterData[0x14] & 0x40`（hard 位）
→ **19**，否则 **9**。→ **同一份 ROM 在普通/困难下敌人属性不同**，投影要带 `--hard`。

**⑥ `IncreaseUnitStatsByLevelCount @ 0x08017FC4`：** 读 `unit[+4]->+0x1B..+0x21` 7 字节，
落到 `unit[+0x12, +0x14..+0x19]`（**`+0x13` 跳过** = 当前 HP），顺序
`hp / str / skl / spd(+0x16) / def / res / lck`。

> ⚠️ **第二个参数（那个 id 函数）函数体里根本没读。** 签名上有、实现里没有 ——
> 别按签名去解释行为。

**⑦ `AutolevelRealistic @ 0x08018160`：** 先把等级 `strb` 降回角色表等级，再循环 `count` 次
`CopyUnitToBattleStruct @ 0x0802A584` + `CheckForLevelUp @ 0x0802BA28` + `0x0802C1EC`
—— **用角色自己的成长率逐级模拟**。均值 = `角色成长 × count / 100`，分布是**二项分布**。

**⑧ ⭐ `GetAutoleveledStat @ 0x0802B9C4` 的闭式（区间算法）：**

```
v   = growth × count
q8  = v >> 3                  ; trunc(v/8)
bl  NextRN_N                  ; RN ∈ [0, q8 − 1]        ← 烧随机数（§1.6.2.1）
q16 = v >> 4                  ; trunc(v/16)
x   = v + RN − q16
bl  GetStatIncrease           ; floor(x/100)，余数用 Roll1RN 决定进位
```

可达增益 = **`[floor(xMin/100), floor(xMax/100) + 1]`**，
`xMin = v − q16`、`xMax = v + max(0, q8 − 1) − q16`；
期望 ≈ `(v − q16 + max(0, q8 − 1)/2) / 100`。**实现见 `cli/src/analysis/enemyStats.ts` 的 `autolevelBand`。**

**⑨ ⚠️ 攻速可以为负，这不是 bug。** `BattleLoadAS` 从**有符号**字节里减惩罚，**引擎不钳零**。
DoF 实测 74/2805 条为负：Gorgon Egg 速 0 拿 w10 → −4；Artillerist 速 0 拿 Ballista w20 → −11；
Arch Mogall 体格 5 拿 w20 → −8.8；Warlock 体格 10 拿 w20。**如实记录，别"修"。**

**⑩ 两个「去重口径」都对，别以为其中一个错了。** 按章去重 = **2805** 条（同一配置块被多章
引用时各算一次）；全 ROM 再去重 = **2723** 条（Lagdou Ruins 10 / map 55 与 C15: Homecoming /
map 36 共享 5 个配置块）。**报数时说明用的是哪个口径。**

**⑪ 命令：** `node src/index.ts enemy-stats ../fixtures/<rom>.gba [--hard]` → JSON。
输出 `totals.byRoutine` / `overall`（分位数）/ `chapters[]`（逐章 `summary` + `firstWeaponSummary`）
/ `samples[]`（扁平逐条，供消费方按阶段聚合）。DoF 实测
`min −14 / p25 6.0 / 中位 9.95 / p75 13.95 / max 32.0`，逐阶段中位
**分线前 6.3 ｜ 本线中段 9.8 ｜ 合流 10.8 ｜ 终盘 14.8**。

> ⭐ **一个「拍脑袋常数恰好对」的教训**：旧的 `ENEMY_AS = 10` 正好等于全 ROM 中位数（9.95），
> 所以当年的数不离谱。但**用阶段值一看，分线前 6.3 / 终盘 14.8 —— 「所有阶段用一个数」是错的**，
> 对应的追击率是 94% / 82% / 79% / **44%**。**中位数对 ≠ 模型对。**

## 2. 标准作业流程

### 步骤 1 — 确定 ROM 版本

读 file offset `0xAC` 起 6 字节 ASCII 游戏代码（`Rom.cs LoadLow()`）：

| 代码 | 版本 | RomInfo 类 |
|---|---|---|
| `AE7E01` | FE7U | `ROMFE7U.cs` |
| `AE7J01` | FE7J | `ROMFE7JP.cs` |
| `AFEJ01` | FE6J | `ROMFE6JP.cs` |
| `BE8E01` | FE8U | `ROMFE8U.cs` |
| `BE8J01` | FE8J | `ROMFE8JP.cs` |

### 步骤 2 — 找表的位置和大小

读对应的 `ROMFEXX.cs`，找 `xxx_pointer` / `xxx_datasize` / `xxx_maxcount`。

⚠️ **有些 `xxx_pointer` 不是固定常量，而是「搜索型」槽位**（FE8 的角色表/职业表/地图设置表
在修订版之间挪过位置）。`ROMFE8U.cs` 给的是一个**候选列表**，由 `U.FindROMPointer` 挑出第一个
满足条件的槽。它**有三个重载**（`U.cs:7644 / 7667 / 7705`），判据不同：

```
重载 A（2 参）：槽是安全偏移 + 槽里的值是安全 GBA 指针
重载 B（checkPointer）：再加 u32(tableOffset + checkPointer) 也是安全指针
重载 C（Func<uint,bool>）：再加 func(tableOffset) 为真
```

- 角色表用 B，`checkPointer = 0x2C`（每个角色都有的支援指针）
- 职业表用 B，`checkPointer = 0x88`
- **地图设置表用 C**，`func` 检查 `u32(tableOffset + 0x12) < 0xE`
  > ⚠️ 上游 bug：`map_setting_pointer` 的 lambda 实际写成 `rom.u32(0x12)` —— **常量，不是
  > `addr + 0x12`**。按**作者本意** `tableOffset + 0x12` 实现。

### 步骤 3 — 找表的结构体定义

1. 找到该表的编辑器 Form，例如角色表 → `UnitFE7Form.cs`。
2. 读它的 `static InputFormRef Init(Form self)`：
   - 第 3 个参数 = 指针槽偏移
   - 第 4 个参数 = **记录字节数**
   - 第 5 个参数 = **有效记录判定**（条数或终止条件）

   ⚠️ **第 5 个参数必须逐字照抄，两张表的规则不一样：**

   ```csharp
   // UnitForm.Init —— 固定条数，不扫终止符
   (int i, uint addr) => { return i < Program.ROM.RomInfo.unit_maxcount; }

   // ClassForm.Init —— 扫终止符
   (int i, uint addr) => {
       if (i == 0) return true;                 // index 0 恒保留
       if (i > 0xff) return false;              // 硬上限 256 条
       return Program.ROM.u8(addr + 4) != 0;    // 遇到 ID==0 即停
   }

   // SupportAttributeForm.Init —— 第 0 字节为 0 即停
   (int i, uint addr) => { return Program.ROM.u8(addr) != 0; }
   //   ↑ 相性加成表是「每个相性一条」，读到 7 条（相性 1..7）就没了。
   //     不是「每个支援等级一条」—— 别按 C/B/A 去理解这张表。
   ```

   定长表后面**不是空白填充**，是链接器塞进去的其他数据。读满会把垃圾当记录，
   并且**静默污染「ID → 名字」映射表**（后读到的垃圾覆盖正确名字），
   症状是某个引用突然显示成 `"--"` 之类，极难定位。

   **自检**：统计 `id === index` 成立的记录数。明显小于总数 → 读过头了或表基址错了。
3. 打开 `XxxForm.designer.cs`，跑这两条命令还原字段：

```bash
cd /Users/woxqaq/FEBuilderGBA/FEBuilderGBA/FEBuilderGBA   # = 仓库根/FEBuilderGBA/FEBuilderGBA

# 控件名 → 类型字母 + 字节偏移
grep -oE "this\.[A-Za-z_0-9]+ = new (System\.Windows\.Forms\.)?(NumericUpDown|TextBoxEx|ComboBoxEx|CheckBoxEx|ListBoxEx)" XxxForm.designer.cs \
  | sed 's/this\.//' | awk '{print $1}' | sort -u

# 标签文本 → 字段名
grep -nE 'this\.[A-Za-z_0-9]+\.Text = "' XxxForm.designer.cs \
  | sed 's/^\([0-9]*\):.*this\.\([A-Za-z_0-9]*\)\.Text = "\(.*\)";/\1 \2 = \3/'
```

两边对齐，结构体表就出来了。若某字段只有控件没标签，就是「未标注」——**不要猜含义**。

### 步骤 4 — 处理名字（文本 ID）

ROM 里名字是 `u16` 文本 ID，链路：

```
u16(addr) → 文本 ID → text_base + id*4 → 条目值
    → 分类（§1.3）：0x88xxxxxx = 未压缩 / 0x08xxxxxx = Huffman
    → 解码 → 字节流 → Latin-1 字符串 → RevConvertSPMoji 特殊字符还原
```

**逐行移植这 4 个函数（约 300 行），不要按描述重写**：
`huffman_decode()` / `append_string()` / `listbyte_to_string()`（`FETextDecode.cs`）
+ `UnHffmanPatchDecodeLow()`（同文件，未压缩分支）。
边界条件太多，照抄更快更准。

### 步骤 5 — 验证

见 §4。

## 3. 常用速查

```bash
# --- 挖 C# 源码 ---
FEB=/Users/woxqaq/FEBuilderGBA/FEBuilderGBA        # C# checkout 根（submodule 挂载点）
SRC=$FEB/FEBuilderGBA                              # C# 源码目录（.cs 平铺在这里）
cd $SRC

# 找某表的定义（读入规则也在这里）
grep -n "static InputFormRef Init" XxxForm.cs

# 找指针槽的值
grep -nE "unit_pointer|class_pointer|support_unit_pointer" ROMFE7U.cs

# 某字段被谁用
grep -rn "RomInfo.unit_pointer" --include="*.cs" .

# ⚠️ 别只看 Form.cs —— 门槛/说明文字常写在 Designer 的 EXPLAIN.Text 里
grep -n "EXPLAIN.Text\|AccessibleDescription" XxxForm.Designer.cs

# --- ⭐⭐ 找地址的最快路径：patch2 的 #ENGINE 补丁（§1.6.2 ③）---
ls $SRC/bin/Debug/config/patch2/FE8U/            # SYSTEM/ skill*/ stairs/ ... 按功能分目录
grep -n "ADDRESS\|DETERMINATION_ADDRESS\|^OFF\|^FIX" \
  $SRC/bin/Debug/config/patch2/FE8U/SYSTEM/<补丁>.txt
# ADDRESS 是文件偏移；OFF: 是改前的原始字节 —— 拿它去 ROM 核对，一致就说明指令还在原地

# --- ⭐ 参考代码答不上来时：反汇编 ROM 自己的代码（§1.6）---
# 1) 原版函数符号表（tab 分隔：地址 <TAB> 名字 <TAB> 说明）
grep -i <关键词> $SRC/bin/Debug/config/data/asmmap_FE8.txt
# 自动升级链路（§1.6.9）：AutolevelUnit / AutolevelRealistic / GetAutoleveledStat / GetStatIncrease
grep -iE "autolevel|GetStatIncrease|NextRN" $SRC/bin/Debug/config/data/asmmap_FE8.txt
# 2) 按符号切一段出来解（capstone；LLVM objdump 不支持裸二进制）
/Users/woxqaq/.workbuddy-ai/binaries/python/envs/default/bin/python \
  /Users/woxqaq/FEBuilderGBA/.workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py \
  /Users/woxqaq/FEBuilderGBA/fixtures/<rom>.gba 0x28550 0x285B0

# --- 跑已有的 CLI（CWD = 仓库根）---
cd /Users/woxqaq/FEBuilderGBA/cli
node src/index.ts validate ../fixtures/<rom>.gba    # 退出码 0 = 无 error 级失败
node src/index.ts text     ../fixtures/<rom>.gba --range 0x214-0x218   # 看每个 id 的存储格式
node src/index.ts roles    ../fixtures/<rom>.gba --playable-only       # 队伍搭配覆盖
node src/index.ts terrain  ../fixtures/<rom>.gba                       # 地形名 65 条
node src/index.ts supports ../fixtures/<rom>.gba                       # 含 C/B/A 回合数
node src/index.ts dump     ../fixtures/<rom>.gba --compact --out report.json
node src/index.ts enemy-stats ../fixtures/<rom>.gba [--hard]   # 敌人属性→攻速投影（§1.6.9）
node scripts/unit-placement-census.ts                 # 敌人/友军配置普查（§1.6.8）
node scripts/unit-placement-census.ts --chapter 22    # 单章逐块明细
./node_modules/.bin/tsc --noEmit
```

> ⚠️ 生成产物用 `--compact`。默认是美化输出，体积会翻倍。

> ⚠️ **macOS 自带的是 BSD grep，不支持 `\|` 交替。** `grep -n "A\|B" file` 会**静默返回空**，
> 看起来像「文件里没有」—— 这个坑在本次任务里骗过我一次。用 `grep -E "A|B"`，或直接用
> 检索工具。同理 `grep -rn --include='*.cs'` 在 zsh 下要引号，且**全仓扫 `.cs` 会被 OOM kill
> （exit 137）** —— 改用 Python 遍历。

`--playable-only` 把范围收窄到**有支援数据的单位** —— 目前唯一能从 ROM 推出的
「可玩名单」代理（§1.4）。FE8U 实测：255 个已填槽位 → 62 个，治疗者从 27 降到 8
且全是有名字的角色（不加开关时会混进 `Priest`、`Outlaw@001F` 这类通用模板）。

`text` 命令是最有用的诊断入口 —— 它直接打印每个 id 命中的格式
（`huffman` / `unhuffman` / `direct` / `invalid`）。排查「名字读不出来」先跑它。

| 想查什么 | 读这个文件 |
|---|---|
| 所有表的指针/大小 | `ROMFE7U.cs` / `ROMFE7JP.cs` / `ROMFE8U.cs` … |
| 版本识别 | `Rom.cs` → `LoadLow()` |
| 角色表 | `UnitFE7Form.cs` + `.designer.cs`；通用查询 `UnitForm.cs` |
| 职业表 | `ClassForm.cs` + `.designer.cs` |
| 支援（关系/会话/加成） | `SupportUnitForm.cs` / `SupportTalkFE7Form.cs` / `SupportAttributeForm.cs` |
| 道具表 | `ItemForm.cs` / `ItemFE6Form.cs` |
| 文本解码 | `FETextDecode.cs` |
| 指针工具 | `U.cs` → `toOffset` / `isPointer` / `isSafetyOffset` |
| ROM 读写原语 | `Rom.cs` → `u8/u16/u32/p32/p32p` |

## 4. 验证清单

不能靠「读代码觉得对」。必须用真实 ROM 验证。

1. **自洽性**（`cli` 的 `validate` 命令已实现）：
   - 名字是正常文字不是乱码
   - **非空名字比例** —— 原版接近 100%。若只有一半左右，**先怀疑 §1.3 的未压缩分支**
   - ID 连续唯一
   - 每个角色的职业 ID 都能解析到有名字的职业
   - **没有角色的「职业基础值 + 增量」`<= -1`** —— 按参考代码说明这种值会被补码成最大值
   - **报告出负增量的角色数量** —— 这个数字是「有没有把有符号字段当无符号读」的哨兵
   - 支援关系双向对称；支援人数与实际非零相手数一致；支援指针都落在 ROM 内
   - **相性加成表恰好 7 条且 ID 依次 1..7** —— 条数或顺序不对 = 指针槽/步长错了
   - **每条相性加成记录的第 7 字节（偏移 7）恒为 0** —— 游戏只写/只读偏移 1–6，
     非零即说明步长（8）读错了（§1.6.3）
   - **支援门槛自洽**：`C == 对话解锁上限 + 1`、`B == C + 1`、`A == B + 1`
     （即 `81 = 80+1`、`161 = 160+1`、`241 = 240+1`）—— 两边算法不同，能对上才算解对（§1.6.6）
   - **`>>1` 哨兵**：任取一条相性，`atk` 在 C/B/A 应为 `0/1/1`、`critAvoid` 应为 `2/5/7`。
     这是最便宜的一条「有没有做半点换算」的判据（§1.6.5）
   - **有移动力的**职业都有 **65** 项消耗表（移动力 0 的跳过，见 §1.4）
   - **章节链路**：地图设置表条数 > 0；有真标题 / 未使用槽 / 遭遇图的分裂能算出来；
     **标题里的 `C<n>` 与 `+0x80/2` 逐一吻合**（`+0x80` 解读正确性的独立证据）；
     带事件 plist 的章节都能解析到条件表；初始配置块都在 `u8 == 0` 处终止；
     事件走查无连续未知 opcode（warn）；有支援数据的角色大多能推出加入章节（warn）
   - **敌人投影**（§1.6.9）：记录数 > 0；**每条属性的 `lo <= mean <= hi`**（区间自洽的哨兵）；
     负攻速**当 warn 不当 error** —— 它是真实数据（Gorgon Egg / Artillerist 等），不是解析错。
     报告出负攻速条数与前几个职业名，便于人工确认「是意料之中的那几类」
2. **交叉验证**：在 Windows 上构建并运行 FEBuilderGBA，打开同一 ROM 对比显示值。
   `config/` 目录树和 `7-zip32.dll` **已经在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/` 里**（见 §1.4），
   不需要额外准备。注意 `FEBuilderGBA/FEBuilderGBA/bin/Debug` 下没有 exe，仍需自己 `msbuild`。
3. **常识**：对照公开的 FE 角色属性数据。

> **判据分级**：只有「解析可能错了」才当 error。
> 例：成长率是 u8（上限 255），升级判定 `rand(0..99) < growth`，
> 所以 **>100 是合法的**（表示必定成长），hack 常用。当 error 会误报 —— 当 warn。
>
> **另一个必踩的误报**：把「没有消耗表」当 error。移动力为 0 的静止职业
> （Gorgon Egg / Arcane Lock / 空白槽）本来就没有。判定必须带 `movementRange > 0`。
>
> **最有力的一次验证**：hack 里「有支援数据的角色」通常恰好等于**可玩阵容**，
> 数量连贯（实测 62 个、ID 连续 1–62）、名字与职业全部合理，且异常的调试单位
> （成长率爆表）恰好没有支援数据。这个一致性基本能证明整条链路
> （指针 → 记录 → 文本 → 支援 → 相性）都是对的。
>
> **交叉验证的免费版**：用 `--playable-only` 前后对比。加开关后如果治疗者列表
> 从「混着 `Priest` 等模板」变成「全是正常角色名」，说明支援数据这条索引是可信的。

## 5. 已知坑

| 坑 | 说明 |
|---|---|
| `*_pointer` 当表地址用 | 必须先 `p32()`。见 §1.1 |
| 文本条目只当 Huffman 解 | 约一半字符串是未压缩存的，会静默变成空串。见 §1.3 |
| 定长表读满 | 表尾后面是别的数据，会污染 ID→名字 映射。见步骤 3 |
| 把角色表和职业表当同一规则 | 角色表固定条数、职业表扫终止符。见步骤 3 |
| ID 起始位不一致 | 角色 ID **从 1 开始**（`(id-1)*size`）；职业 ID **从 0 开始**（`id*size`） |
| 支援表无固定条数 | 只能通过角色记录 `+44` 的支援指针索引，表不按 ID 排序 |
| 支援双向冗余 | A→B 和 B→A 是两条记录，建图要**去重** |
| 成长率 >100 当成 bug | 合法。u8 上限 255，>100 = 必定成长 |
| 名字里的 `@XXXX` 残留 | 如 `Franseza@001F`。**参考程序自己不一致**：`UnitForm.GetUnitNameByAddr` 保留（`.Trim()`），`StatusUnitsMenuForm.GetNameFast` 剥掉（`DirectAndStripAllCode`）。**两个都暴露**（`name` / `nameRaw`），别只挑一个 |
| 相性加成表当「每级一条」 | 错。是**每个相性一条**，7 条，第 0 字节 = 相性 ID 1..7。见步骤 3 |
| **相性加成表直接当「A 级加成」用** | **错。** 存的是**半点值**，游戏最后 `>>1`。`atk` 存 1 → C/B/A = `0/1/1`，不是 `1/2/3`。见 §1.6.5 |
| **说「相性加成表和公版对不上 / 被改过」** | **错。** 表是未改动的公版，只是存半点。`>>1` 后精确落在公版表上（`Dark == Light` 也是公版行为）。见 §1.6.5 |
| **说「支援 C/B/A 换算在参考代码里没有算术」** | **错。** 编辑器不用算战斗结果，算术在 **ROM 的代码里** —— 反汇编 `GetUnitSupportBonuses` 即可。见 §1.6 |
| 把「能升到 C 的点数」当 81 | 是 **80**（对话解锁点），对话后才变 81。差 1 就是「有没有真的看过支援对话」。见 §1.6.6 |
| 把「支援上限 5」当「5 个伙伴」 | 是**等级数之和**（A=3/B=2/C=1）。一个 A + 一个 B 就满了。见 §1.6.6 |
| 说「地形名字拿不到」 | **错。** `map_terrain_name_pointer` + `MapTerrainNameForm.cs`，65 条。见 §1.4 |
| `config/data/*.txt` 说「不在仓库」 | **错。上游在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/`**（422 文件，被 git 跟踪）；CLI 只读 vendored 的 `cli/data/`（27 文件）。见 §1.4 |
| 直接读 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/` | 会把 CLI 和 C# 仓库耦合。复制最小子集进 `cli/data/`，只读副本 |
| FE6 指针特殊 | `UnitForm.Init` 对 FE6 有专门分支，注释说「0x00 へのポインタしかない」。做 FE6 时单独查 |
| 说「出场时间拿不到」 | **错，已跑通**。走 §1.4 的指针链路（`map_setting` → 条件表 → `LOAD1`） |
| 用「ID 顺序」猜加入顺序 | 不要。角色 ID 顺序 ≠ 加入顺序，用 `LOAD1` / 初始配置块的章节号 |
| 暴力扫表找角色出场 | 实测 2,186,116 个候选，纯噪声。走指针链路。见 §1.4 |
| 把 `40050200....` 当招募 | 那是**增援分派**，同样带 `POINTER_UNIT`。靠 `0x2C` opcode + 前导字节过滤 |
| **说「敌人摆放表拿不到」/「FE8 的 ENEMY_UNIT 槽在哪」** | **错，这张表不存在。** 敌人和自军共用同一种 20 字节配置记录，阵营由记录自己 `+3` 字节 bits 1–2 决定，块由事件脚本引用。见 §1.6.8 |
| 说 `GetChapterEnemyUnitDefinitions` 是「常规章节敌人表」 | **错。** 它只读条件表 `+0x3c/40/44` = **槽 15/16/17 = `FREEMAP_ENEMY_UNIT`**，是**魔物图**用的。常规章节的初始敌人在 `START_EVENT`（槽 18） |
| 把配置记录 `+3` 按 u16 读 | **错。** `+3` 是 u8（阵营/等级位域），`+4` 就是坐标。参考代码自己不一致（`EventUnitForm.cs:166` u16 / `:501` u8）；按 u16 读原始值是两个字段的混合。见 §1.6.8 |
| 猜阵营字段的取值 | 别猜。`InputFormRef.cs:993-1094` 有逐字节读改写，下拉项文字在 `EventUnitForm.Designer.cs`：**0 自軍 / 1 友軍 / 2 敵軍 / 3 消滅** |
| 裸扫字节找「某种指令形态」 | **4 字节字面量在全 ROM 里几乎必然撞出假阳性**（`40050200` 裸扫 210 命中 → 加「参数是合法 GBA 指针」约束后 0 命中）。优先用**反汇编器走脚本**，只在指令边界取参数。见 §1.6.8 |
| 把 hack 的数据怪癖当解析 bug 去"修" | 例：DoF `mapIndex 22` 的槽 11 是 9 条全友軍，而 `GetChapterAllyUnitCount` **不过滤阵营** → hard 出击位真的是 9。这是游戏会算出的数。**如实记录 + 标待上机核实**，别擅自改数 |
| **把「敌人属性」当确定值** | **错。** 自动升级 `GetAutoleveledStat` 会 `bl NextRN_N` + `bl GetStatIncrease`（后者又 `bl Roll1RN`）→ 基准 `成长 × 等级 / 100`，**带 ±1 随机成分**。**输出区间，别挑一个数。** 见 §1.6.9 ⑧ |
| **漏掉 `+3` bit 0 门槛** | **错。** `Event2C_LoadUnits` 在**阵营判断之前**先查 `+3 & 1`：0 = 完全不自动升级。编辑器标签 `成長させない / クラス依存` 就是语义。DoF 11% 的记录是 0。见 §1.6.9 ① |
| 凭声明顺序猜 `unit[N]` 是哪个指针表 | **错。** `unit[+0]` = pCharacter（`unit[0]->+0x0B` 当角色等级用）、`unit[+4]` = pClass（`unit[4]->+0x1B` = `enemyGrowths`）。**用已知字段反推身份**，别按顺序猜。见 §1.6.9 ③ |
| 按函数签名解释行为 | `IncreaseUnitStatsByLevelCount` 的第二个参数（id 函数）**函数体里根本没读**。签名上有 ≠ 实现里用 |
| 把负攻速当解析 bug | **错。** `BattleLoadAS` 从有符号字节里减惩罚，**引擎不钳零**。DoF 74/2805 条为负（Gorgon Egg 速 0 拿 w10 → −4；Artillerist 拿 Ballista w20 → −11）。**如实记录。** 见 §1.6.9 ⑨ |
| 普通/困难用同一份敌人属性 | **错。** `GetCurrentPromotedLevelBonus` 看 `gChapterData[0x14] & 0x40`：hard → **19**，否则 **9**。投影要带 `--hard`。见 §1.6.9 ⑤ |
| **生成物脚本自己会写文件时用 shell 重定向到同一路径** | **会静默损坏文件。** `node x.ts --route=A > out/x-A.md`：脚本**自己**写 `out/x-A.md`，shell 先截断 → node 写入 → stdout（`Wrote ...`）被追加 → 文件尾嵌两行 ASCII。症状不是"中文乱码"，是 `file` 报 `data` / `strictUTF8 false` / 出现 U+FFFD。**直接跑脚本，不要 `>`**；复验用 `new TextDecoder('utf-8',{fatal:true})` |
| 地图设置表报 0 条 | hack 把记录 `+0` 改成指针，参考代码终止判定失效。退化为结构扫描（§1.4 偏差 ①） |
| **把地图设置表索引当章号** | **错。** 索引每张地图 id 一行，含未使用槽 / 遭遇图 / bonus 图。章号在 `+0x80/2`，标题在 `+0x70`。见 §1.5 |
| 只看章号判「是否空槽」 | 序章章号也是 0，与未使用槽位同值。判空槽要看**标题**是否为空 |
| 把 `@001F` 标题当解析失败 | 那是世界地图遭遇图，且**章号与 C15–C21 重复**。不是 bug，要按「非剧情图」处理 |
| 拿同一 unitId 的泛型填充当角色 | 只有 `classId == 0 \|\| classId == 自己职业` 才归因。见 §1.4 偏差 ② |
| 特性位 key 当十进制 | key 是**十六进制**（`U.atoh`）。`13` = `0x13` → `+41 0x08`，不是十进制 13 |
| **能力值当绝对值用** | **错。** 角色表 `+12..+19` 是**相对职业基础值的有符号增量**，实际值 = 职业基础值 + 增量。见 §1.2.1 |
| **用 `u8()` 读能力值** | **错。** 字段有符号，`0xFF` = −1。症状是某项 ≥128。用 `i8()`。见 §1.2.1 |
| 把「增量为 0」当缺数据/hack 怪癖 | 0 是最常见的值（实测 70/255），含义是「不比职业基础值多」 |
| 给职业贴「骑马 / 重甲」标签 | 现在**可以**了 —— 特性位 `13`=骑马、`27`=鎧△ 干净分开。消耗表只作交叉校验 |
| 静止职业没有消耗表当 bug | 移动力 0 的职业（Gorgon Egg 等）本来就没有。校验要加 `movementRange > 0` |

## 6. 从报告产出「练谁 / 支援怎么配」结论（分析配方）

解析完成后，用户真正要的是**结论**，不是 JSON。`dump` 出的 `report.json` 里字段够用，
按下面顺序读（用 `node -e` 抽取，别整份打印）：

1. **定可玩名单** —— 用 `availability.joinOrder`（有支援数据的角色），**不要**用 `units[]`
   （含敌人/模板/空白槽）。**务必剔除调试单位**：特征是 `supportPartnerCount === 0` +
   成长总和离谱（实测 Rophon = 1111）。用 `joinOrder` 里的 `note` 标出「LOAD2 早于 LOAD1」
   和「无 LOAD1」的人，结论里要声明这些时点不确定。
2. **读时间线** —— `joinOrder[].joinChapterNumber` + `joinChapterTitle`，**不要用 `joinChapter`**
   （那是表索引，会数进未使用槽位和遭遇图，见 §1.5）。
   标出 `joinChapterIsStory === false` 的行（加入点落在无标题沙盒图上），**这些不可信**。

   ⚠️ **不要写「有招募空窗期，所以空窗期前的人就是主力」** —— 这是**因果跳跃**，
   曾经被用户当场驳回（「这有什么因果关系？」）。空窗期**本身不决定**练谁。
   它唯一能支持的推理是**有限且要带条件**的：

   > 空窗期 = 这段时间不会有新人加入 → 已到手的队伍必须自己扛过这几章 →
   > 对这批人投入资源**不会因为新人到来而立刻贬值**。

   所以它只能当**辅助理由**，而且必须先看**空窗有多长**：
   实测 `dream-of-five.gba` 的最大空窗只有 **1–2 章**（`C14A` / `C13B`–`C14B`），
   终盘另有 **3 章**（`C22`–`C24`）—— 用索引算会夸大成「11 章」。
   1–2 章根本不够回本，**这个理由在本 ROM 上基本不成立**。
   真正决定「该练谁」的是步骤 3（初始值）、步骤 4（成长 + 加入章号）、步骤 5（职能缺口）。
   **报告里如果出现「因为有空窗期所以练他们」，删掉重写。**
3. **看初始值** —— `units[].startingStats`（= 职业基础值 + 有符号增量），**不要**用 `stats`
   （那是原始增量，见 §1.2.1）。这一步决定「这个人上场能不能立刻打」。
4. **排成长** —— `units[].growthTotal` 排序，但要**同时看加入章号**：晚来 + 低成长 = 预备转职
   （`weaponLevels` 到 251 = S 级，上场即用，别投入）。
   成长高 ≠ 现在强：Tricia 成长总和排第 4，但 Henchwoman 职业基础值很低，初始值偏弱。
5. **查职能缺口** —— 用 `role.mobility` / `weaponLevels` / `role.hasStaff` 统计。
   稀缺职能优先级最高（实测杖只有 8 人、飞行 6 人、重甲 2 人 → 早期那一个不可替代）。
   舞者/诗人**不在 `role.specialAction` 里**（单位级 role 没有这个字段），
   要看 `roles` 命令的 `classRoles[].specialAction`（`dancer`）或直接按职业名找。
6. **配支援** —— `supports.edges[]` 有 `initial` + `growth`，两者都要看：
   `initial` 高 = 立刻拿得到，`growth` 高 = 快升 A。**关键过滤**：用章号
   只保留「两人都已加入」的对（否则会推荐一堆要到终盘才成立的组合）。
   现在还能直接给**回合数**：`turnsToConversation`（还要相邻几回合才能**解锁对话**）
   和 `turnsTo`（解锁 + 对话之后，还要几回合才真正到那一级）。
   两者**差一个对话**，报的时候别混（见 §1.6.6）：
   实测 `Rena ↔ Kolbane`（initial 5 / growth 3）→ `turnsToConversation C:25 B:27 A:27`，
   `turnsTo C:25 B:52 A:79`。另外 `edges[]` 里可能有**开局就已经是 C/B/A** 的对
   （实测 96 对里有 3 对），这类不用规划，直接算进「现有战力」。
7. **相性搭配** —— `supportAffinities[]` 现在给的是**真正能用的加成**（已做半点换算），
   每项都带 `byRank.C / B / A`。别再自己乘 —— 表里的原始值要 `>>1` 才是游戏实际数值（§1.6.5）。
   用法：把两人相性代进 `bonusByAffinity`，各自对**对方相性**那一行取值，
   再按 `pairBonus` 求和（双方相性都算）。
   相性倾向速记：Fire/Anima = 命中、Ice/Thunder = 防御、Wind/Dark/Light = 回避，
   七种相性**都加 atk**（`0/1/1`）。

**输出时必须写清边界**：加入章是推导值（且 `joinChapterIsStory === false` 的更不可信）、
可玩名单是代理（「有支援数据」）、回合数是「相邻且不背人」的理想值、
地形名字对未命名槽位只能给特性提示。把 `report.limitations` 里的条目翻译成人话放进结论，
否则下游会把「数据没有」当成「数据是 0」。
