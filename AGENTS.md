# AGENTS.md

## 0. 先读这段：这个仓库对你的意义

**这个仓库不是你要开发的项目。**

它是 **FEBuilderGBA** —— 一个成熟的 C# WinForms 工具，用来编辑 GBA 火焰纹章 ROM。它本身能跑、能改 ROM，但那不是我们关心的事。

我们关心的是：**它把 GBA 火纹 ROM 的内存布局、指针表、数据结构，全部用代码写死了。** 这些硬编码的偏移量和结构定义，就是我们要的「权威规格」。

所以：

- **`FEBuilderGBA/` 是上游仓库的 git submodule，其 C# 代码是只读参考资料。** 不要修改、不要重构、不要给它加功能、不要试图修它的 bug。
- 我们要写的 CLI 放在 **`cli/`**（本仓库根目录下的新目录，与 `FEBuilderGBA/` 平级）。
- 唯一的例外见 §8 —— 必要时可以构建并运行参考程序，用来**交叉验证**我们解析出的数据是否正确。这是很有价值的验证手段。

```
FEBuilderGBA/            ← git submodule：上游 FEBuilderGBA 仓库（只读参考）
├── FEBuilderGBA.sln
└── FEBuilderGBA/        ← C# 源码 + 构建产物（768 个 .cs 平铺在这里）
    ├── FEBuilderGBA.csproj
    └── bin/Debug/       ← 构建产物；config/data 在这里（见 §1.1，上游已提交进 git）
cli/                     ← 我们写的 TypeScript/Node CLI（新增）
mgba/                    ← mGBA Lua 凹点助手（新增，见 §3.15 / §3.17）
docs/                    ← 本文件拆出去的深度内容（见 §0.1）
```

> ⚠️ **路径基准（2026-10-01 起）**：仓库根 = 本文件所在目录。
> **C# checkout 根 = `FEBuilderGBA/`（submodule 挂载点），源码目录 = `FEBuilderGBA/FEBuilderGBA/`。**
> 名字重复两层是 submodule 路径决定的，**不是笔误**。
> 2026-10-01 之前 C# 仓库直接挂在仓库根，所以**旧文档里的路径都少了一层 `FEBuilderGBA/`**
> —— 看到「`FEBuilderGBA/` 后面紧接 `bin/Debug` / `config/` / 某个 `.cs` 文件名」这种写法时，
> 自己补上一层即可（本次已全仓修正）。

### 0.1 ⭐ 文档地图 —— 本文件被截断时从这里找

**本文件是「每次会话都会被注入」的项目指南，所以只放「不看就会犯错」的东西。**
深度内容按主题拆在 `docs/` 下，**章节编号一律保持原样**（`§3.18`、`§5.1` 这类引用全仓通用）。

| 想查什么 | 去哪 |
|---|---|
| **ROM 版本识别 / 关键指针 / 角色表 / 职业表 / 地形名表** | [`docs/rom-layout.md`](docs/rom-layout.md)（§3.1–§3.4、§3.12） |
| **支援关系 / 支援会话 / 相性加成 / Huffman 文本解码** | [`docs/supports-and-text.md`](docs/supports-and-text.md)（§3.5–§3.9） |
| **出场时间与加入顺序 / 编队与强制出击 / DoF 战役结构 / 敌人摆放** | [`docs/chapters-and-events.md`](docs/chapters-and-events.md)（§3.11、§3.14、§3.16、§3.19） |
| **升级抽点 / 战斗掷骰 / 攻速与追击 / 敌人属性投影** | [`docs/battle-math.md`](docs/battle-math.md)（§3.15、§3.17、§3.18、§3.20） |
| **反汇编 ROM 自己的代码**（参考代码答不上来时） | [`docs/disassembly.md`](docs/disassembly.md)（§3.10、§3.13） |
| **CLI 工程约定 / 验证策略** | [`docs/cli-conventions.md`](docs/cli-conventions.md)（§5、§6） |
| **参考程序的构建与运行**（仅 Windows） | [`docs/reference-build.md`](docs/reference-build.md)（§8） |
| **五条系统链路图 + 全部章节一行摘要** | [`docs/README.md`](docs/README.md) |

**没有拆出去、仍留在本文件里的**（⚠️ 如果本文件被截断，这几节要自己 `Read` 完整文件）：
§1 目标与进度 · §1.1 `config/data` 在哪 · §2 **挖结构方法论** · §4 **陷阱清单** ·
§7 权威来源索引 · §9 快速参考。

### 0.2 ⭐ 八条最贵的教训（详情见括号里的章节）

1. **「参考代码里没有这段计算」≠「数据不在 ROM 里」。** FEBuilderGBA 是**编辑器**不是模拟器，
   从不算战斗结果。正确问法是「有没有一个 `Form` 在读这个字段」（§4.12）。
2. **值看起来像脏数据时，先怀疑自己漏了一层变换**（×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量），
   **别先怀疑 ROM**。正确动作是反汇编 ROM 自己的代码（§4.12、§3.13）。
3. **`bl <addr>` 必须去 `asmmap_FE8.txt` 查那个地址是什么，不能凭形状猜。** 曾把一个 RNG 函数
   当成除法 helper，得出**完全相反**的结论并写进了报告（§3.13）。
4. **一半的字符串是「未压缩」存的**（指针带 `+0x80000000`）。只实现 Huffman 会静默丢掉约一半名字，
   症状是「一部分名字正常、一部分是空串，而空串的记录其他字段全正常」（§4.3、§3.9）。
5. **`RomInfo.*_pointer` 是「指针槽」偏移，不是表地址** —— 读表前必须 `p32()`（§2.2、§4.2）。
6. **定长表不能读满**，而且**角色表与职业表的读入规则不一样**（固定条数 vs 扫终止符）。
   读满会**静默污染 ID→名字 映射**（§4.9、§4.10）。
7. **角色表 `+12..+19` 是「相对职业基础值的有符号增量」**，必须 `rom.i8()`。用 `u8` 读不会报错，
   只会让「体格 −2」变成「体格 254」（§3.3.1、§4.11）。
8. **`config/data` 在 `bin/Debug` 下，不在源码树**。断言「某数据不可得」之前先
   `find . -name '<文件名>'`（§1.1、§4.7）。


---

## 1. 当前目标与进度

**目标：把 ROM 解析成结构化 JSON，交给 AI 分析「哪些角色值得练、支援关系怎么搭配」。**

要产出的数据：

1. **角色数据** —— 基础能力、成长率、初始职业、武器等级、体格、移动力等
2. **支援关系** —— 谁能支援谁、支援初始值、支援成长值、支援等级加成
3. **队伍搭配** —— 武器覆盖、机动性、治疗/魔法覆盖、相性分布（§3.4.1 / §3.7）
4. **出场时间** —— ✅ 已跑通，见 §3.11（`map_setting` → 事件 plist → 条件表 → 初始配置 / `LOAD1`）

### 进度

| 项 | 状态 |
|---|---|
| FE8U 角色表 / 职业表 / 支援关系 | ✅ 已跑通（实测 `fixtures/dream-of-five.gba`） |
| 文本解码（Huffman + 反 Huffman 双格式） | ✅ 已跑通，249/255 角色名可解 |
| 相性加成表 / 相性名 | ✅ 已跑通（7 条，相性 1–7；**表是未改动的公版**，值是半点，见 §3.7） |
| **加成随 C/B/A 放大（×0/1/2/3 再 ÷2）** | ✅ 已跑通（反汇编 ROM 自己的代码，见 §3.7.2 / §3.13） |
| 支援 C/B/A 点数门槛 | ✅ 81 / 161 / 241（`SupportUnitForm.Designer.cs:460`，见 §3.5.1） |
| 支援对话解锁点数 / 距离 / 每人 5 级上限 | ✅ 80 / 160 / 240；加成 3 格、攒点 1 格；见 §3.5.1 |
| 地形名表（65 条） | ✅ 已跑通（`map_terrain_name_pointer`，见 §3.12） |
| 职业特性位 → 机动性/再移动/舞蹈等 | ✅ 已跑通（`config/data/unitclass_checkbox_*.txt`，见 §3.4.1） |
| 职业移动消耗表 → 机动性交叉校验 | ✅ 已跑通（`flying` / `mounted` / `armour` / `normal`） |
| 出场章节 / 加入顺序 | ✅ 已跑通（79 张地图、330 条 `LOAD*` 指令，62/62 支援角色有证据，见 §3.11） |
| **每章编队人数（部署槽位）** | ✅ 已跑通（初始配置块条数，`Chapter.deploySlots` / `deploySlotsHard`，见 §3.14.1） |
| **强制出击（必上）名单** | ✅ 已跑通（`event_force_sortie_pointer`，28 条；反汇编核实记录格式，见 §3.14） |
| 职业地形回避/防御/魔防三表 | ✅ 已接入（`UnitClass.terrainBonuses`，职业记录 `+68/+72/+76`） |
| `info` / `units` / `classes` / `roles` / `supports` / `terrain` / `chapters` / `text` / `dump` / `validate` | ✅ 全部可用（`validate` 37 项检查，0 错误） |
| **mgba 凹点助手**（`mgba/fe-aodian.lua`，升级抽点算术 + 战斗随机数消耗，**只读面板**） | ✅ 自测 124 项全绿（fengari 假内存）；⏳ **未在 mGBA 实机加载验证**，见 §3.15 / §3.17 |
| FE7U | ⏳ 指针常量已核实（§3.2 / §3.11），代码路径已就绪但**未在真实 ROM 上验证** |
| FE7J / FE8J / FE6J | ❌ 未支持（SJIS 文本解码未实现；FE6 记录结构不同） |

> **维护约定**：每完成或推翻一项就当场更新这张表。进度表落后于代码比没有进度表更糟——
> 下一条「已实现/未验证」的错误结论往往就是从一张过期表长出来的。

> **`fixtures/dream-of-five.gba` 的真实身份**：游戏代码 `BE8E01`（FE8U），
> 但标题字段被改成了 `FIREEMBLEM2E`（FE7U 的标题）。**以游戏代码为准，不要信标题。**
> 这是一个大幅改造过的 FE8U hack：职业表 128 条（原版更少）、
> 部分角色用未压缩文本（§3.9）、部分成长率 >100（合法）、
> 地图设置表 79 条，且每条记录的 `+0` 被改写成了指针（§3.11.2）。

FE7 有 **FE7U**（美版）和 **FE7J**（日版）两套完全不同的指针布局，代码里是 `ROMFE7U.cs` / `ROMFE7JP.cs` 两个类。**先做哪个取决于你手上 ROM 的版本**（见 §3.1 识别方法）。中文汉化版通常基于 FE7U 或 FE7J，且可能打了文本补丁，见 §4.3。

---

### 1.1 `config/data` 在哪里 ⭐⭐

**这一条曾经搞错过，代价是白扔了一整轮工作。记牢：**

```
FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/     ← 上游源头，422 个文件，就在这里
FEBuilderGBA/FEBuilderGBA/bin/Release/config/data/
cli/data/                                            ← 我们 vendored 的副本，27 个文件
```

不是 `FEBuilderGBA/FEBuilderGBA/config/data/`。`U.ConfigDataFilename()`（`U.cs:3180`）拼的是

```
Path.Combine(BaseDirectory, "config", "data", type + RomInfo.TitleToFilename + "." + lang + ".txt")
```

而 `BaseDirectory` 是**可执行文件所在目录**，即 `FEBuilderGBA/FEBuilderGBA/bin/Debug`。
源码树里的 `config/` 目录确实不存在 ——
但 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/` 一直在。**先 `ls` 再下结论。**

#### CLI 不再读 `FEBuilderGBA/`（已 vendored）

早期 `cli/src/config/data.ts` 的搜索路径会去 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/` 里找文件，
**这等于把 CLI 和 C# 仓库耦合在一起** —— 单独 clone `cli/` 就跑不起来。
现在改成：把用到的**最小子集复制进 `cli/data/`**，CLI 只读这份副本。

副本 = **3 个前缀 × 3 个游戏 × 3 种语言 = 27 个文件（约 512K）**：

| 前缀 | 内容 | 用在哪 |
|---|---|---|
| `unitclass_checkbox_<game>` | 职业特性位名（key 是**十六进制**） | §3.4.1 机动性/再移动 |
| `event_<game>` | 事件 opcode 表（583 条 pattern） | §3.11 事件反汇编 |
| `eventcond_<game>` | 20 个章节条件槽的名字与顺序 | §3.11 条件表索引 |

`<game>` ∈ `FE6` / `FE7` / `FE8`（`titleFragment` = 版本号前 3 字母）；
语言后缀 `''`（日文）/ `.en` / `.zh`。**`event_category_*` 用不到，没复制。**

**刷新方式**：FEBuilderGBA 更新后，从 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/` 重新拷这 27 个文件。
搜索路径（`cli/src/config/data.ts`）：`$FEBUILDERGBA_CONFIG`（显式覆盖）→ `cli/data/`。
文件名解析顺序：`<prefix><game>.txt` → `.en.txt` → `.zh.txt`。

> 验证解耦：把 `cli/{src,data,package.json,tsconfig.json}` 拷到仓库外单独跑，
> `chapters` / `roles` 输出与在仓库内完全一致。


---

---

## 2. 如何从这个 C# 代码库里挖 ROM 结构

这是最重要的方法论。五种手法，按使用频率排序。

### 2.1 一切指针都在 `ROMFEINFO` 的子类里

每个游戏一个类：`ROMFE7U.cs`、`ROMFE7JP.cs`、`ROMFE6JP.cs`、`ROMFE8U.cs`、`ROMFE8JP.cs`、`ROMFE0.cs`（未知 ROM）。

文件里长这样：

```csharp
unit_pointer = 0x9A274;   //ユニットの開始位置
unit_maxcount = 253;      // ユニットの最大数
unit_datasize = 52;       // ユニットのデータサイズ
```

这就是 ROM 里所有已知表的位置和大小。**这是你的主要信息源。**

### 2.2 ⚠️ 这些值几乎都是「指针槽」的偏移，不是表本身的偏移

这是最容易踩的坑，务必理解清楚：

```
RomInfo.xxx_pointer  =  「存放指针的那个 4 字节槽位」的 file offset
表真正的 file offset  =  p32(RomInfo.xxx_pointer)
```

即 `p32(slot)` = 读取 slot 处的 u32（一个 `0x08xxxxxx` 的 GBA 指针），再减去 `0x08000000` 得到 file offset。

证据在 `PatchForm.cs:9372` `ReplacePointerSub()`：它用 `Program.ROM.u32(Program.ROM.RomInfo.item_pointer)` 读出一个**原始 GBA 指针**去和 `searchPointer` 比较；以及 `InputFormRef.cs:5792` 的 `Init()`：

```csharp
this.BasePointer = U.toOffset(basepointer);
if (U.isSafetyOffset(this.BasePointer)) {
    this.BaseAddress = Program.ROM.p32(this.BasePointer);   // ← 解引用一次
}
```

**所以 CLI 里读取任何表之前，必须先解引用。** 只有少数以 `_address` 结尾的字段（如 `max_level_address`、`text_recover_address`）是直接偏移，不需要解引用。

用 TypeScript 表达：

```ts
const POINTER_BASE = 0x08000000;

/** 读 u32 并当作 GBA 指针转成 file offset */
function p32(buf: Buffer, slotOffset: number): number {
  const raw = buf.readUInt32LE(slotOffset);
  return raw >= 0x08000000 && raw < 0x0A000000 ? raw - POINTER_BASE : raw;
}

/** 二级指针：p32(p32(slot)) */
function p32p(buf: Buffer, slotOffset: number): number {
  return p32(buf, p32(buf, slotOffset));
}
```

### 2.3 表结构靠 `InputFormRef` 的构造参数还原

每个编辑器 Form 都有一个 `static InputFormRef Init(Form self)`，那就是一张表的完整定义：

```csharp
return new InputFormRef(self
    , ""                                                            // 列表控件名
    , Program.ROM.RomInfo.unit_pointer                              // ① 指针槽偏移
    , Program.ROM.RomInfo.unit_datasize                             // ② 每条记录字节数
    , (int i, uint addr) => i < Program.ROM.RomInfo.unit_maxcount   // ③ 有效记录判定
    , (int i, uint addr) => { ... }                                 // ④ 列表显示名
    );
```

- ② 就是你要的**结构体大小**
- ③ 就是你要的**记录条数**（`DataCount`）或终止条件
- 表地址 = `p32(①)`（见 §2.2）

### 2.4 字段偏移藏在控件名里 —— 关键技巧

FEBuilderGBA 的 WinForms 控件遵循一个命名约定：**`<类型字母><字节偏移>`**。

| 前缀 | 含义 | 字节数 |
|---|---|---|
| `B` | byte | 1 |
| `W` | word | 2 |
| `D` | dword | 4 |
| `P` | pointer | 4 |

定义在 `InputFormRef.cs:5037` 附近的 `GetDataSize()`。

控件旁边那些 `J_11`、`L_24_WEAPON`、`X_WEAPON_LV` 之类的 Label，它们的 `Text` 就是字段名（日文）。

**所以还原一个结构体的标准操作是：**

```bash
# 1. 列出所有绑定到结构体的控件（名字里就带偏移量）
grep -oE "this\.[A-Za-z_0-9]+ = new (System\.Windows\.Forms\.)?(NumericUpDown|TextBoxEx|ComboBoxEx|CheckBoxEx|ListBoxEx)" UnitFE7Form.designer.cs \
  | sed 's/this\.//' | awk '{print $1}' | sort -u

# 2. 提取所有 Label 的文本，用来给字段命名
grep -nE 'this\.[A-Za-z_0-9]+\.Text = "' UnitFE7Form.designer.cs \
  | sed 's/^\([0-9]*\):.*this\.\([A-Za-z_0-9]*\)\.Text = "\(.*\)";/\1 \2 = \3/'
```

两边一对，结构体就出来了。§3 里的表格就是这么挖出来的。

### 2.5 名字不是字符串，是文本 ID —— 必须过 Huffman 解码

ROM 里存的是 `u16` 文本 ID，不是字符。链路是：

```
u16(unitAddr)  →  文本 ID  →  TextForm.Direct(id)  →  FETextDecode.Decode(id)
```

算法实现在 `FETextDecode.cs:327` `huffman_decode()`。详见 §3.8。

---

---

## 3. FE7 / FE8 数据字典（已从代码核实）→ 已拆到 `docs/`

> **§3.1 – §3.20 全部移到 `docs/` 下 5 个文件，章节编号不变。** 原因：这一节有 110KB，
> 占原文 66%，把 `AGENTS.md` 撑到 167KB，而它每次会话都会被注入 —— **注入时会被截断**。

| 文件 | 覆盖 |
|---|---|
| [`docs/rom-layout.md`](docs/rom-layout.md) | §3.1 版本识别 · §3.2 关键指针 · §3.3 角色表 · §3.4 职业表 · §3.12 地形名表 |
| [`docs/supports-and-text.md`](docs/supports-and-text.md) | §3.5 支援关系 · §3.6 支援会话 · §3.7 相性加成 · §3.8 Huffman · §3.9 两种文本格式 |
| [`docs/chapters-and-events.md`](docs/chapters-and-events.md) | §3.11 出场/加入链路 · §3.14 编队与强制出击 · §3.16 DoF 战役结构 · §3.19 敌人摆放 |
| [`docs/battle-math.md`](docs/battle-math.md) | §3.15 升级抽点 · §3.17 战斗掷骰 · §3.18 攻速追击 · §3.20 敌人属性投影 |
| [`docs/disassembly.md`](docs/disassembly.md) | §3.10 参考代码拿不到的东西 · §3.13 反汇编 ROM 自己的代码 |

**通用前提**（每个数据字典文件开头也重复了一遍）：
所有偏移都是 **file offset**（不是 GBA 地址，GBA 地址 = file offset + `0x08000000`）；
所有 `*_pointer` 字段都是**指针槽**，用前先 `p32()`。


---

## 4. 陷阱清单

> 每条都是**静默出错**（不报错、结果看着合理），所以值得逐条对照。
> 表结构细节在 `docs/` 对应文件里，这里只留**判据**。

### 4.1 file offset vs GBA 地址

`u8/u16/u32(addr)` 的 `addr` 是 **file offset**；而 `p32()` 读出来的是 **GBA 地址**，必须 `- 0x08000000`。

`U.toOffset()`（`U.cs:2206`）自动做这件事（值 ∈ `[0x08000000, 0x0A000000)` 才减基址，否则原样返回）。
**TS 里要显式实现这个函数**，别假设输入一定是什么。

### 4.2 `RomInfo.*_pointer` 是槽位不是地址

见 §2.2。**每次读表前先 `p32()`。** 例外：以 `_address` 结尾的字段（`max_level_address`、
`text_recover_address`、`*_switch*_address` 等）是直接偏移。

### 4.3 一半的字符串是「未压缩」存的 —— 不处理就会莫名读不出名字

**这是最容易踩、也最难自己发现的坑。** 症状很迷惑：一部分角色名读得好好的，
另一部分全是空串，而且空串的记录**别的字段（职业、等级、能力值）全都正常** ——
所以你会以为是文本表本身有洞，而不是解码器缺了一条分支。

**一句话判据**：条目值 ∈ `0x88000000..0x8A000000` → 未压缩（走 `UnHffmanPatchDecode`）；
∈ `0x08000000..0x0A000000` → Huffman。详见 §3.9。

**验证方法**：① 解角色 ID 1 的名字，不是正常角色名 → 文本层有问题，别继续往下做。
② 统计「非空名字 / 可玩角色数」，原版接近 100%；只有一半左右就先怀疑这条分支。

> 另外 `PatchUtil.SearchPriorityCode()` 还会检测 UTF-8 补丁（`PriorityCode = UTF8`），
> 这种 ROM 需要走 `U.AppendUTF8` 分支。目前 CLI 只实现了 LAT1 路径。

### 4.4 支援表没有固定条数、也不按 ID 排序

必须走「角色记录 `+44` → 支援指针」这条路。不要假设表是连续的、也不要假设第 *n* 条属于角色 *n*。
（`SupportUnitForm` 的判定还考虑「飞地」，遍历整张表要小心。）

### 4.5 角色 ID 从 1 开始，职业 ID 从 0 开始

- 角色：ID `n` → 表偏移 `(n-1) * 52`
- 职业：ID `n` → 表偏移 `n * 84`

写代码时最容易在这里差一位。

### 4.6 支援关系是双向冗余存储

A→B 和 B→A 是两条独立记录。分析「支援关系图」时要**去重**，否则每条边会算两次。

### 4.7 `config/data` 在 `bin/Debug` 下，不在源码树的 `config/`

源码树里的 `FEBuilderGBA/FEBuilderGBA/config/` **确实不存在**，但
`FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/` 一直在（422 个文件）—— 详见 §1.1。

**早期版本在这里下过错误结论**（「仓库里没有这些文件」），白扔了一整轮功能。
**教训**：断言「某数据不可得」之前，先 `find . -name '<文件名>'` 或
`ls FEBuilderGBA/FEBuilderGBA/bin/Debug`，不要只看源码目录。

⚠️ **不要直接去读它** —— 那会把 CLI 和 C# 仓库耦合。CLI 只读自己 vendored 的 `cli/data/`
（27 个文件的子集），读取逻辑在 `cli/src/config/data.ts`。

### 4.8 未标注字段不要臆测

`docs/` 里标「（未标注）」的字段，是 C# 侧标签文本就是 `??` 或没有对应标签的。
**不要猜它们的含义**，需要时先跑参考程序看它怎么显示。

### 4.9 不要「读满」定长表 —— 表尾后面是别的东西

定长表（职业表、支援加成表等）后面**不是空白填充**，而是链接器紧接着塞进去的其他数据。

危害不在于「多读了几条」，而在于**它静默污染映射表**：如果你用「职业 ID → 名字」建 Map，
后读到的垃圾记录会**覆盖**掉前面的正确名字。症状是某个职业的晋升目标突然变成 `"--"` 或
`"Gunnels"`，而所有记录看上去都「有名字」，非常难定位。

**正确做法**：照抄 `ClassForm.Init()` 的读入判定（§3.4）—— index 0 恒保留，
之后遇到 `u8(addr+4) == 0` 立即停。不要自作聪明地「多读一点更保险」。

**自检**：打印 `id === index` 成立的记录数。明显小于总记录数 → 读过头了，或表基址不对。

### 4.10 定长表 vs 扫终止符，两张表的规则不一样

| 表 | 读入规则 | 出处 |
|---|---|---|
| 角色表 | **固定条数** `i < unit_maxcount` | `UnitForm.Init()` |
| 职业表 | **扫终止符** `u8(addr+4) != 0`，index 0 例外 | `ClassForm.Init()` |

不要「统一处理」。想当然地把角色表也改成扫终止符，会在第一个 `ID == 0` 的空槽处提前截断；
反过来把职业表读满，就是 §4.9 的坑。**每张表都去读它自己的 `Init()`。**

### 4.11 有符号字段当无符号读 —— 能力值会静默变巨

角色表 `+12..+19`（HP/力/技/速/防/魔防/幸/体格）是**相对职业基础值的有符号增量**（§3.3.1）。
用 `u8()` 读的后果不是报错，而是**看起来合理的大数值**：`0xFF` 变成 255、`0xFE` 变成 254，
于是「体格 −2」显示成「体格 254」，一个负调整的角色突然变成全队体格最高。

**症状**：某个角色某一项高得离谱（≥128），而其他项正常。
**判据**：任何 > 127 的基础能力值都应先怀疑是负数。
**对策**：`rom.i8()`，并且永远用 `职业基础值 + 增量` 作为「初始能力」对外输出。

同样的陷阱也存在于**任何**标着「初期値」/「増減値」/「補正」的字段 —— 先确认符号性，再决定 `i8`/`u8`。

### 4.12 「参考代码里没有这段计算」≠「数据不在 ROM 里」⭐⭐

**这条已经让本项目白扔过三轮工作。**

FEBuilderGBA 是**编辑器**：它的职责是把 ROM 里的表显示出来让你改。
它**不需要**算战斗结果，所以「没有任何加成/伤害/命中算术」是它的正常状态。
于是「我在 C# 里搜不到 X 的计算公式」**完全不能推出**「X 的数据不在 ROM 里」。

| 错误结论 | 真相 |
|---|---|
| 「出场时间拿不到」（理由是 `.../config` 不存在） | 数据在 `.../bin/Debug/config/data/`，链路在 `MapSettingForm` / `EventCondForm` / `EventScript`（§3.11） |
| 「地形名拿不到」 | `MapTerrainNameForm.cs` 就在读它（§3.12） |
| 「支援 C/B/A 门槛拿不到」 | 门槛写在 `SupportUnitForm.Designer.cs:460` 的 `EXPLAIN.Text` 里（§3.5.1） |
| 「相性加成表被改过 / 和公版对不上」 | 表没被改；存的是**半点值**，游戏最后 `>>1`（§3.7.1、§3.10.1(3)） |

**第四个错法更隐蔽**：数据读对了，但**误解了量纲**，于是把「值不符合预期」当成了「ROM 数据有问题」。
所以还要加一条并列的规则：

> **「值看起来是脏数据」时，先怀疑自己漏了一层变换（×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量），
> 别先怀疑 ROM。** 这一条和上一条一样贵 —— 三次里有一次是它。

**正确的排查顺序**：

1. 这张表有没有一个 `XxxForm`？（`grep -l "<关键词>" *.cs` 找 Form 文件）
2. 有的话读它的 `Init()`（指针槽/步长/终止条件）**和 `.Designer.cs`**
   —— `EXPLAIN.Text` / `AccessibleDescription` / Label 文本里常藏着门槛、枚举、单位、注意事项。
3. **值不对时，去反汇编 ROM 自己的代码**（§3.13）：
   `grep -i <关键词> FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt` 找函数名 → 反汇编 → 读寄存器流。
   ROM 里的代码是**终审法官**，比任何外部资料和任何推理都硬。
4. 只有 1–3 都空手而归，才可以说「参考代码里没有」。
5. 即便那时也要分清：**「参考代码没有」和「ROM 里没有」是两回事。**

**症状**：你正准备写「拿不到」「不可得」「无法确定」「和公版不一致」——
先停下来重跑上面 1–4 步。**这四个词每一个都值得先反汇编一次。**

### 4.13 部署槽位不是「空的」，是模板填的 —— 数条数，别数名字 ⭐

初始配置块里**每一个未使用的出击位都有一条记录**，用的是同一个 `unitId` 配一个当章的 `classId`。
本 ROM 683 条记录里 534 条是这种填充（C11A 就是 `unit 2 / class 9` ×12）。

**后果**：`placements.length` 是**出击位数**（正确）；按 `unitId` 去重会得到「这一章只有 2 个角色」（错误）。
参考程序自己的 `deriveJoins` 也得靠「`classId == 0 || classId == 自己职业`」把模板滤掉
（§3.11.5），否则 534 条模板会把 ID→加入章节 的映射全污染。

### 4.14 和运行时比较的字段，静态永远判不了 —— 要如实说明，不要二选一 ⭐

强制出击表的 `route` 字节（`+2`）比的是 `ChapterData + 0x1B`，**那是 RAM 里的值**。
本 ROM 28 条记录里 12 条写着 `0x01`，而它们指向的地图横跨分线前 / A 线 / B 线 / 合流后 ——
两种解释都成立（字节惰性 / 那些记录根本不生效），**静态数据无法分辨**。

**正确做法**：不过滤、原样输出 `routeFilter`，在 `limitations` 里写清楚，
在报告里给出「两种读法下结论差多少」（本例：每章最多差 2 个必上单位）。
**错误做法**：挑一个读法当事实写下去，或者干脆把这个字段丢掉。


---

## 5. CLI 工程约定 → 已移到 [`docs/cli-conventions.md`](docs/cli-conventions.md)

技术选型（TypeScript + Node，零运行时依赖，无需构建步骤）、实际目录结构、命令一览、
编码约定、输出格式，全部在那里。

## 6. 验证策略 → 已移到 [`docs/cli-conventions.md`](docs/cli-conventions.md)

自洽性检查清单 / 交叉验证 / 判据分级（什么算 error、什么只能算 warn）。


---

## 7. 权威来源索引

按「想查什么 → 读哪个 C# 文件」整理：

| 想查什么 | 读这个文件 |
|---|---|
| ROM 里所有表的指针/大小 | `FEBuilderGBA/FEBuilderGBA/ROMFE7U.cs`、`ROMFE7JP.cs`、`ROMFE8U.cs`、`ROMFE8JP.cs`、`ROMFE6JP.cs` |
| ROM 版本识别 | `FEBuilderGBA/FEBuilderGBA/Rom.cs` → `LoadLow()` |
| 角色表结构 | `FEBuilderGBA/FEBuilderGBA/UnitFE7Form.cs` + `UnitFE7Form.designer.cs` |
| 角色通用查询（名字、ID 反查） | `FEBuilderGBA/FEBuilderGBA/UnitForm.cs` |
| 职业表结构 | `FEBuilderGBA/FEBuilderGBA/ClassForm.cs` + `ClassForm.designer.cs` |
| **职业特性位 → 位名** | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs` → `GetInfoByBitFlag()` (7453) + `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/unitclass_checkbox_*.txt`（§3.4.1） |
| 支援关系表 | `FEBuilderGBA/FEBuilderGBA/SupportUnitForm.cs` |
| **支援 C/B/A 门槛（81/161/241）** | `FEBuilderGBA/FEBuilderGBA/SupportUnitForm.Designer.cs:460` → `EXPLAIN.Text`（§3.5.1） |
| **支援对话解锁点数（80/160/240）** | **反汇编** `GetUnitSupportBonuses` / `UnitGainSupportExp`（§3.13） |
| **相性加成如何随等级放大** | **反汇编** `StoreAddedAffinityBonusesForSupportLevel`（§3.7.2 / §3.13） |
| **支援距离 / 单人 5 级上限** | **反汇编** `GetUnitSupportBonuses` / `CanUnitSupportNow`（§3.5.1） |
| 支援会话表 | `FEBuilderGBA/FEBuilderGBA/SupportTalkFE7Form.cs` |
| 支援相性加成表 | `FEBuilderGBA/FEBuilderGBA/SupportAttributeForm.cs`（**只有读写，没有等级换算**） |
| 相性名称（炎雷風氷闇光理） | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs:7006` → `GetAttributeName()`；**也可从 ROM 文本表解出**（文本 id 见 §3.7） |
| **地形名表** | `FEBuilderGBA/FEBuilderGBA/MapTerrainNameForm.cs` + `MapTerrainNameEngForm.cs`（§3.12） |
| **文本控制码清理** | `FEBuilderGBA/FEBuilderGBA/TextForm.cs:1262` → `StripAllCode()`（单位名也要过，见 §3.12） |
| 文本解码（Huffman） | `FEBuilderGBA/FEBuilderGBA/FETextDecode.cs` |
| **原版函数符号表** | `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt`（`.en` / `.zh` 变体）（§3.13） |
| **FE8 反编译（字段名/常量的第二意见）** | `FireEmblemUniverse/fireemblem8u` → `include/bmreliance.h` + `src/bmreliance.c`（§3.13.2） |
| **地图设置表 / 终止判定** | `FEBuilderGBA/FEBuilderGBA/MapSettingForm.cs` → `IsMapSettingEnd()` (64)（§3.11.2） |
| **章节条件表 → 初始配置块** | `FEBuilderGBA/FEBuilderGBA/EventCondForm.cs` → `MakeUnitPointer()` (1564) / `MakeUnitPointerEventScan()` (1743)（§3.11.3） |
| **事件脚本反汇编器** | `FEBuilderGBA/FEBuilderGBA/EventScript.cs` → `DisAseemble()` + `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/event_*.txt`（§3.11.4） |
| **强制出击表** | `FEBuilderGBA/FEBuilderGBA/EventForceSortieForm.cs`（只暴露 2 个字段）+ `ROMFE8U.cs:95` + 反汇编 `IsCharacterForceDeployed_`（§3.14） |
| **搜索型指针槽的解析** | `FEBuilderGBA/FEBuilderGBA/U.cs` → `FindROMPointer()` 三个重载（7644 / 7667 / 7705）（§2.2 / §3.11.2） |
| 指针/偏移工具函数 | `FEBuilderGBA/FEBuilderGBA/U.cs` → `toOffset` / `isPointer` / `isSafetyOffset` |
| ROM 读写原语 | `FEBuilderGBA/FEBuilderGBA/Rom.cs` → `u8/u16/u32/p32/p32p` |
| `InputFormRef` 参数含义 | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs` → `Init()` (5792)、`GetDataSize()` (5037)、`IDToAddr()` (5561) |
| 控件名 → 偏移的约定 | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs` → `GetDataSize()` |

**通用挖法**（拿到新表时）：找到对应 `XxxForm.cs` 的 `Init()` → 读出指针槽/大小/条数 → 打开 `XxxForm.designer.cs`，用 §2.4 的两条 grep 还原字段偏移和名称。

---

---

## 8. 附录：参考程序的构建与运行 → 已移到 [`docs/reference-build.md`](docs/reference-build.md)

项目概况（.NET Framework 4.0 / 仅 Windows / 无 NuGet）、`msbuild` 命令、
运行所需的两样外部资源（`config/` 树 + `7-zip32.dll`，**仓库里已经有了**）、
`--testonly` 自测、常用命令行参数。


---

## 9. 快速参考

```bash
# 仓库结构
FEBuilderGBA/            ← git submodule：只读参考（C#，仅 Windows）
└── FEBuilderGBA/        ← C# 源码 + bin/Debug（config/data 在这里）
cli/                     ← 我们的 CLI（TypeScript/Node，跨平台）
mgba/                    ← mGBA Lua 凹点助手（见 §3.15 / §3.17）
docs/                    ← AGENTS.md 拆出去的深度内容

# 挖一个表的结构（CWD = C# 源码目录）
cd FEBuilderGBA/FEBuilderGBA
grep -oE "this\.[A-Za-z_0-9]+ = new (System\.Windows\.Forms\.)?(NumericUpDown|TextBoxEx|ComboBoxEx|CheckBoxEx|ListBoxEx)" <Form>.designer.cs \
  | sed 's/this\.//' | awk '{print $1}' | sort -u          # 控件名 = 类型字母 + 字节偏移
grep -nE 'this\.[A-Za-z_0-9]+\.Text = "' <Form>.designer.cs  # 标签文本 = 字段名

# 找一张表的定义（读入规则也在这里，见 §4.10）
grep -n "static InputFormRef Init" <Form>.cs
grep -n "EXPLAIN.Text\|AccessibleDescription" <Form>.Designer.cs   # 门槛/说明常写在 Designer 里

# ⭐ 参考代码答不上来时：反汇编 ROM 自己的代码（§3.13）
grep -i <关键词> FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt   # 原版函数符号表
uv run --with capstone python \
  .workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py \
  fixtures/dream-of-five.gba 0x28550 0x285B0

# ⭐⭐ 找地址的捷径：patch2 里的 #ENGINE 补丁常直接写出「要改哪条指令」（§3.18）
ls FEBuilderGBA/FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/          # 引擎级补丁
grep -n "ADDRESS\|DETERMINATION_ADDRESS\|^OFF\|^FIX" \
  FEBuilderGBA/FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/<补丁>.txt
# 例：PATCH_Eliminate attack speed penalty.txt → 0x02AB92，OFF=40 1A（subs r0,r0,r1）
#     → 反汇编 0x2AB74 就是 BattleLoadAS（攻速公式），见 §3.18

# 跑我们的 CLI（CWD = 仓库根）
cd cli && node src/index.ts validate ../fixtures/dream-of-five.gba
cd cli && node src/index.ts roles    ../fixtures/dream-of-five.gba --playable-only
cd cli && node src/index.ts supports ../fixtures/dream-of-five.gba
cd cli && node src/index.ts terrain  ../fixtures/dream-of-five.gba
cd cli && node src/index.ts chapters ../fixtures/dream-of-five.gba
cd cli && node src/index.ts text     ../fixtures/dream-of-five.gba --range 0x214-0x218
cd cli && node scripts/unit-placement-census.ts --chapter 22   # 敌人/友军配置普查（§3.19.6）
cd cli && node src/index.ts enemy-stats ../fixtures/dream-of-five.gba --compact \
  --out out/dream-of-five.enemy-stats.json                     # 敌攻速逐阶段分布（§3.20）
cd cli && ./node_modules/.bin/tsc --noEmit

# mgba 凹点助手（见 §3.15 升级抽点 / §3.17 战斗掷骰）
node cli/scripts/emit-mgba-units.ts            # 重新生成 mgba/units.lua（从 cli/out/*.units.json）
node mgba/test/run.mjs                         # 自测（fengari 假内存，124 项；找不到 fengari 时设 MGBA_TEST_WORKSPACE）
node mgba/test/run.mjs --preview               # 顺带打印面板快照
python3 mgba/test/battle_golden.py             # 战斗模型黄金值（改战斗模型后先跑这个；纯 stdlib）
# 实机：mGBA → Tools → Scripting → Open → mgba/fe-aodian.lua（无命令行载入）

# config/data：CLI 读 vendored 副本；上游源头在 submodule 里（见 §1.1 / §4.7）
ls cli/data/                                                  # 我们读的（27 个文件）
ls FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/ | head     # 上游源头（422 个文件，刷新用）
```

> ⚠️ **macOS 自带的是 BSD grep，不支持 `\|` 交替。** `grep -n "A\|B" file` 会**静默返回空**，
> 看起来像「文件里没有」—— 这个坑骗过我两次。用 `grep -E "A|B"`，或直接用检索工具。
> 同理**全仓扫 `.cs` 会被 OOM kill（exit 137）** —— 改用 Python 遍历。

### 最容易「编数据」的地方（不是 bug，是认知陷阱）

- ~~出场时间 / 加入章节拿不到~~ —— **错，已实现**（§3.11）。别再手工编加入顺序。
- ~~「骑马 / 重甲」分不开~~ —— **错，特性位能分开**（§3.4.1）。
- ~~地形名拿不到~~ —— **错，`map_terrain_name_pointer` 就是它**（§3.12），65 条。
- ~~支援 C/B/A 换算拿不到~~ —— **错，门槛写在 `SupportUnitForm.Designer.cs:460`，缩放算术在 ROM 的代码里**（§3.5.1 / §3.7.2）。
- ~~相性表「被改过 / 和公版对不上」~~ —— **错，表是未改动的公版，只是存的是半点值**（§3.7.1 / §3.10.1(3)）。
- **移动消耗表是 65 项不是 64** —— 少读一列会静默丢掉地形 `0x40`（"Mast"）（§3.4）。
- **角色表里的能力值是「相对职业基础值的有符号增量」，不是初始能力** —— 必须加上职业基础值
  才能得到游戏显示的值，而且要用 `i8` 读（§3.3.1 / §4.11）。增量为 0 是最常见的值，不是缺数据。
- **地图设置表索引不是章号** —— 79 条记录里只有约 30 张是单周目能打到的剧情图（§3.11.2.1）。
- **单位名要过 `displayName`（剥 `@XXXX`）** —— 本 ROM 有 17 个名字尾部带 `@001F`（§3.12）。
- **不要暴力扫字节找 unitId** —— 2,186,116 个候选，纯噪声（§3.10 反面教材）。
- **`40050200....` 是增援分派，不是招募** —— 靠 `0x2C` opcode 过滤（§3.11.4）。
- **部署槽位是模板填的，别按名字去重** —— 本 ROM 683 条配置记录里 534 条是填充。
  **数条数**才是出击位数（§3.14.1 / §4.13）。
- **强制出击表的 `route` 字节静态判不了** —— 它比的是 RAM 里的 `ChapterData+0x1B`。
  **如实输出 + 说明影响**，不要二选一当事实写下去（§3.14.3 / §4.14）。

> 三条主链路（加载 / 出场加入 / 敌人摆放 / 编队必上 / 敌人属性→攻速）的**完整流程图**
> 在 [`docs/README.md`](docs/README.md)。

