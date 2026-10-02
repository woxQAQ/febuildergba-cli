---
name: febuildergba-rom-extraction
description: 从 FEBuilderGBA 的 C# 源码里挖出 GBA 火焰纹章 ROM 的数据结构（指针表、记录布局、字段偏移），用于写自己的解析 CLI。当任务是「解析 FE7/FE8/FE6 ROM」「提取角色/职业/支援/道具数据」「这个表在 ROM 里什么结构」「FEBuilderGBA 里怎么读 XX」「继续做 fecli / cli 的某个表」「某个数值/公式参考代码里找不到」时使用。含「参考代码答不上来时反汇编 ROM 自己的代码」的完整方法（符号表 + capstone）。
description_zh: "从 FEBuilderGBA 参考源码挖 ROM 数据结构（含反汇编 ROM 自身代码）"
description_en: "Extract GBA Fire Emblem ROM structures from FEBuilderGBA source, incl. disassembling the ROM itself"
agent_created: true
---

# 从 FEBuilderGBA 源码挖 ROM 数据结构

## 0. 定位

`FEBuilderGBA/FEBuilderGBA/`（仓库根下 `FEBuilderGBA/` 这个 **git submodule** 之内）
是一个 C# WinForms 的 GBA 火纹 ROM 编辑器。
**它不是要开发的项目，是只读参考资料** —— 它把 ROM 的内存布局、指针表、结构体全部硬编码了，
这就是权威规格。**绝对不要修改 submodule 下的 C# 代码。**

产出物是仓库根 `cli/` 下的 **TypeScript + Node CLI**（零运行时依赖，只用 `Buffer`）。

> **路径基准**：仓库根 = 本项目根目录。C# 源码目录 = `FEBuilderGBA/FEBuilderGBA/`。
> 名字重复两层不是笔误 —— 2026-10-01 之前的旧文档里「`FEBuilderGBA/` 后面紧接 `bin/Debug`
> 或某个 `.cs` 文件名」都少了一层，见到就自己补。
> **下面所有命令块里的相对路径，CWD 一律是仓库根。**

> **本 skill 是项目级的。** 真身在 `<仓库根>/.workbuddy-ai/skills/febuildergba-rom-extraction/`
> （harness 约定目录 `.workbuddy/skills/` 下有一条 symlink 指回来）。
> **改文件一律改真身，别在两处各改一遍。不要复制到全局 `~/.workbuddy-ai/skills/`。**

**动手前先读两份**：

| 读什么 | 去哪 |
|---|---|
| 项目约定、路径基准、**§0.2 判据速查（18 条一句话）** | `AGENTS.md`（每会话自动注入） |
| **全部结论**：数据字典（`§3.x`）、陷阱全文（`§4`）、权威来源索引（`§7`） | `docs/`，入口 `docs/README.md` |

**本 skill 只讲「怎么挖」。已经挖出来的结论全在 `docs/`，不在这里重复** ——
查结论按 `docs/README.md` 的章节速查找文件，需要证据级细节（地址 / 偏移 / 反汇编片段）看那里。

## 1. 六条机制（挖表时必须先知道的边界）

> 这六条是「不读就会静默出错」的机制。**每条的具体案例与证据在 `docs/` 对应章节**，
> 这里只留「机制是什么、怎么应用」。

### 1.1 `RomInfo.*_pointer` 是「指针槽」的偏移，不是表地址

```
表 file offset = p32(RomInfo.xxx_pointer)
p32(a) = u32(a)，若值在 [0x08000000, 0x0A000000) 则减 0x08000000
p32p(a) = p32(p32(a))     // 二级指针
```

例外：以 `_address` 结尾的字段（`max_level_address`、`text_recover_address`）是**直接偏移**，不要解引用。

**槽位可以落在代码段里**（相性加成表的槽就是函数字面量池中的那个字，见 `docs/disassembly.md` §3.13），
所以「槽位偏移」和「表偏移」之间**没有任何地址上的规律**，只能靠反汇编确认。

证据：`PatchForm.cs:9372 ReplacePointerSub()` 把 `u32(RomInfo.item_pointer)` 当原始 GBA 指针用；
`InputFormRef.cs:5792 Init()` 里 `BaseAddress = p32(BasePointer)`。
方法论见 `docs/methodology.md` §2.2。

### 1.2 字段偏移藏在 WinForms 控件名里

控件命名 = **`<类型字母><字节偏移>`**。前缀 → 字节数来自 `InputFormRef.GetTypeLength(char c)`
（`InputFormRef.cs:5033`）：`B`/`b`/`l`/`h`=1、`W`=2、`D`/`P`=4。
控件旁 Label 的 `Text` 就是字段名（日文）。

**另一条更省事的路径**：很多控件带 `AccessibleDescription = "@XXXX"` ——
去 `InputFormRef.cs` 搜这个串，能直接读到参考程序对这个字段的**完整说明文字**
（常包含符号性、取值范围、特殊语义）。**比读控件名猜字段含义快得多，优先用。**
配套 grep 见 `docs/methodology.md` §2.4。

**别只看 `Form.cs`** —— 门槛值、章号语义这类说明常写在 `Designer.cs` 的
`EXPLAIN.Text` / `AccessibleDescription` 里，不在 `.cs` 正文。

### 1.2.1 「初期値 / 増減値 / 補正」类字段先确认符号性

**这是「看起来对、实际全错」的典型。** 看到 `@UNITBASE`（角色表能力）/ `@CLASS_BASE`（职业表能力）
这类说明文字时，**第一件事是确认它是不是增量、是不是有符号**。机制与实测见
`docs/rom-layout.md` §3.3.1 / `docs/traps.md` §4.11。

一句话判据：**TS 用 `rom.i8()`；症状是某项数值 ≥128 而其他项正常 —— 先怀疑负数。**

### 1.3 文本表条目有「两种存储格式」

拿到 `text_base + id*4` 的 4 字节后，**先分类再解码**（`FETextDecode.cs:73 DecodeAddr`）：
条目值 `0x88xxxxxx` = **未压缩**（反 Huffman 补丁）/ `0x08xxxxxx` = Huffman / 其他 = 无效。

未压缩指针 = 正常指针 `+ 0x80000000`，减回去就是普通 GBA 指针。
**一个 hack 里两种格式常常混用** —— 只实现 Huffman，症状是「一部分名字正常、一部分莫名是空串」，
而那些空名字的记录**其他字段全都正常**，极易误判成「文本表有洞」。

两个解码函数的完整实现（不要按描述重写，边界条件太多）与字节游走规则见 `docs/supports-and-text.md` §3.9。

### 1.4 数据在 `bin/Debug/config/data` —— 别急着划「拿不到」的边界

> **下「某数据不可得」的结论之前，先 `find . -name '<文件名>'` 或
> `ls FEBuilderGBA/FEBuilderGBA/bin/Debug`。** 曾经因为「`config/` 目录不存在」
> 断言「出场时间拿不到」，白扔一整轮 —— 那个理由本身就是错的。

`U.ConfigDataFilename()`（`U.cs:3180`）拼的是
`Path.Combine(BaseDirectory, "config", "data", type + TitleToFilename + "." + lang + ".txt")`，
而 `BaseDirectory` 是**可执行文件所在目录**：

```
FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/     ← 上游源头，422 个文件（且被 git 跟踪）
FEBuilderGBA/FEBuilderGBA/config/data/               ← 不存在，别再找这里
cli/data/                                            ← 我们 vendored 的副本，27 个文件
```

**不要直接读上游那份** —— 那会把 CLI 和 C# 仓库耦合，单独 clone `cli/` 就跑不起来。
把用到的**最小子集复制进 `cli/data/`**（3 前缀 × 3 游戏 × 3 语言 = 27 文件），只读副本。
读取逻辑见 `cli/src/config/data.ts`；搜索路径 `$FEBUILDERGBA_CONFIG` → `cli/data/`。
已 vendored 的是 `unitclass_checkbox_*`（职业特性位名，key 是**十六进制**）、
`event_*`（事件 opcode 表）、`eventcond_*`（20 个章节条件槽）。

`7-zip32.dll` 同样在 `bin/Debug/` —— 运行参考程序不需要额外补任何东西。

**特性位怎么读**（`InputFormRef.GetInfoByBitFlag`，`InputFormRef.cs:7453`）：

```
byteIndex = key >> 4          // 高半字节 = 第几个字节
bit       = (key & 0xF) - 1// 低半字节 = 第几位（1-based）
mask      = 1 << bit
```

**key 是十六进制，`13` 不是十进制 13** —— 搞错会把 Thief/Bard 读成飞行单位。
各 bit 的语义与机动性判据见 `docs/rom-layout.md` §3.4.1。

### 1.5 地图设置表的索引**不是**章号

表**每张地图 id 一行**，所以它同时计入未使用槽位、世界地图/遭遇图、bonus/调试图。
**不要**把表索引当成「第几章」报给人类 —— 会报出「第 60 章」这种不存在的东西。
判空槽要看**标题**是否为空（序章章号也是 0，与未使用槽位同值）。

字段表（`+0x70` = 标题、`+0x80` = 章号 ×2）、为什么 ×2、以及 hack 改写记录 `+0` 导致的两个
有意偏差（记录条数退化为结构扫描、职业覆盖靠 `classId` 归因）见 `docs/chapters-and-events.md` §3.11.2。

**不要暴力扫表找出场**（在 ROM 里搜 `u8 == unitId`）：角色 ID `1..255` 全部合法、记录只有 20 字节，
实测 **2,186,116** 个候选 —— 纯噪声。**走指针链路，别扫字节。**

**`40050200....` 是增援分派，不是招募**（同样携带 `POINTER_UNIT`）。靠 `0x2C` opcode +
前导字节（`0x40`=recruit / `0x41`=load / `0x42`=cutscene）过滤。

### 1.6 参考代码答不上来时：反汇编 ROM 自己的代码

**这一节是本 skill 里最有力的一节。** 它解决的是前几节都解决不了的一类问题。

#### 1.6.1 为什么要做，什么时候做

`FEBuilderGBA`是**编辑器**，不是模拟器 —— 它只需要把 ROM 里的表显示出来让你改，
**从来不需要算战斗结果**。所以「C# 里搜不到某个公式」是它的**正常状态**，
**完全不能推出「这个数据不在 ROM 里」**。

这个思维定式已经让本项目白扔过三轮工作（`docs/disassembly.md` §3.10 列了四个被推翻的结论）。
**两条教训要分开记：**

- **「参考代码里没有这段计算」≠「数据不在 ROM 里」。** 正确的问法是
  「这个字段**有没有一个 `Form` 在读它**」，而不是「有没有一段代码在用它」。
- **「值看起来像脏数据」时，先怀疑自己漏了一层变换**（×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量），
  **别先怀疑 ROM。**

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
**同一个函数常有 `{U}`/`{J}` 两份地址，选一个并全程一致，别把两版混着用。**

**② 反汇编器。** 需要解 Thumb。LLVM 的 `objdump` **不支持裸二进制**
（`-b binary` 是 GNU 专属参数），所以用 Python 的 `capstone`。任一 Python 3 解释器都行。

**反汇编脚本已随本 skill 提供**：`scripts/disasm.py`

```bash
# CWD = 仓库根
uv run --with capstone python \
  .workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py \
  <rom.gba> <startOffset> <endOffset> [baseAddress]

# 例：支援加成的算术
uv run --with capstone python \
  .workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py \
  fixtures/dream-of-five.gba 0x2852C 0x285B0
```

**工作流**：`grep -i <关键词> asmmap_FE8.txt` 找符号 → 从符号表读出地址 →
反汇编「该地址到下个符号」→ 读寄存器流。
**不要试图反汇编整个 ROM**，按符号切是最省力的。

> 符号表地址是 **GBA 地址**（`0x08xxxxxx`），文件偏移 = 地址 − `0x08000000`。
> 脚本接受的是**文件偏移**（base 默认 `0x08000000 + start`）。

**③ 找地址的最快路径：`patch2/` 里的 `#ENGINE` 补丁直接写出「要改哪条指令」。**

比 `grep asmmap` 更快，而且**不需要先知道函数名** —— 引擎级补丁是「改 ROM 里某几条指令」的开关，
补丁文件里必然带地址和原始字节：

```bash
ls FEBuilderGBA/FEBuilderGBA/bin/Debug/config/patch2/FE8U/            # SYSTEM/ skill*/ stairs/ ...
grep -nE "ADDRESS|DETERMINATION_ADDRESS|^OFF|^FIX|^COMBO" \
  FEBuilderGBA/FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/<补丁>.txt
```

| 字段 | 含义 |
|---|---|
| `ADDRESS=` / `DETERMINATION_ADDRESS=` | **文件偏移**（不是 GBA 地址，别再 −0x08000000） |
| `OFF:` / `FIX:` | **改前 / 改后的原始字节**（`0x…=AA BB …`） |
| `CONFLICT_IF` | 冲突时该处应有的字节 —— 反过来也能当「这是不是原版布局」的探针 |

**关键动作：拿 `OFF:` 的字节去 ROM 对应偏移核对。一致 = 这条指令还在原地 = 补丁标的地址有效。**
（hack 改了这段代码的话字节就不一致，此时符号表也会失效。）

> **补丁文件名是自然语言，往往比 `asmmap` 更好用。** 例：「攻速」「追击」这两个词在
> `asmmap` 里根本搜不到（函数名是英文缩写 `AS`），但补丁文件名一眼就命中。
> **顺序：先 `ls patch2/`，再 `grep asmmap`。**

#### 1.6.2.1 看到 `bl <addr>` 必须去 `asmmap` 查那个地址 —— 不能凭形状猜

**这是本 skill 里最容易犯、代价最大的一个错。** `bl` 的目标可能是算术 helper，
也可能是**随机数**；两者在反汇编里长得一模一样，而结论是**相反的**。

```
0802B9D4  bl       #0x8000c80       ; 看起来像除法 helper
```

`grep` 一下 `asmmap_FE8.txt` 就知道 `0x08000C80` 其实是 `NextRN_N` ——
结论从「闭式算术、不烧随机数、量完全确定」**翻转**成「基准值 + ±1 随机成分」。
（这个错误结论当时已经写进了报告和 `AGENTS.md`，是查符号表时自己抓回来的。）

**规则**：

1. 反汇编窗口里**每一个 `bl` / `b` 的目标地址都查一遍**
   （`grep -i '^08000c80' asmmap_FE8.txt`，或把 `asmmap` 按地址排序后看区间）。
2. **FE8U 的 `0x08000C0C`–`0x08000CC0` 是 RNG 函数族**（`NextRN_100` / `NextRN_N` /
   `Roll1RN` / `Roll2RN`）—— 见到 `bl` 落在这个区间，立刻停下来想「随机成分有多大」。
3. 说「这个量是确定的」之前，先确认调用链上**没有任何 `bl` 落进 RNG 区**。
   确定 vs 带随机是**相反的两个结论**，猜错等于整个分析的性质变了。

> **烧了随机数就必须输出区间，不要挑一个数装作是实测值。**

#### 1.6.3 已挖到的成果去哪了

反汇编这条链路已经走通过 several 轮，成果**全部在 `docs/`，本 skill 不重复**：

| 挖到了什么 | 去哪读 |
|---|---|
| 支援系统的全部算术（表步长 / 门槛 / 距离 / 加成） | `docs/disassembly.md` §3.13.1 |
| 门槛 81/161/241 与「解锁对话」的 80/160/240 差1 | `docs/supports-and-text.md` §3.5.1 |
| 相性加成表存**半点值** + 完整公式（`>>1` 只做一次，作用在总和上） | `docs/supports-and-text.md` §3.7 |
| FE8 反编译源码是第二意见（要字段名时查 `bmreliance.h`） | `docs/disassembly.md` §3.13.2 |
| 攻速 `= 速度 − max(0, 重量 − 体格)`、追击阈值 | `docs/battle-math.md` §3.18 |
| **FE8 没有「敌人表」** —— 敌人和自军共用同一种记录 | `docs/chapters-and-events.md` §3.19 |
| 敌人属性 → 攻速投影（四项来源 + 自动升级区间算法） | `docs/battle-math.md` §3.20 |

**反汇编方法本身在 `docs/disassembly.md` §3.13**（含 capstone 片段与工作流），配套工具还有
`scripts/find_calls.py`。

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

**以游戏代码为准，不要信 ROM 里的标题字段** —— 本仓库的 `fixtures/dream-of-five.gba`
游戏代码是 `BE8E01`（FE8U），标题字段却被改成了 `FIREEMBLEM2E`（FE7U 的标题）。

### 步骤 2 — 找表的位置和大小

读对应的 `ROMFEXX.cs`，找 `xxx_pointer` / `xxx_datasize` / `xxx_maxcount`。

**有些 `xxx_pointer` 不是固定常量，而是「搜索型」槽位**（FE8 的角色表/职业表/地图设置表
在修订版之间挪过位置）。`ROMFE8U.cs` 给的是一个**候选列表**，由 `U.FindROMPointer`挑出第一个
满足条件的槽。它**有三个重载**（`U.cs:7644 / 7667 / 7705`），判据不同：

```
重载 A（2 参）：槽是安全偏移 + 槽里的值是安全 GBA 指针
重载 B（checkPointer）：再加 u32(tableOffset + checkPointer) 也是安全指针
重载 C（Func<uint,bool>）：再加 func(tableOffset) 为真
```

- 角色表用 B，`checkPointer = 0x2C`（每个角色都有的支援指针）
- 职业表用 B，`checkPointer = 0x88`
- **地图设置表用 C**，判据见 `docs/chapters-and-events.md` §3.11.2
  （含上游的一个 lambda bug —— 按**作者本意**实现，不是按字面）

### 步骤 3 — 找表的结构体定义

1. 找到该表的编辑器 Form，例如角色表 → `UnitFE7Form.cs`。
2. 读它的 `static InputFormRef Init(Form self)`：
   - 第 3 个参数 = 指针槽偏移
   - 第 4 个参数 = **记录字节数**
   - 第 5 个参数 = **有效记录判定**（条数或终止条件）

   **第 5 个参数必须逐字照抄，两张表的规则不一样：**

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
3. 打开 `XxxForm.designer.cs`，跑 `docs/methodology.md` §2.4 的两条 grep 还原字段。

两边对齐，结构体表就出来了。若某字段只有控件没标签，就是「未标注」——**不要猜含义**。

### 步骤 4 — 处理名字（文本 ID）

ROM 里名字是 `u16` 文本 ID，链路：

```
u16(addr) → 文本 ID → text_base + id*4 → 条目值
    → 分类（§1.3）：0x88xxxxxx = 未压缩 / 0x08xxxxxx = Huffman
    → 解码 → 字节流 → Latin-1 字符串 → RevConvertSPMoji 特殊字符还原
    → displayName（剥掉尾部 @XXXX）
```

**逐行移植解码函数，不要按描述重写**（边界条件太多，照抄更快更准）。
函数清单与调用顺序见 `docs/supports-and-text.md` §3.8–§3.9。

### 步骤 5 — 验证

见 §4。**不能靠「读代码觉得对」，必须用真实 ROM 验证。**

## 3. 常用速查

```bash
# --- 挖 C# 源码 ---
FEB=./FEBuilderGBA                # C# checkout 根（CWD = 仓库根）
SRC=$FEB/FEBuilderGBA             # C# 源码目录（.cs 平铺在这里）
cd $SRC

grep -n "static InputFormRef Init" XxxForm.cs           # 找某表的定义（读入规则也在这里）
grep -nE "unit_pointer|class_pointer" ROMFE7U.cs       # 找指针槽的值
grep -rn "RomInfo.unit_pointer" --include="*.cs" .     # 某字段被谁用
grep -nE "EXPLAIN.Text|AccessibleDescription" XxxForm.Designer.cs   # 字段语义常在这里

# --- 找地址的最快路径：patch2 的 #ENGINE 补丁（§1.6.2 ③）---
ls $SRC/bin/Debug/config/patch2/FE8U/            # SYSTEM/ skill*/ stairs/ ...
grep -nE "ADDRESS|DETERMINATION_ADDRESS|^OFF|^FIX" \
  $SRC/bin/Debug/config/patch2/FE8U/SYSTEM/<补丁>.txt
# ADDRESS 是文件偏移；OFF: 是改前的原始字节 —— 拿它去 ROM 核对

# --- 参考代码答不上来时：反汇编 ROM 自己的代码（§1.6）---
grep -i <关键词> $SRC/bin/Debug/config/data/asmmap_FE8.txt    # 符号表（GBA 地址）
uv run --with capstone python \
  .workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py \
  fixtures/<rom>.gba 0x28550 0x285B0

# --- 跑已有的 CLI（CWD = 仓库根）---
cd cli
node src/index.ts validate ../fixtures/<rom>.gba    # 退出码 0 = 无 error 级失败
node src/index.ts text     ../fixtures/<rom>.gba --range 0x214-0x218  # 看每个 id 的存储格式
node src/index.ts roles    ../fixtures/<rom>.gba --playable-only       # 队伍搭配覆盖
node src/index.ts terrain  ../fixtures/<rom>.gba                       # 地形名 65 条
node src/index.ts supports ../fixtures/<rom>.gba                       # 含 C/B/A 回合数
node src/index.ts enemy-stats ../fixtures/<rom>.gba [--hard]           # 敌人属性→攻速投影
node scripts/unit-placement-census.ts [--chapter 22]  # 敌人/友军配置普查
node src/index.ts dump     ../fixtures/<rom>.gba --compact --out report.json
./node_modules/.bin/tsc --noEmit
```

> **`cli/` 命令的完整清单（14 个）见 `docs/cli-conventions.md` §5**，这里只列常用的。
> 生成产物用 `--compact`（默认美化输出，体积翻倍）。

> **这个环境里 `grep` 有两个坑，都会让人得出「文件里没有」的错误结论**：
> ① macOS 自带 BSD grep 不支持 `\|` 交替 —— `grep -n "A\|B" file` **静默返回空**，
> 用 `grep -E "A|B"`；② 某些工具链把 `grep` 别名成 ripgrep，此时 `grep -nE` 报
> `unknown encoding`。**一律用 Python 遍历或专用检索工具。**
> 同类坑：**全仓扫 `.cs` 会被 OOM kill（exit 137）**。

> **脚本自己会写文件时，不要用 shell 重定向到同一路径**：`node x.ts --route=A > out/x-A.md`
> 会先被 shell 截断，脚本写入后 stdout（`Wrote ...`）被追加 → 文件尾嵌 ASCII。
> 症状不是「中文乱码」，是 `file` 报 `data` / 出现 U+FFFD。**直接跑脚本，不要 `>`。**

`text` 命令是最有用的诊断入口 —— 它直接打印每个 id 命中的格式
（`huffman` / `unhuffman` / `direct` / `invalid`）。排查「名字读不出来」先跑它。
`--playable-only` 把范围收窄到有支援数据的单位。

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

**更全的索引在 `docs/reference-index.md`（§7）。**

## 4. 验证清单

不能靠「读代码觉得对」。必须用真实 ROM 验证。

1. **自洽性**（`cli` 的 `validate` 命令已实现，权威清单 = `cli/src/index.ts` 的 `switch`）：
   - 名字是正常文字不是乱码；**非空名字比例**接近 100%
     （若只有一半左右，**先怀疑 §1.3 的未压缩分支**）
   - ID 连续唯一；每个角色的职业 ID 都能解析到有名字的职业
   - **没有角色的「职业基础值 + 增量」`<= -1`** —— 按参考代码说明这种值会被补码成最大值
   - **报告出负增量的角色数量** —— 这是「有没有把有符号字段当无符号读」的哨兵
   - 支援关系双向对称；支援人数与实际非零相手数一致；支援指针都落在 ROM 内
   - **相性加成表恰好 7 条且 ID 依次 1..7**；**每条的第 7 字节恒为 0**
     （游戏只写/只读偏移 1–6，非零即说明步长 8 读错了）
   - **支援门槛自洽**：`C == 对话解锁上限 + 1`、`B == C + 1`、`A == B + 1`
     —— 两边算法不同，能对上才算解对
   - **`>>1` 哨兵**：任取一条相性，`atk` 在 C/B/A 应为 `0/1/1`、`critAvoid` 应为 `2/5/7`。
     这是最便宜的「有没有做半点换算」判据
   - **有移动力的**职业都有 **65** 项消耗表（移动力 0 的跳过）
   - **章节链路**：地图设置表条数 > 0；有真标题 / 未使用槽 / 遭遇图的分裂能算出来；
     **标题里的 `C<n>` 与 `+0x80/2` 逐一吻合**；初始配置块都在 `u8 == 0` 处终止
   - **敌人投影**：记录数 > 0；**每条属性的 `lo <= mean <= hi`**（区间自洽的哨兵）
2. **交叉验证**：在 Windows 上构建并运行 FEBuilderGBA，打开同一 ROM 对比显示值。
   `config/` 树和 `7-zip32.dll` **已经在 `bin/Debug/` 里**，不需要额外准备。
   构建步骤见 `docs/reference-build.md`（§8）。
3. **常识**：对照公开的 FE 角色属性数据。

> **判据分级**：只有「解析可能错了」才当 error。
> 例：成长率是 u8（上限 255），升级判定 `rand(0..99) < growth`，所以 **>100 是合法的**
> （表示必定成长），hack 常用 —— 当 warn。
>
> **另一个必踩的误报**：把「没有消耗表」当 error。移动力为 0 的静止职业本来就没有。
> 判定必须带 `movementRange > 0`。
>
> **负攻速当 warn 不当 error** —— 它是真实数据（引擎不钳零），不是解析错。

> **交叉验证的免费版**：用 `--playable-only` 前后对比。加开关后如果治疗者列表
> 从「混着 `Priest` 等模板」变成「全是正常角色名」，说明支援数据这条索引是可信的。

## 5. 已知坑 → 去 `docs/traps.md`

**不在这里维护。** 陷阱清单的唯一家在 [`docs/traps.md`](../../../docs/traps.md)（§4，每条带症状 / 证据 / 反例）。
`AGENTS.md` §0.2 有一份 18 条的一句话速查（每会话注入，按踩坑概率排序）。

**新增陷阱时只加到 `docs/traps.md`**，不要在这里再抄一份 ——
本 skill 历史上维护过一份 40 行的坑表，与 `traps.md` / `AGENTS.md` §0.2 三处重叠；
已漂移过（同一个坑三处编号都不一样），2026-10-02 删除。

## 6. 从报告产出结论的读法

> **这一节是「怎么读 `report.json`」，不是「结论是什么」。**
> 结论（分线结构、自由位、谁值得练）在 `docs/chapters-and-events.md` §3.16 的结论存档里。
> §3.16 的东西**不要重新写回 CLI** —— 边界见 `AGENTS.md` §1.2。

按这个顺序读，用 `node -e` 抽取，**别整份打印**：

1. **定可玩名单** —— 用 `availability.joinOrder`（有支援数据的角色），**不要**用 `units[]`
   （含敌人/模板/空白槽）。**务必剔除调试单位**：特征是 `supportPartnerCount === 0`
   + 成长总和离谱。用 `joinOrder[].note` 标出「LOAD2 早于 LOAD1」和「无 LOAD1」的人。
2. **读时间线** —— `joinOrder[].joinChapterNumber` + `joinChapterTitle`，
   **不要用 `joinChapter`**（那是表索引，会数进未使用槽位和遭遇图，见 §1.5）。
   标出 `joinChapterIsStory === false` 的行（加入点落在无标题沙盒图上），**这些不可信**。
3. **看初始值** —— `units[].startingStats`（= 职业基础值 + 有符号增量），
   **不要**用 `stats`（那是原始增量）。这一步决定「这个人上场能不能立刻打」。
4. **排成长** —— `units[].growthTotal` 排序，但**要同时看加入章号**：
   晚来 + 低成长 = 预备转职。**成长高 ≠ 现在强**（职业基础值低的人初始值偏弱）。
5. **查职能缺口** —— 用 `role.mobility` / `weaponLevels` / `role.hasStaff` 统计。
   稀缺职能优先级最高。舞者/诗人**不在 `role.specialAction` 里**，
   要看 `roles` 命令的 `classRoles[].specialAction`。
6. **配支援** —— `supports.edges[]` 的 `initial` 和 `growth` 都要看：
   `initial` 高 = 立刻拿得到，`growth` 高 = 快升 A。**关键过滤**：用章号只保留
   「两人都已加入」的对。`turnsToConversation`（解锁对话）与 `turnsTo`（解锁 + 对话之后）
   **差一个对话**，报的时候别混。另外 `edges[]` 里可能有**开局就已经是 C/B/A** 的对，
   这类不用规划，直接算进「现有战力」。
7. **相性搭配** —— `supportAffinities[].byRank` 给的是**真正能用的加成**（已做半点换算），
   别再自己乘。用法：把两人相性各自对**对方相性**那一行取值，再按 `pairBonus` 求和。

**输出时必须写清边界**：加入章是推导值（`joinChapterIsStory === false` 的更不可信）、
可玩名单是代理（「有支援数据」）、回合数是「相邻且不背人」的理想值、敌人属性是**区间**。
把 `report.limitations` 里的条目翻译成人话放进结论，
否则下游会把「数据没有」当成「数据是 0」。

> **不要写「有招募空窗期，所以空窗期前的人就是主力」** —— 这是**因果跳跃**，
> 曾经被用户当场驳回。空窗期**本身不决定**练谁，它唯一能支持的推理是**有限且要带条件**的：
> 「这段时间不会有新人加入 → 对已到手的队伍投入资源不会因为新人到来而立刻贬值」。
> 所以它只能当**辅助理由**，而且必须先看空窗有多长（本 ROM 最大空窗只有 1–3 章，
> 根本不够回本）。**报告里如果出现「因为有空窗期所以练他们」，删掉重写。**