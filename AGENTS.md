# AGENTS.md

给 AI 编码代理的工作指南。

---

## 0. 先读这段：这个仓库对你的意义

**这个仓库不是你要开发的项目。**

它是 **FEBuilderGBA** —— 一个成熟的 C# WinForms 工具，用来编辑 GBA 火焰纹章 ROM。它本身能跑、能改 ROM，但那不是我们关心的事。

我们关心的是：**这个仓库把 GBA 火纹 ROM 的内存布局、指针表、数据结构，全部用代码写死了。** 这些硬编码的偏移量和结构定义，就是我们要的「权威规格」。

所以：

- **`FEBuilderGBA/` 下的 C# 代码是只读参考资料。** 不要修改、不要重构、不要给它加功能、不要试图修它的 bug。
- 我们要写的 CLI 放在 **`cli/`**（本仓库根目录下的新目录，与 `FEBuilderGBA/` 平级）。
- 唯一的例外见 §8 —— 必要时可以构建并运行参考程序，用来**交叉验证**我们解析出的数据是否正确。这是很有价值的验证手段。

```
FEBuilderGBA/          ← 只读参考。C# 源码，ROM 结构的权威定义
cli/                   ← 我们写的 TypeScript/Node CLI（新增）
mgba/                  ← mGBA Lua 凹点助手（新增，见 §3.15 / §3.17）
```

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

> **`fixtures/dream-of-five.gba` 的真实身份**：游戏代码 `BE8E01`（FE8U），
> 但标题字段被改成了 `FIREEMBLEM2E`（FE7U 的标题）。**以游戏代码为准，不要信标题。**
> 这是一个大幅改造过的 FE8U hack：职业表 128 条（原版更少）、
> 部分角色用未压缩文本（§3.9）、部分成长率 >100（合法）、
> 地图设置表 79 条，且每条记录的 `+0` 被改写成了指针（§3.11.2）。

FE7 有 **FE7U**（美版）和 **FE7J**（日版）两套完全不同的指针布局，代码里是 `ROMFE7U.cs` / `ROMFE7JP.cs` 两个类。**先做哪个取决于你手上 ROM 的版本**（见 §3.1 识别方法）。中文汉化版通常基于 FE7U 或 FE7J，且可能打了文本补丁，见 §4.3。

---

## 1.1 `config/data` 在哪里 ⭐⭐

**这一条曾经搞错过，代价是白扔了一整轮工作。记牢：**

```
FEBuilderGBA/bin/Debug/config/data/     ← 上游源头，422 个文件，就在这里
FEBuilderGBA/bin/Release/config/data/
cli/data/                               ← 我们 vendored 的副本，27 个文件
```

不是 `FEBuilderGBA/config/data/`。`U.ConfigDataFilename()`（`U.cs:3180`）拼的是

```
Path.Combine(BaseDirectory, "config", "data", type + RomInfo.TitleToFilename + "." + lang + ".txt")
```

而 `BaseDirectory` 是**可执行文件所在目录**，即 `bin/Debug`。源码树里的 `config/` 目录确实不存在 ——
但 `bin/Debug/config/data/` 一直在。**先 `ls` 再下结论。**

### CLI 不再读 `FEBuilderGBA/`（已 vendored）

早期 `cli/src/config/data.ts` 的搜索路径会去 `FEBuilderGBA/bin/Debug/config/data/` 里找文件，
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

**刷新方式**：FEBuilderGBA 更新后，从 `FEBuilderGBA/bin/Debug/config/data/` 重新拷这 27 个文件。
搜索路径（`cli/src/config/data.ts`）：`$FEBUILDERGBA_CONFIG`（显式覆盖）→ `cli/data/`。
文件名解析顺序：`<prefix><game>.txt` → `.en.txt` → `.zh.txt`。

> 验证解耦：把 `cli/{src,data,package.json,tsconfig.json}` 拷到仓库外单独跑，
> `chapters` / `roles` 输出与在仓库内完全一致。


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

## 3. FE7 / FE8 数据字典（已从代码核实）

> 下面所有偏移都是 **file offset**（不是 GBA 地址）。GBA 地址 = file offset + `0x08000000`。
> 所有 `*_pointer` 字段都是**指针槽**，用前先 `p32()`。

### 3.1 ROM 版本识别

读 file offset **`0xAC`** 开始的 **6 字节 ASCII** 游戏代码（`Rom.cs` `Load()`）：

| 游戏代码 | 版本 | RomInfo 类 |
|---|---|---|
| `AE7E01` | FE7U（烈火之剑 美版） | `ROMFE7U` |
| `AE7J01` | FE7J（烈火之剑 日版） | `ROMFE7JP` |
| `AFEJ01` | FE6J | `ROMFE6JP` |
| `BE8E01` | FE8U | `ROMFE8U` |
| `BE8J01` | FE8J | `ROMFE8JP` |

```ts
const gameCode = rom.subarray(0xAC, 0xAC + 6).toString('ascii');  // 如 "AE7E01"
```

另外 `Rom.LoadLow()` 还要求 ROM 长度满足：FE7/FE8 ≥ `0x1000000`（16MB），FE6 ≥ `0x800000`（8MB）。

### 3.2 关键指针（file offset）

| 字段 | FE7U | FE7J | FE8U | 说明 |
|---|---|---|---|---|
| `unit_pointer` | `0x9A274` | `0x9AC50` | **搜索** ⓐ | 角色表指针槽 |
| `unit_maxcount` | `253` | `253` | `255` | 角色记录数 |
| `unit_datasize` | `52` | `52` | `52` | 角色记录大小 |
| `class_pointer` | `0x178F0` | `0x17CE0` | **搜索** ⓑ | 职业表指针槽 |
| `class_datasize` | `84` | `84` | `84` | 职业记录大小 |
| `map_setting_pointer` | `0x31580` | `0x31A6C` | **搜索** ⓒ | 地图设置表指针槽（§3.11.2） |
| `map_setting_datasize` | `152` | `148` | `148` | 地图设置记录大小 |
| `map_event_pointer` | `0x315D4` | `0x031B18` | `0x0346DC` | 事件 plist 表（§3.11.3） |
| `support_unit_pointer` | `0xBDCE78` | `0xC4C184` | `0x803D90` | 支援关系表指针槽 |
| `support_talk_pointer` | `0x78A94` | `0x79264` | `0x084784` | 支援会话表指针槽 |
| `support_attribute_pointer` | `0x26998` | `0x26E24` | `0x28534` | 支援相性加成表指针槽（§3.7） |
| `map_terrain_name_pointer` | `0x19B1C` | `0x19EFC` | `0x1A254` | 地形名表指针槽（§3.12） |
| `mask_pointer` | `0x6BC` | `0x6E0` | `0x6E0` | Huffman 树（解引用 1 次） |
| `mask_point_base_pointer` | `0x6B8` | `0x6DC` | `0x6DC` | Huffman 树数据基址（解引用 2 次） |
| `text_pointer` | `0x12CB8` | `0x13370` | `0xA2A0` | 文本指针表（解引用 1 次） |
| `text_recover_address` | `0xB808AC` | `0xBBB370` | `0x15D48C` | 文本表被改坏时的兜底偏移（**直接偏移，不解引用**） |
| `is_multibyte` | `false` | `true` | `false` | 文本是否多字节（SJIS） |

> 来源：`ROMFE7U.cs` / `ROMFE7JP.cs` / `ROMFE8U.cs` 第 16–28 行附近。

**ⓐⓑ FE8U 的角色表/职业表指针槽是「搜索」出来的，不是固定常量。**
FE8 各修订版之间这两个槽位挪过位置，所以 `ROMFE8U.cs` 里给的是一个候选列表，
由 `U.FindROMPointer(rom, checkPointer, candidates)` 挑出第一个满足条件的槽：

1. 槽本身是安全偏移；
2. 槽里的值是安全 GBA 指针；
3. `u32(table + checkPointer)` 也是安全 GBA 指针。

角色表 `checkPointer = 0x2C`（44，每个角色都有的支援指针）；
职业表 `checkPointer = 0x88`（136）。第 3 条才是让搜索可靠的关键。

- 角色表候选：`0x10108, 0x104EC, 0x10538, 0xA0B40, 0xA0BB8, 0xBE954`
- 职业表候选：`0x017AB8, 0x17DBC, 0x18DAC, 0x19458`

> 实测 `dream-of-five.gba`：角色表命中 `0x10108` → 表地址 `0x803D64`；
> 职业表命中 `0x17AB8` → 表地址 `0x807110`。

**ⓒ FE8U 的 `map_setting_pointer` 也是「搜索」出来的**，且判据与前两者不同 ——
用的是 `FindROMPointer` 的 `Func<uint,bool>` 重载（`U.cs:7705`），
`func` 检查 `u32(tableOffset + 0x12) < 0xE`。完整候选列表和上游 bug 见 §3.11.2 / §3.11.6。

### 3.3 角色表 —— `unit_pointer`，52 字节/条

表地址 = `p32(unit_pointer)`，共 `unit_maxcount` 条（FE7U/FE7J = 253，FE8U/FE8J = 255，FE6J = 226）。
**角色 ID 从 1 开始**：ID `n` 的记录位于 `tableAddr + (n-1) * 52`（`UnitForm.cs:248` 里是 `uid--` 后再乘）。

> ⚠️ **角色表用「固定条数」，不扫终止符。** `UnitForm.Init()` 的读入判定是
> `return i < RomInfo.unit_maxcount;` —— 没有任何「遇到空记录就停」的逻辑。
> 这一点和职业表**不同**（见 §3.4）。

| 偏移 | 宽度 | 字段 | 说明 |
|---|---|---|---|
| `+0` | u16 | 名前 | 名字的文本 ID → 需 Huffman 解码 |
| `+2` | u16 | 詳細 | 图鉴说明的文本 ID |
| `+4` | u8 | ID | 角色 ID |
| `+5` | u8 | 支援クラス | 基础职业 ID（指向职业表，0-based） |
| `+6` | u16 | マップ顔 | 地图头像 ID |
| `+8` | u8 | 顔 | 对话头像 ID |
| `+9` | u8 | 属性 | 属性（理/光/暗等） |
| `+10` | u8 | ソート順 | 排序用 |
| `+11` | u8 | LV | 初始等级 |
| `+12` | **i8** | HP | **相对职业基础值的增量**（见下 ⚠️） |
| `+13` | **i8** | 攻撃 | 力/魔力，增量 |
| `+14` | **i8** | 技 | 增量 |
| `+15` | **i8** | 速さ | 增量 |
| `+16` | **i8** | 守備 | 增量 |
| `+17` | **i8** | 魔防 | 增量 |
| `+18` | **i8** | 幸運 | 增量（幸运没有职业基础值，所以这一项就是最终值） |
| `+19` | **i8** | 体格 | 增量 |
| `+20` | u8 | 武器LV | 剑 |
| `+21` | u8 | 武器LV | 枪 |
| `+22` | u8 | 武器LV | 斧 |
| `+23` | u8 | 武器LV | 弓 |
| `+24` | u8 | 武器LV | 杖 |
| `+25` | u8 | 武器LV | 理（Anima） |
| `+26` | u8 | 武器LV | 光（Light） |
| `+27` | u8 | 武器LV | 暗（Dark） |
| `+28` | u8 | 成長率 HP | 百分比 |
| `+29` | u8 | 成長率 攻撃 | |
| `+30` | u8 | 成長率 技 | |
| `+31` | u8 | 成長率 速さ | |
| `+32` | u8 | 成長率 守備 | |
| `+33` | u8 | 成長率 魔防 | |
| `+34` | u8 | 成長率 幸運 | |
| `+35` | u8 | 下位クラス戦闘アニメ色 | 调色板 ID |
| `+36` | u8 | 上位クラス戦闘アニメ色 | 调色板 ID |
| `+37` | u8 | 下級専用アニメ | 自定义战斗动画 |
| `+38` | u8 | 上級専用アニメ | 自定义战斗动画 |
| `+39` | u8 | （未标注） | |
| `+40` | u8 | 特性1 | 职业特性位标志 |
| `+41` | u8 | 特性2 | |
| `+42` | u8 | 特性3 | |
| `+43` | u8 | 特性4 | |
| **`+44`** | **p32** | **支援データ** | **→ 支援关系表指针（GBA 指针）** |
| `+48` | u8 | 会話グループ | 会话组 |
| `+49` | u8 | （未标注） | |
| `+50` | u8 | （未标注） | |
| `+51` | u8 | （未标注） | |

> 来源：`UnitFE7Form.cs` + `UnitFE7Form.designer.cs` 的控件名/标签。
> 偏移 44 处的支援指针是 FE6/FE7/FE8 **共通**的（`SupportUnitForm.cs:282` 有明确注释）。

#### 3.3.1 `+12..+19` 是**有符号增量**，不是初始能力 ⭐⭐

参考程序把这个区间的表头标为 `X_BASE.Text = "ユニット別能力"`
（`X_BASE.AccessibleDescription = "@UNITBASE"`）。说明文字在 `InputFormRef.cs:12022`：

> 「ユニットの基礎値です。この値に、クラスの能力値を加えたものがユニットの初期値になります。
> **マイナス値にすることもできますが、合算した時に -1 以下になると、2 の補数により、
> ロード時に最大数になります。**」

职业表那边对应的是 `@CLASS_BASE`（`InputFormRef.cs:11886`）：
「このクラス能力値とユニット能力値を合算したものがユニットの初期値になります。」

**三条推论，都必须照做：**

1. **实际初始值 = 职业基础值 + 角色增量。** 想比较两个角色，必须先把职业基础值加上去。
   实测 `dream-of-five.gba`：Kolbane 的 HP 增量是 **0**，但 Soldier 职业基础 HP 是 24
   → 实际初始 HP 是 **24**。只读原始字节会以为他 0 HP。
2. **这个字段是有符号的。** `0xFF` 是 **−1**，不是 255。用 `u8` 读会把每个负数变成
   「+255 的巨额加成」。实测有 10 个槽位带负增量（Jauger 体格 −1、Lyndra 体格 −2 等）。
   **TS 里用 `rom.i8()`，不要用 `u8()`。**
3. **增量为 0 是最常见的值**（实测 255 个槽位里 **70 个** HP 增量为 0），
   含义只是「不比职业基础值多」，**不是数据缺失、也不是 hack 怪癖**。
   （曾经把这个 0 写成「基础 HP 读出来是 0，需实机确认」——**那是错的**。）

**校验**：`cli` 的 `unit.statWraps`（error 级）检查 `职业基础值 + 增量 <= -1` 的记录 ——
按参考代码的说明，这种单位在载入时会被补码成最大值，属于损坏数据。

**注意 `+44` 的支援指针指向的是「支援关系表的某一条记录」**，不是指针槽 —— 它已经是 GBA 指针，直接 `- 0x08000000` 就是偏移。这是反查「这条支援数据属于哪个角色」的唯一途径（`UnitForm.cs:411` `GetUnitIDWhereSupportAddr`）。

### 3.4 职业表 —— `class_pointer`，84 字节/条

表地址 = `p32(class_pointer)`。职业 ID 是 **0-based**。

> ⚠️ **职业表必须扫终止符，不能读满 256 条。** `ClassForm.Init()` 的读入判定（逐字照抄）：
>
> ```csharp
> (int i, uint addr) => {
>     if (i == 0) return true;                    // index 0 恒保留
>     if (i > 0xff) return false;                 // 硬上限 256 条
>     return Program.ROM.u8(addr + 4) != 0;       // 遇到「职业 ID == 0」即停
> }
> ```
>
> 原因见 §4.9：表尾之后的字节不是空白填充，而是链接器塞进来的**别的东西**。
> 当成职业记录去读，会得到一批名字看着很正常（`"Dark"`、`"Gunnels"`）、
> ID 却是垃圾的记录，并静默污染「职业 ID → 名字」的映射表。

| 偏移 | 宽度 | 字段 |
|---|---|---|
| `+0` | u16 | 名前（文本 ID） |
| `+2` | u16 | 詳細（文本 ID） |
| `+4` | u8 | ID |
| `+5` | u8 | クラスチェンジクラス（转职目标职业 ID） |
| `+6` | u8 | 待機アイコン |
| `+7` | u8 | 移動速度 |
| `+8` | u16 | 一般兵顔 |
| `+10` | u8 | ソート順 |
| `+11` | u8 | HP（基础值） |
| `+12` | u8 | 攻撃 |
| `+13` | u8 | 技 |
| `+14` | u8 | 速さ |
| `+15` | u8 | 守備 |
| `+16` | u8 | 魔防 |
| `+17` | u8 | 体格 |
| `+18` | u8 | **移動**（移动力） |
| `+19` | u8 | HP（上限） |
| `+20` | u8 | 攻撃（上限） |
| `+21` | u8 | 技（上限） |
| `+22` | u8 | 速さ（上限） |
| `+23` | u8 | 守備（上限） |
| `+24` | u8 | 魔防（上限） |
| `+25` | u8 | 体格（上限） |
| `+26` | u8 | 経験値補正値 |
| `+27` | u8 | 敵成長率 HP |
| `+28` | u8 | 敵成長率 攻撃 |
| `+29` | u8 | 敵成長率 技 |
| `+30` | u8 | 敵成長率 速さ |
| `+31` | u8 | 敵成長率 守備 |
| `+32` | u8 | 敵成長率 魔防 |
| `+33` | u8 | 敵成長率 幸運 |
| `+34` | u8 | CCボーナス HP（转职加成） |
| `+35` | u8 | CCボーナス 攻撃 |
| `+36` | u8 | CCボーナス 技 |
| `+37` | u8 | CCボーナス 速さ |
| `+38` | u8 | CCボーナス 守備 |
| `+39` | u8 | CCボーナス 魔防 |
| `+40` | u8 | 特性1（位标志） |
| `+41` | u8 | 特性2 |
| `+42` | u8 | 特性3 |
| `+43` | u8 | 特性4 |
| `+44`–`+51` | 8×u8 | 武器LV（剑/枪/斧/弓/杖/理/光/暗） |
| `+52` | p32 | 戦闘時アニメ（战斗动画指针） |
| `+56` | p32 | 移動コスト（移动消耗） |
| `+60` | p32 | 移動コスト(雨) |
| `+64` | p32 | 移動コスト(雪) |
| `+68` | p32 | 地形回避 |
| `+72` | p32 | 地形防御 |
| `+76` | p32 | 地形魔防 |
| `+80` | u32 | （未标注） |

> 来源：`ClassForm.cs` + `ClassForm.designer.cs`。
> 职业 ID `0x00` 是空记录，且被写入保护（`ClassForm.cs` 里 `UseWriteProtectionID00 = true`）。

#### 3.4.1 職業特性位 —— 判断「飞行/骑马/重甲/再移动」的主来源 ⭐⭐

职业记录 `+40`–`+43` 是四个字节的特性位。**位名在
`FEBuilderGBA/bin/Debug/config/data/unitclass_checkbox_FE8.txt` 里**（见 §1.1）——
这一条曾经被误判为「不可得」，实际上一直在。

`U.LoadDicResource`（`U.cs:3385`）用 `U.atoh` 解析 key，所以 **key 是十六进制**。
位运算规则在 `InputFormRef.GetInfoByBitFlag`（`InputFormRef.cs:7453`）：

```
byteIndex = (key >> 4) & 0xF        // 高半字节 = 第几个字节
bit       = (key & 0xF) - 1         // 低半字节 = 第几位，1-based
mask      = 1 << bit
```

所以 key `13` = `0x13` → byteIndex 1 → 掩码 `1 << 3` = `0x08`，落在 `+41`。
key `< 0x10` 落在 `+40`，`< 0x20` 落在 `+41`，依此类推。

FE8U 实测解出 32 个特性位，关键几个：

| key | 名称 | 偏移/掩码 | 我们用它做什么 |
|---|---|---|---|
| `13` | 馬マーク（骑马） | `+41` `0x04` | `mobility = 'mounted'` |
| `14` | 飛龍（飞龙） | `+41` `0x08` | `mobility = 'flying'`，`mount = 'wyvern'` |
| `15` | ペガサス（天马） | `+41` `0x10` | `mobility = 'flying'`，`mount = 'pegasus'` |
| `27` | 鎧△（三角攻击 2） | `+42` `0x40` | `mobility = 'armour'` |
| `05` | 踊る（舞蹈） | `+40` `0x10` | `specialAction = 'dancer'` |
| `06` | 奏でる（奏乐） | `+40` `0x20` | `specialAction = 'bard'` |
| `03`/`04` | 盗む/盗贼技 | `+40` `0x04`/`0x08` | `specialAction = 'thief'` |
| `11` | 上級クラス | `+41` `0x01` | 是否已转职 |
| `17` | 女性 | `+41` `0x40` | — |
| `18` | BOSS | `+41` `0x80` | — |

**注意 mask 的位序**：key `13` 是 `0x13`，不是十进制 13。搞错这一条会把
Thief / Bard / Civilian 全部读成飞行单位。

##### 交叉校验：移動コスト（旧判据，保留）

职业记录 `+56` 是**一个指针槽**，指向该职业的**地形移动消耗表**：

```
costs = rom.bytes(p32(classAddr + 56), 65)   // 65 项，每项 u8
```

- **65 项，不是 64。** 三条独立测量互相印证：
  1. `MoveCostForm.Designer.cs` 声明了 `B0..B64` **共 65 个** `NumericUpDown`；
     `MoveCostForm.cs` 给 **65 列**贴 `J_0..J_64` 标签（用 `MapTerrainNameForm.GetName(n, true)`）。
  2. 地形名表也是 **65 条**（`0..0x40`，§3.12）—— 两张表用同一套 id，长度必须一致。
  3. 实测各职业的消耗表在 ROM 里**按 `0x41` 字节间隔**排列（16 张表，间隔全是 `0x41`）。
     另外 `PatchUtil.WriteIndependence(p, 68, ...)` 也把 65 向上取整到 4 的倍数。
- ⚠️ **只读 64 会静默丢掉最后一列 —— 地形 `0x40`（"Mast"）。** 这是个不报错的截断：
  移动力为 0 的静止职业没有这张表，所以「都读到 64 字节」看起来完全正常。
  常量在 CLI 里是 `CLASS_TERRAIN_COUNT = 0x41`（`tables/classes.ts`）。
- 每项是该职业踏入对应地形所需的移动力；`0xFF` = **不可通行**。

判定规则（`cli/src/analysis/roles.ts` 的 `classifyMobilityByCosts`）：

| 标签 | 判据 |
|---|---|
| `flying` | 所有可通行地形的消耗**完全相同** —— 飞行单位无视地形 |
| `armour` | 对任何地形都**不比步兵便宜**，且至少有一处更贵 |
| `normal` | 其余 |

「步兵基线」= ROM 里出现次数最多的那张消耗表。

> **特性位是主来源，消耗表是交叉校验。** 二者不一致时 `roles` 命令的
> `mobilityDisagreements` 会列出来。FE8U 实测 127 个职业只有 3 处不一致
> （Hussar / Outrider / Skirmisher —— 特性位说骑马，消耗表说普通），
> 说明两条路都对，分歧来自 hack 作者改了其中一处。
>
> 消耗表仍然是**唯一能区分「飞龙」和「天马」之外**的判据来源；
> 而「骑马 vs 重甲」现在由特性位干净地分开，不再需要回避。

> ⚠️ **移动力为 0 的职业没有这张表**（如 Gorgon Egg、Arcane Lock、空白填充槽），
> `p32(+56)` 会解析失败。这是合法的，校验里应跳过（见 §6）。

### 3.5 支援关系表 —— 24 字节/条 ⭐

表地址 = `p32(support_unit_pointer)`。

这张表**不是**按角色 ID 顺序排列的，也没有固定条数。**唯一的索引方式是角色记录 `+44` 处的支援指针。**

每条记录 24 字节：

| 偏移 | 宽度 | 字段 |
|---|---|---|
| `+0`–`+6` | 7×u8 | 支援相手 1–7（对方角色 **ID**，0 = 空位） |
| `+7`–`+13` | 7×u8 | 各相手对应的**初期値**（初始支援点数） |
| `+14`–`+20` | 7×u8 | 各相手对应的**進行値**（每回合支援点数增长） |
| `+21` | u8 | 支援人数（有效相手数量，最多 7） |
| `+22`–`+23` | 2×u8 | 填充，应为 0 |

即：第 *i* 个支援对象是 `rec[+i]`，其初始值是 `rec[+7+i]`，成长值是 `rec[+14+i]`，*i* ∈ [0,7)。

支援关系是**双向存储**的：A→B 和 B→A 各有一条记录，且两边数值必须一致（`SupportUnitForm.MakeCheckError_SelfCheck` 会校验）。

**角色 ID > `0x45` 的是敌方/不可加入单位**，不会有支援成长值（`SupportUnitForm.cs:414`）。

#### 3.5.1 C/B/A 的门槛与完整升级机制 ⭐⭐⭐

`SupportUnitForm.Designer.cs:460`（`SupportUnitFE6Form.Designer.cs:363` 同样一段）的
`EXPLAIN` 文本框：

```
C    81から160まで
B    161から240まで
A    241以降

支援の値は、初期値から始まり、キャラが隣接していると進行度に応じて増加していきます。
一定数の支援値がたまると、支援コマンドが表示され、支援会話をすることで次のレベルに進みます。
```

- 支援值 **81–160 = C、161–240 = B、241 以上 = A**，是**累计值**（到 B 要总共 161 点，不是 81+161）。
- 从 `+7..+13` 的**初期値**起步，两人相邻时每回合加 `+14..+20` 的**進行値**。

##### ⚠️ 但「门槛」和「能升级的点数」差 1 —— 中间隔着一次支援对话

上面那句「一定数の支援値がたまると、支援コマンドが表示され、**支援会話をすることで**次のレベルに進みます」
才是关键。支援点数**会被封顶**，必须真的去看支援对话才会进下一级。反汇编 ROM 自己的代码
（`GetUnitSupportBonuses` / `UnitGainSupportExp`）得到：

```
当前等级为「无」时，点数最多涨到 80      → 支援对话可用 → 对话后点数变 81  → 等级 C
当前等级为 C 时，点数最多涨到 160        → 支援对话可用 → 对话后点数变 161 → 等级 B
当前等级为 B 时，点数最多涨到 240        → 支援对话可用 → 对话后点数变 241 → 等级 A
```

- **80 / 160 / 240 是「解锁对话」的点数**（`SUPPORT_CONVERSATION_CAPS`）。
- **81 / 161 / 241 是「对话之后持有」的点数**（`SUPPORT_RANK_THRESHOLDS`）。
- 所以「还要相邻几回合才能升到 C」= `ceil((80 − 初始值) / 成长值)`，**不是** `ceil((81 − 初始值) / 成长值)`。
  对话本身不消耗回合。

本 CLI 的 `supportRankPlan()` 就按这个顺序走：

```
turnsToConversation = 到达各级封顶值还差的回合数（0 = 已可对话，null = 成长值为 0）
turnsTo             = 上述的累计（假设一解锁就立刻对话，所以是下限）
```

实测 `Rena <-> Kolbane`（初始 5，成长 3）：`turnsToConversation = C:25 B:27 A:27`，
`turnsTo = C:25 B:52 A:79`。

##### 其他由代码核实的机制

| 机制 | 值 | 出处 |
|---|---|---|
| 加成生效距离 | `|dx| + |dy| ≤ 3` | `SUPPORT_BONUSES_MAX_DISTANCE` |
| 点数增长距离 | `|dx| + |dy| ≤ 1`（相邻）；**一人背另一人也算** | `ProcessTurnSupportExp` 的 `case 0` |
| 单人可持有支援**等级**总数 | **5**（A=3, B=2, C=1，求和后 < 5 才能开新的） | `MAX_SIMULTANEOUS_SUPPORT_COUNT` |
| 每对每章可升级次数 | 1 | `CanUnitSupportNow` |

> ⚠️ 「上限 5」是**等级数之和**，不是「5 个伙伴」。一个 A(3) + 一个 B(2) 就满了；
> 5 个 C 也满。且**双方任一方的总数达到 5 都不能再开新支援**。

> 来源：`SupportUnitForm.Designer.cs:460`（门槛文字）+ **反汇编**（见 §3.13）
> + FE8 反编译 `include/bmreliance.h`（`SUPPORT_EXP_C/B/A = 81/161/241`、
> `MAX_SIMULTANEOUS_SUPPORT_COUNT = 5`、`SUPPORT_BONUSES_MAX_DISTANCE = 3`、
> `struct SupportData` 的 `+15 = supportCount`）。
> 常量在 CLI 里是 `SUPPORT_RANK_THRESHOLDS` / `SUPPORT_CONVERSATION_CAPS`（`tables/supports.ts`）。

> 来源：`SupportUnitForm.cs`。常量 `SUPPORT_LIMIT = 7`（`SupportUnitForm.cs:322`）。
> 结构体大小 24 来自 `Init()` 的第 4 个参数。

### 3.6 支援会话表 —— 20 字节/条

表地址 = `p32(support_talk_pointer)`。FE7 专用编辑器是 `SupportTalkFE7Form.cs`（FE6/FE8 结构不同）。

| 偏移 | 宽度 | 字段 |
|---|---|---|
| `+0` | u8 | 支援相手 1（角色 ID） |
| `+1` | u8 | 支援相手 2（角色 ID） |
| `+2` | u16 | （填充） |
| `+4` | u32 | C 级支援会话文本 ID |
| `+8` | u32 | B 级支援会话文本 ID |
| `+12` | u32 | A 级支援会话文本 ID |
| `+16`–`+19` | 4×u8 | （未标注，通常为 0） |

> 来源：`SupportTalkFE7Form.cs` + `SupportTalkFE7Form.Designer.cs`。
> 文本 ID 用 `u32` 读取（`SupportTalkFE7Form.cs:107` 用 `u32(battletalk_addr + 4)` 读 C 会话）。

### 3.7 支援相性加成表 —— 8 字节/条 ⭐⭐⭐

表地址 = `p32(support_attribute_pointer)`。

⚠️ **这不是「每级一条」，是「每个相性一条」。** 实测（FE8U）：

- 表里有 **7 条**记录，第 0 字节依次是相性 ID `1..7`。
- 读入规则 `SupportAttributeForm.Init()` 是 `return rom.u8(addr) != 0;` —— **读到第 0 字节为 0 就停**。
- 所以「7 条」不是巧合，而是相性总数（炎/雷/風/氷/闇/光/理）。

每条 8 字节：

| 偏移 | 字段 | 实测（FE8U，1=Fire … 7=Anima） |
|---|---|---|
| `+0` | 相性 ID（1–7） | 1,2,3,4,5,6,7 |
| `+1` | `bonusAttack` 攻击 | 全 1 |
| `+2` | `bonusDefense` 防御 | 0/1 |
| `+3` | `bonusHit` 命中 | 0 或 5 |
| `+4` | `bonusAvoid` 回避 | 0 或 5 |
| `+5` | `bonusCrit` 必杀 | 0 或 5 |
| `+6` | `bonusDodge` 必杀回避 | 全 5 |
| `+7` | 填充（参考代码里标签就是 `??`） | 全 0 |

**相性名称是权威的**，硬编码在 `InputFormRef.cs:7006 GetAttributeName()`：

```
1=炎(Fire)  2=雷(Thunder)  3=風(Wind)  4=氷(Ice)  5=闇(Dark)  6=光(Light)  7=理(Anima)
```

角色自身的相性在角色记录 `+9`（本 CLI 暴露为 `Unit.attribute`）。

#### 3.7.1 ⚠️⚠️ 表里存的是**半点值**，不是最终加成

**这是本表最大的坑。** 看到「每行 `atk` 都是 1、`critAvoid` 都是 5」时，很容易得出
「这 ROM 的数据被改坏了 / 和公版对不上」的结论。**两个结论都是错的。**

真相是：表里存的值要**再除以 2** 才是玩家看到的加成。证据来自 ROM 自己的代码
（`GetUnitSupportBonuses` 末尾对六个字段各做一次 `lsrs #1`）：

```
存 1 → C: 1×1>>1 = 0   B: 1×2>>1 = 1   A: 1×3>>1 = 1     即 atk +0/+1/+1
存 5 → C: 5×1>>1 = 2   B: 5×2>>1 = 5   A: 5×3>>1 = 7     即 hit/crit/critAvoid +2/+5/+7
```

于是 7 行展开成（C/B/A）：

| 相性 | atk | def | hit | avoid | crit | critAvoid |
|---|---|---|---|---|---|---|
| Fire 炎 | 0/1/1 | 0/0/0 | 2/5/7 | 0/0/0 | 2/5/7 | 2/5/7 |
| Thunder 雷 | 0/1/1 | 0/1/1 | 0/0/0 | 0/0/0 | 2/5/7 | 2/5/7 |
| Wind 風 | 0/1/1 | 0/0/0 | 0/0/0 | 2/5/7 | 2/5/7 | 2/5/7 |
| Ice 氷 | 0/1/1 | 0/1/1 | 0/0/0 | 2/5/7 | 0/0/0 | 2/5/7 |
| Dark 闇 | 0/1/1 | 0/0/0 | 2/5/7 | 2/5/7 | 0/0/0 | 2/5/7 |
| Light 光 | 0/1/1 | 0/0/0 | 2/5/7 | 2/5/7 | 0/0/0 | 2/5/7 |
| Anima 理 | 0/1/1 | 0/1/1 | 2/5/7 | 0/0/0 | 0/0/0 | 2/5/7 |

**`Dark` 与 `Light` 完全相同是公版数据，不是这个 hack 改的。** GBA 三作里闇与光在相性表上
本来就是互补同形的一对。所以本 ROM 的这张表**就是未改动的公版 FE8U 表**。

> 教训见 §4.12：**「看起来像脏数据」时，先怀疑自己漏了一层变换**，别先怀疑 ROM。
> 本 CLI 的 `supportAffinities[].byRank` 给出上表的数值，`bonus` 给出原始字节。

#### 3.7.2 完整公式（反汇编核实）

```c
// StoreAddedAffinityBonusesForSupportLevel(dest, affinity, level)
//   dest.bonusX += level * GetSupportBonusEntryPtr(affinity)->bonusX   (X = 6 项)
// GetUnitSupportBonuses(unit, dest)
//   InitSupportBonuses(dest)                      // dest[1..6] = 0
//   for 每个伙伴 i:
//     距离 |dx|+|dy| > 3 就跳过                     // SUPPORT_BONUSES_MAX_DISTANCE
//     对方 UNAVAILABLE / RESCUED 就跳过
//     StoreAdded(dest, 对方的相性, 对方对 unit 的等级)
//     StoreAdded(dest, unit 的相性, unit 对 i 的等级)
//   dest[1..6] 各 >>= 1                            // 只除一次，除的是总和
```

即：

```
bonus[stat] = floor( Σ_伙伴 ( 行[我方相性][stat] × L(我方→对方)
                            + 行[对方相性][stat] × L(对方→我方) ) / 2 )
L = 0/1/2/3 对应 无/C/B/A
```

三个反直觉点：
1. **双方相性都算。** 不是只算自己的。
2. **`>>1` 只做一次，作用在总和上**，不是每项各自除。多个相邻伙伴时两种算法结果不同。
3. **`+7` 不是 `+2×3`。** A 级 = 原始值 ×3 再取整（`5×3>>1 = 7`），而不是 `C 级取整后 ×3`（`2×3 = 6`）。

> 来源：`SupportAttributeForm.cs` / `.Designer.cs`（字段名取自 `B0`–`B7` 旁的 Label）
> + `InputFormRef.cs:7006` + **反汇编**（见 §3.13）+ FE8 反编译 `include/bmreliance.h`
> 的 `struct SupportBonuses`（字段名与顺序的权威来源）。

### 3.8 文本解码（Huffman）—— `FETextDecode.cs:327`

**不解码文本就拿不到角色名。** 完整算法：

```
tree_base      = p32(RomInfo.mask_pointer)              // 树节点基址
tree_data_base = p32p(RomInfo.mask_point_base_pointer)  // 叶数据基址（二级指针）
tree_data      = tree_data_base

循环:
  word = u32(addr)                       // 一次读 4 字节，小端
  if word == 0 && u32(addr+4) == 0:      // 连续两个 0 = 字符串结束
      return
  addr += 1
  for bit_index = 7 downto 0:            // 从最高位开始，逐位消费
      child = u16(tree_data + (word & 1) * 2)
      tree_data = tree_base + child * 4
      word >>= 1
      node = u32(tree_data)
      if (node & 0x80000000) == 0:       // 高字节未置位 = 内部节点，继续走
          continue
      tree_data = tree_data_base         // 命中叶子，重置树游标
      code = node & 0xFFFF
      if code == 0 || (code & 0xFF) == 0:
          return                          // 终止码
      输出(code)
```

**字符输出规则**（`append_string`，`FETextDecode.cs:214` 附近）：

| 条件 | 处理 |
|---|---|
| `code == 0` | 跳过，不输出 |
| `isEscapeCode(code, beforecode)` | 输出 `"@" + code.toString(16).padStart(4,'0')`，如 `@001F` —— 这是控制码 |
| `(code & 0xFF00) == 0` | 输出单字节 `code` |
| 其他 | 输出两个字节：`code & 0xFF`，再 `(code >> 8) & 0xFF` |

`isEscapeCode(code, beforecode)` 为真当：

```ts
beforecode === 0x0010 || beforecode === 0x0011 || beforecode === 0x0080
  || code <= 0x001F
  || (code >= 0x0080 && code <= 0x0F00)
```

**外层还有一个分支**（`huffman_decode` 内，`FETextDecode.cs:418`）—— 当 `useSJIS` 为真（FE7J），或 `beforecode ∈ {0x10, 0x80}`，或 `(code & 0xFF00) >= 0x8100`，或 `(code & 0xFF00) == 0x0000`，或 `(code & 0xFF00) == 0x1F00` 时，整个 `code` 走一次 `append_string`；否则拆成低字节、高字节两次调用。

**建议**：不要凭上面的描述重写，**直接逐行移植 `FETextDecode.cs` 的 `huffman_decode()` + `append_string()` + `listbyte_to_string()` 三个函数**（共约 200 行）。这个算法边界条件很多，照抄比理解更快、更准。

**字节 → 字符**（`listbyte_to_string_low`）：调用 `SystemTextEncoder.Decode()`。对**原版 FE7U**，字节基本就是 ASCII/Latin-1；对 **FE7J** 是 SJIS。另外 `FETextEncode.RevConvertSPMoji()` 会做一次特殊字符替换。

### 3.9 文本表条目有「两种格式」—— 反 Huffman 补丁 ⭐

**拿到 `text_base + id*4` 处的 4 字节后，不要直接当 Huffman 指针用，先分类。**
`FETextDecode.DecodeAddr()`（`FETextDecode.cs:73`）的判断顺序：

```csharp
uint paddr = this.ROM.u32(addr);
if (FETextEncode.IsUnHuffmanPatchPointer(paddr))      // ① 未压缩存储
    return UnHffmanPatchDecode(U.toOffset(
        FETextEncode.ConvertUnHuffmanPatchToPointer(paddr)), out _);
else if (U.isPointer(paddr))                          // ② 正常 Huffman
    return huffman_decode(U.toOffset(paddr), out _);
return "";                                            // ③ 无效
```

判据与转换（`FETextEncode.cs:518`）：

```csharp
IsUnHuffmanPatchPointer(p)        => p >= 0x88000000 && p <= 0x8A000000
ConvertUnHuffmanPatchToPointer(p) => p - 0x80000000
```

也就是说：打了 un-huffman 补丁的字符串，指针被**整体加上了 `0x80000000`**，
落进 `0x88000000..0x8A000000` —— 这个区间在 GBA 地址空间之外，永远不会和正常指针混淆。
减回 `0x80000000` 后就是普通的 GBA 指针。

**为什么要区分**：这类字符串是**明文存储**的，不是 Huffman 位流。
用 Huffman 解码器去解它只会得到垃圾或空串。一个 hack 里两种格式常常**混用**
（实测 `dream-of-five.gba`：255 个角色里 249 个能解出名字，其中相当一部分走的是这条路）。

**未压缩格式的解码**（`UnHffmanPatchDecode` + `UnHffmanPatchDecodeLow`）：

```
长度 = 从 addr 起连续非零字节的个数        // getBlockDataCount(addr, 1, p => u8(p) != 0)
src  = ROM[addr .. addr+长度]
```

然后对 `src` 做**变长字节游走**（不是位流！）：

| 条件（按顺序判断） | 动作 | 前进 |
|---|---|---|
| `isSJIS1st(code) && isSJIS2nd(code2)` 且优先级为 LAT1 | `@`+hex(code) | 1 |
| `code == 0x80` | `@`+hex(code) + `@`+hex(code2) | 2 |
| `code == 0x10` | `@0010` + `@`+hex(code3<<8 \| code2) | 3 |
| `code < 0x20 \|\| code == 0x40` | `@`+hex(code) | 1 |
| 优先级 LAT1 且 `IsEnglishSPCode(code)` | `@`+hex(code) | 1 |
| 其他 | 原样输出 `code` | 1 |

其中 `IsEnglishSPCode(c) => c >= 0x81 || c == 0x1F || c == 0x7B || c == 0x7C || c == 0x7D || c == 0x7F`。

> 对非 multibyte ROM，`PriorityCode` 是 `LAT1`（`PatchUtil.SearchPriorityCode()`：
> `is_multibyte` → SJIS；否则看 draw-font 补丁，无补丁 → LAT1）。
> 在 LAT1 下 `IsEnglishSPCode(code)` 对一切 `code >= 0x81` 都为真，
> 所以「SJIS 双字节」分支实际只会吃掉 1 个字节 —— 这正是 C# 的行为。

**诊断技巧**：如果某个名字解出来是空串，先打印该 text id 对应条目的原始 4 字节。
值落在 `0x88xxxxxx..0x8Axxxxxx` → 是 un-huffman，你没实现这条路；
值不在 `0x08xxxxxx..0x09xxxxxx` → 表基址或 id 算错了。

### 3.10 参考代码里**仍然拿不到**的东西 ⭐⭐

> **本节被写错过三次，每次的代价都一样大。**
>
> 第一次：断言「出场时间拿不到」「职业特性位拿不到」，理由是 `FEBuilderGBA/config` 目录不存在。
> **这个理由本身是错的** —— 数据在 `bin/Debug/config/data/`（见 §1.1）。
>
> 第二次：断言「支援 C/B/A 换算拿不到」「地形名字拿不到」。**两处也都是错的**，见 §3.10.1(1)(2)。
>
> 第三次：断言「本 ROM 的相性加成表和公版 FE8 对不上，要么被改过、要么指错了表」。
> **也是错的** —— 表就是未改动的公版，我漏看了「存的是半点值、游戏最后要 `>>1`」。见 §3.10.1(3)。
>
> 三次错在同一个思维定式上：**把「参考代码里没有这段计算」当成了「数据不在 ROM 里」。**
> FEBuilderGBA 是**编辑器**，不是模拟器 —— 它只需要把表显示出来让你改，**从来不需要算战斗结果**。
> 所以「没有算术」是它的正常状态，不能用来推断数据不存在。
> **正确的问法是「这个字段有没有一个 Form 在读它」，而不是「有没有一段代码在用它」。**
>
> 而第二次的教训还要再补一层：**连「看起来像脏数据」也不行。**
> 第三次里我明明把表读对了，却因为不理解值的量纲而宣称数据有问题。
> **「值不符合预期」时，先怀疑自己漏了一层变换（×2 / ÷2 / 有符号 / 单位），别先怀疑 ROM。**
> 这时正确的动作是**去反汇编 ROM 自己的代码**（§3.13）——ROM 的代码是唯一的终审法官。

#### 3.10.1 三个曾经的错误结论（现已更正）

##### ❌→✅ (1) 地形名字 —— **拿得到**

`RomInfo.map_terrain_name_pointer` 就是这张表，`MapTerrainNameForm.cs` 在读它，
`MoveCostForm` 用它给 `J_0..J_64` 共 65 列移动消耗贴标签，`MapEditorForm` 用它给光标下的格子显示名字。
**所以地形名和移动消耗用的是同一套 id（0..0x40）。**

两种存储形态，**不能混用**：

| 版本                | 步长 | 每条内容          | 终止条件                          |
| ----------------- | -- | ------------- | ----------------------------- |
| 日文版（multibyte）    | 4  | 指向**裸字符串**的 GBA 指针 | `!U.isPointerOrNULL(u32(a))`  |
| 英文版（非 multibyte）  | 2  | **文本 id**     | `u16(a) == 0`                 |

FE8U / FE7U 是 `is_multibyte = false`（`ROMFE8U.cs:460`、`ROMFE7U.cs:451`），走第二条路。
日文版那 4 字节指针指向的是**裸 Shift-JIS 字符串**（`ROM.getString`，**不过 Huffman**）。

指针槽（`ROMFE8U.cs:79` 等）：

| FE6J | FE7J | FE7U | FE8J | FE8U |
|---|---|---|---|---|
| `0x192C0` | `0x19EFC` | `0x19B1C` | `0x19F24` | `0x1A254` |

**实测（`fixtures/dream-of-five.gba`）**：表在 `0x80D374`，65 条，62 条有名字
（`0x00` / `0x2C` / `0x2E` 无名）：
`0x01=Plain 0x0C=Forest 0x12=Peak 0x15=Sea 0x18=Runes 0x35=Sky 0x36=Deeps …`

**独立交叉验证**：拿 `0x12`（Peak）当判据 —— 它是飞行专属地形。
实测 17 个飞行职业能踩，95 个地面职业不能踩；例外只有 `Thug` / `Berserker` / 2 个 `Dragon`
（这个 hack 里山贼系和怪物确实能踩 Peak）。**两套 id 对得上**（`terrain.idAlignment` 检查）。

##### ❌→✅ (2) 支援 C/B/A —— **拿得到，而且门槛就写在参考代码里**

我之前只看了 `SupportAttributeForm.cs`（53 行，确实没有任何算术），就下了结论。
**但门槛不在那个 Form 里，而在支援编辑器 `SupportUnitForm` 的说明文字里**
（`SupportUnitForm.Designer.cs:460`，`SupportUnitFE6Form.Designer.cs:363` 同样一段）：

```
C    81から160まで
B    161から240まで
A    241以降
```

即支援值 **81–160 = C、161–240 = B、241 以上 = A**，且是**累计值**。
配合支援记录的 `+7..+13`（初期値）和 `+14..+20`（進行値），就能算出「还要相邻几回合」。
完整机制（点数封顶 80/160/240、必须走支援对话、距离、每人 5 级上限）见 **§3.5.1**。

##### ❌→✅ (3) 相性加成表「和公版对不上」—— **对得上，表没被改**

当时的推理是：本 ROM 每行都给 `atk+1` + `critAvoid+5`，其余四项里再挑两项，
且 Dark 与 Light 字节完全相同；公版每行只给四项且各行互不相同 → 所以表被改过或指错了。

**三个前提里，只有「字节完全相同」这一条是真的。** 结论错在没意识到
**表里存的是半点值**：游戏在 `GetUnitSupportBonuses` 末尾对六个字段各做一次 `>>1`。

```
存 atk = 1  → C:0  B:1  A:1      ← 「全 1」不是脏数据，是 ×2 存储的必然结果
存 critAvoid = 5 → C:2  B:5  A:7
```

展开后每一行都精确落在公版 GBA FE 的相性表上（见 §3.7.1 的表）。
**Dark 与 Light 相同也是公版行为**，不是 hack 改的。

**这次是「数据看着脏 → 怀疑 ROM」，正确的动作应该是「数据看着脏 → 反汇编 ROM 自己的代码」。**
反汇编（§3.13）在 5 分钟内就给出了 `lsrs #1`，而我先写下了错误结论。

#### 3.10.2 一句话总结

| 想要的输入 | 能不能从参考代码得到 |
|---|---|
| 初始能力（职业基础值 + 角色增量，§3.3.1） | ✅ |
| 成长率 / 武器等级 | ✅ |
| 职业基础/上限/转职加成/移动力 | ✅ |
| 支援对象 / 初始值 / 成长值 | ✅ |
| 支援 C/B/A 点数门槛（81/161/241） | ✅ 见 §3.5.1 / §3.10.1(2) |
| 支援对话解锁点数（80/160/240） | ✅ 见 §3.5.1 |
| **加成如何随 C/B/A 放大** | ✅ **已跑通**：`存值 × {0,1,2,3} ÷ 2`，见 §3.7.2 / §3.13 |
| 相性加成原始数值（半点值） | ✅ |
| 角色相性（炎雷風氷闇光理） | ✅ 名字可从 ROM 文本表解出，见 §3.7 |
| 机动性（飞行 / 骑马 / 重甲 / 普通） | ✅ 特性位主判据，见 §3.4.1 |
| 能否用杖 / 是否魔法 | ✅（派生自武器等级） |
| **出场时间 / 加入章节 / 加入顺序** | ✅ **已跑通**，见 §3.11 |
| **地形名字**（65 条） | ✅ 见 §3.10.1(1) |
| 地形的回避/防御/魔防**数值** | ✅ 职业记录 `+68` / `+72` / `+76` 三个指针（本项目尚未接入） |

> **仍然拿不到的**：地形的**回复量**、武器三角的具体系数、以及任何需要模拟战斗才能得到的东西。
> 这些确实不在 ROM 的静态数据里，属于「游戏运行时的规则」，不是「表没找到」。

> **反面教材（别再试）**：曾经试过在 ROM 里**暴力扫 `u8 == unitId`** 来找出场位置 ——
> 角色 ID `1..255` 全部合法、记录只有 20 字节，扫描产生 **2,186,116** 个候选，
> 纯噪声、零筛选力。正确做法是走 §3.11 的指针链路，**不要扫字节**。

---

### 3.11 出场时间 / 加入章节 —— 完整链路 ⭐⭐⭐

这是本项目**最容易搞错**的一块，也是 AI 分析「该练谁、怎么排队伍」的关键输入。
链路本身全在参考代码里，`config/data/` 提供最后两块拼图。

#### 3.11.1 链路总览

```
地图设置表（map_setting_pointer 是「搜索型」槽，见 §2.2）
  记录 148 字节，+116 = 事件 plist 的索引 i
  → plist 表 = p32(map_event_pointer) 的第 i 个 4 字节槽
  → 章节条件表（20 个指针槽，顺序由 eventcond_FE8.txt 决定）
      slot 10 = PLAYER_UNIT（普通难度初始配置）
      slot 11 = PLAYER_UNIT（困难难度）
      slot 18 = START_EVENT，slot 19 = END_EVENT
  → 初始配置块：20 字节/条，u8(+0) == 0 终止
  → 起始事件脚本 → 事件反汇编器（opcode 表来自 config/data/event_FE8.txt）
      → LOAD1（402C....）= 仲間にする（招募入队）★ 这是「加入章节」
```

#### 3.11.2 地图设置表

`map_setting_pointer` 是**搜索型**槽：候选槽位有多个，靠
`U.FindROMPointer` 的 `Func<uint,bool>` 重载（`U.cs:7705`）逐个试。判据是
`isSafetyOffset(slot)` → `isSafetyPointer(u32(slot))` → `isSafetyOffset(tableOffset + 0x100)`
→ `func(tableOffset)`，其中 `func` 检查 `u32(tableOffset + 0x12) < 0xE`。

> ⚠️ **上游 bug**：`map_setting_pointer` 的 lambda 实际写的是 `rom.u32(0x12) < 0xE` ——
> **常量 0x12，不是 `addr + 0x12`**。我们按**作者本意** `tableOffset + 0x12` 实现。
> 两者在候选槽上会选出不同结果，用本意版。

**记录条数**：参考代码用 `MapSettingForm.IsMapSettingEnd`（`MapSettingForm.cs:64`）判断终止 ——
`u32(addr+0)` 若是 GBA 指针就停；否则再看 `weather (u8+12) < 0xE`、`+4`/`+8` 处非零 plist、
以及 `+0x70/+0x72/+0x88/+0x8A` 四个文本 id 是否 `< textMax`。

> **实测偏差**：`dream-of-five.gba` 把**每条记录 `+0` 都改写成了指针**
> （指向自定义地图名表 `0x081C32C8`，每条 +4）。于是参考代码的终止判定**在第一条就返回 true**，
> 报出 **0 张地图**。
>
> **对策（`cli/src/tables/chapters.ts` 已实现）**：先按参考代码跑；若得到 0 条，
> 且首条记录结构合法，则退化为**结构扫描** —— 连续 4 条空记录即停。
> 实测得到 **79 条**，`countSource: 'structural'`。这是**有意为之的偏差**，不是 bug。

#### 3.11.2.1 索引 ≠ 章节号：`+0x80` 才是章号 ⭐⭐

**这是最容易得出错误结论的地方。** 地图设置表**每张地图 id 一行**，所以它同时计入：

- **未使用槽位**（全零、标题为空、章号 0）
- **世界地图 / 遭遇图**（标题解码为 `@001F`，章号与它变体的那张剧情章**重复**）
- **bonus / 调试 / checkpoint 图**（`Lagdou Ruins`、`Castle Frelia`、`Act N Checkpoint`）

**不要**把表索引当成「第几章」报给人类。

| 字段 | 含义 | 来源 |
|---|---|---|
| `+0x70` (u16) | **マップ名1** —— 章节标题文本 id | 控件 `J_112_TEXT`；也是 `IsMapSettingEnd` 的四个探针之一 |
| `+0x72` (u16) | マップ名2(X) | 控件 `J_114_TEXT` |
| `+0x80` (u16) | **章号 ×2** —— 游戏自己的 `Chapter Number` | 控件 `J_128`，`AccessibleDescription = "@MAPSETTING_CHAPTOR_ID"`；说明文字在 `InputFormRef.cs:12097`：「章の番号です。進撃準備画面の右上に表示されます。」 |

**为什么是 ×2**：外传要占半格。`C8x` 存 17 → 8.5，`C10x` 存 21 → 10.5，
`C23x` 存 47 → 23.5，`Postscript` 存 55 → 27.5，`Crossroads` 存 13 → 6.5。
序章存 **0**（和未使用槽位同值，**所以不能只看章号判「是否空槽」**）。

`cli/` 的 `Chapter` 因此同时给出 `chapterNumber`（= `+0x80/2`）和 `titleTextId` / `title`。
`validate` 的 `chapter.numberMatchesTitle` 检查会把标题里的 `C<n>` 与 `+0x80/2` 逐一比对
（外传允许落在 `n` 或 `n+1`），实测 `dream-of-five.gba` **39 条全部吻合** —— 这是该字段解读的独立证据。

#### 3.11.3 条件表与初始配置块

`eventcond_FE8.txt` 给出 20 个槽的**名字与顺序**（这就是 `config/data` 的价值）：

```
TURN, TALK, OBJECT, ALWAYS, ALWAYS, ALWAYS, ALWAYS, TUTORIAL, TRAP, TRAP,
PLAYER_UNIT, PLAYER_UNIT, FREEMAP_PLAYER_UNIT ×3, FREEMAP_ENEMY_UNIT ×3,
START_EVENT, END_EVENT
```

`PLAYER_UNIT` 槽（10/11）指向**初始配置块**，20 字节/条：

| 偏移 | 类型 | 含义 |
|---|---|---|
| `+0` | u8 | 角色 ID（`0` = 块结束） |
| `+1` | u8 | 职业 ID（`0` = 用角色自带职业） |
| `+2` | u8 | 指挥官标记 |
| `+3`–`+4` | u16 | 等级增长值；`level = (grow >> 3) & 0x1F`（`U.ParseUnitGrowLV`，`U.cs:1734`） |
| `+4` | u8 | 预置坐标（打包），见下 |
| `+7` | u8 | 后置单位数 |
| `+8` | p32 | 后置单位指针 |
| `+12`–`+15` | — | 携带道具 |

坐标打包（`U.MakeFe8UnitPos`，`U.cs:1770`）：

```
packed = (x & 0x3F) | ((y & 0x3F) << 6) | ((ext & 0x7) << 12)
```

#### 3.11.4 事件反汇编器与 LOAD 指令

`EventScript.cs` 的 `DisAseemble(data, addr)` 把 `Scripts[]`（按 size 降序、参数少优先、
参数总字节小优先排序）逐个试，返回第一个「固定字节全匹配 + 指针参数安全」的 pattern。
pattern 是一串十六进制半字节，**同一个非十六进制字母连续出现**表示一个变长参数；
参数类型来自 `[XXXX:TYPE:name]`。

关键的 LOAD 指令（`event_FE8.txt`）：

| pattern | 指令 | 含义 |
|---|---|---|
| `402C....` | **LOAD1** | 招募入队（仲間にする）★ 用它定「加入章节」 |
| `402C0000XXXXXXXX` | LOAD1 变体 | 不载入已阵亡单位 |
| `412C....` | LOAD2 | 载入已在队成员（过场用） |
| `422C....` | LOAD3 | 过场演出 |
| `40050200....` | 増援分岐 | 也是 `POINTER_UNIT`，但指向**敌方**块 |

> ⚠️ **`40050200....` 陷阱**：它同样携带 `POINTER_UNIT` 参数，会被天真实现当成招募。
> `cli/src/tables/chapters.ts` 的 `classifyUnitArg` 只看 **`0x2C` opcode**，
> 并把前导字节分类：`0x40`→`recruit`、`0x41`→`load`、`0x42`→`cutscene`，其余 `other`（丢弃）。
> 实测过滤后：**330 条 LOAD** = 192 条 `recruit` + 138 条 `load`，另有 6 条 `cutscene`
> （`cutscene` 不计入 LOAD 统计 —— 校验里的 `330` 就是 recruit+load）。

#### 3.11.5 第二个有意偏差：职业覆盖规则

初始配置记录 `+0` 是 `unitId`、`+1` 是 `classId`。**hack 作者会拿同一个 unitId 当通用模板**：
实测有 583/683 条记录是「角色 2 / 职业 13」这类泛型填充。

**对策**：只有当 `classId === 0 || classId === 自己职业` 时，才把这条记录算作**该角色本人**出场。
否则计入 `classOverriddenPlacements`（不丢弃，只是不归因到具名角色）。

#### 3.11.6 各版本常量

| 版本 | `map_setting` 候选槽 | 记录长 | plist 位置 | 事件槽 | plist 上限 | cond 长(TURN/TALK) | unit 长 |
|---|---|---|---|---|---|---|---|
| FE8U | `0x0B5F98,0x0B61C0,0x0B6328,0x0B6500,0x03462C,0xB5E68` | 148 | 116 | `0x0346DC` | `0xEC` | 12 / 16 | 20 |
| FE8J | `0x0BAB1C,0x34534,0xBA9EC,0xBAD44,0xBAEAC` | 148 | 116 | `0x0345E4` | `0xEB` | 12 / 16 | 20 |
| FE7U | `0x31580` | 152 | 120 | `0x315D4` | `0xF7` | 16 / 16 | 16 |
| FE7J | `0x31A6C` | 148 | 116 | `0x031B18` | `0xFC` | 16 / 16 | 16 |
| FE6J | `0x2BB20` | 72 | 58 | `0x02BBCC` | `0xE5` | 12 / 12 | 16 |

> FE7U 常量已核实但**未在真实 ROM 上验证**（见 §1 进度表）。FE7J/FE8J/FE6J 同理。

#### 3.11.7 实测结论（`fixtures/dream-of-five.gba`）

- 地图设置表 `0x8B0890`，**79 条**（结构扫描）。
- **79 条不是 79 章**：**51 条**有真标题、**20 条**未使用（标题空、章号 0）、
  **8 条**是世界地图遭遇图（标题 `@001F`，章号与 `C15`–`C21` 重复）。
  章号（`+0x80/2`）最大 **27.5**（`Postscript`），单周目剧情章约 **30 张图**。
- 76/76 个带事件 plist 的章节都解析到了条件表；76/76 个初始配置块都在 `u8 == 0` 处正常终止。
- 事件反汇编器找到 **330 条 LOAD**（192 recruit + 138 load），另有 6 条 cutscene。
  初始配置块另有 100 个出场位；`placementsExamined` 683，其中 583 被判定为职业覆盖泛型。
- **62/62 个有支援数据的角色都有章节证据**；60 个有 `LOAD1` 或初始配置。
  - Amaryl（#53）**只有一条 `LOAD2`**（`C26`，章号 26），**无 `LOAD1`** → 加入章节未知。
  - Annelise（#21）/ Stolypin（#32）的 `LOAD1` 落在**索引 60** —— 一个章号 0、无标题的
    Lv20 沙盒图（34 个初始单位、任意职业覆盖）→ **这两条加入记录不可信**。
- 加入顺序按章号单调递增，合理。默认视图 62 行里有 **10 行带 `note`**：
  - **9 例「`LOAD2` 早于加入」**（Eudira / se'Mori / Kahn / Nari / Sileth / Kai /
    Claudiya / Annelise / Stolypin）—— hack 在招募前就预载了该角色，**不是解析错误**。
  - **1 例「只有 `LOAD2`、没有 `LOAD1`」**（Amaryl，#53）。
- **「招募空窗」的正确量级**：最大空窗是 `C14A`（A 线，1 章）或 `C13B`+`C14B`（B 线，2 章），
  终盘另有 `C22`–`C24`（3 章）。**不要**按表索引算，那样会数到「11 章」（其中 8 条是遭遇图）。

#### 3.11.8 OBJECT 槽（slot 2）：宝箱 / 村庄 / 门 / 制圧点 / 商店 ⭐⭐

**这五种地图交互物是同一个 12 字节记录**，全部挂在条件表的 `OBJECT` 槽（索引 2）后面。
判据是记录开头的 `発生タイプ`（`+0`），`u32(+0) == 0` 表示表结束。

字段名逐字来自 `EventCondForm.Designer.cs` 的控件名（`OBJECT_Nxx_*`，见 §2.4）——
控件名里的 `N05`/`N06`/`N07`/`N08`/`N0A` **就是 `発生タイプ` 的值**：

| `+0` 発生タイプ | 含义 | `+4` 是什么 | 出处 |
|---|---|---|---|
| `0x05` | 制圧ポイントと民家 | 事件脚本指针（`p32`） | `OBJECT_UNIONTAB_N05` |
| `0x06` | 訪問村 | 事件脚本指针（`p32`） | `OBJECT_UNIONTAB_N06` |
| `0x07` | 宝箱 | **物品 ID（u8）** —— `0x77` = 金币 | `OBJECT_N07_J_4_ITEM` =「宝箱の中身」 |
| `0x08` | 扉 | 事件脚本指针（`p32`） | `OBJECT_UNIONTAB_N08` |
| `0x0A` | 店 | **商品条目表指针（`p32`）** | `OBJECT_N0A_J_4_ITEMSHOP` =「店の売り物」 |

通用字段（各类型都有）：

| 偏移 | 类型 | 含义 | 控件名 |
|---|---|---|---|
| `+0` | u8 | 発生タイプ | `OBJECT_J_0` =「発生タイプ」 |
| `+2` | u8 | 達成フラグ（触发标记） | `OBJECT_Nxx_J_2_FLAG` =「達成フラグ」 |
| `+4` | p32 / u8 | 重载字段，见上表 | `OBJECT_Nxx_J_4_*` |
| `+6` | u16 | **金币金额（仅宝箱用）** | `OBJECT_N07_J_6` + 标签「ゴールド」 |
| `+8` / `+9` | u8 ×2 | 地图坐标 x / y | `OBJECT_Nxx_L_8_MAPXY_9` =「座標」 |
| `+10` | u8 | 種類（宝箱/店各有含义：`店の種類`） | `OBJECT_Nxx_J_10` |

⚠️ **金箱的不变式**：`発生タイプ == 0x07` 且 `+4 == 0x77` 时，金额才在 `+6`（u16）。
否则 `+4` 是普通物品 ID、`+6` 应为 0。DoF 的 57 个宝箱**全部满足**
「要么 `+4 == 0x77` 且金额 > 0，要么 `+4` 是真物品且金额 == 0」—— 这条已进 `validate`。

⚠️ **商店的 `種類`（`+10`）取值是 `0x16 / 0x17 / 0x18`**（DoF 实测 33 个商店记录），
不要和 `発生タイプ`（`0x0A`）搞混 —— 前者是「店卖什么档次」，后者是「这是个店」。

**代码位置**：`cli/src/tables/mapObjects.ts`（记录解析）、`cli/src/tables/shops.ts`（条目表）。
`EventCondForm.cs:876` 读 `p32(addr + 4)` 作商店指针、`:882` 读 `u8(addr + 10)` 作店种类。

---

### 3.12 地形名表 —— `map_terrain_name_pointer` ⭐

**地形名和移动消耗用的是同一套 id（`0..0x40`，共 65 条）。**
`MoveCostForm` 用它给 `J_0..J_64` 这 65 个消耗列贴标签，`MapEditorForm.cs:664/753`
用它显示光标下的格子名。所以职业记录 `+56` 那张消耗表（§3.4.1）的第 *n* 项，
就是这张表的第 *n* 条。

**指针槽**（`ROMFE8U.cs:79` 等，注释都是「マップの地名表記の開始位置」）：

| FE6J | FE7J | FE7U | FE8J | FE8U |
|---|---|---|---|---|
| `0x192C0` | `0x19EFC` | `0x19B1C` | `0x19F24` | `0x1A254` |

**两种存储形态 —— 靠 `RomInfo.is_multibyte` 分岔，不能混用**：

| 版本 | 步长 | 每条内容 | 终止条件 | 读法 |
|---|---|---|---|---|
| 日文版（`is_multibyte = true`） | 4 | 指向**裸字符串**的 GBA 指针 | `!U.isPointerOrNULL(u32(a))` | `ROM.getString(p32(a))`，**不过 Huffman** |
| 英文版（`is_multibyte = false`） | 2 | **文本 id** | `u16(a) == 0` | 走正常 Huffman 文本表 |

`MapTerrainNameForm.MakeList()/GetName()` 第一件事就是
`if (!RomInfo.is_multibyte) return MapTerrainNameEngForm....`，所以 FE8U / FE7U
（`ROMFE8U.cs:460` / `ROMFE7U.cs:451` 都是 `is_multibyte = false`）走第二条。

**名字要过 `TextForm.StripAllCode`**（`TextForm.cs:1262`）：删掉 `@XXXX` 控制码并 trim。
不过这一步只有英文版会做，日文版直接返回原串。

**实测（`fixtures/dream-of-five.gba`）**：槽 `0x1A254` → 表 `0x80D374`，65 条，
**62 条有名字**（`0x00` / `0x2C` / `0x2E` 无名）：

```
0x01 Plain   0x03 Village  0x06 Armoury  0x08 Arena   0x0A Fort    0x0B Gate
0x0C Forest  0x0E Sand     0x11 Mntn     0x12 Peak    0x15 Sea     0x16 Lake
0x17 Floor   0x18 Runes    0x1F Throne   0x20 Chest   0x25 Ruins   0x27 Ballista
0x2F Glacier 0x33 Snag     0x35 Sky      0x36 Deeps   0x40 Mast
```

---

### 3.13 反汇编 ROM 自己的代码 —— 参考代码解释不了时的终审法官 ⭐⭐⭐

**当「这个字段到底怎么用」参考代码答不上来时，ROM 里有答案：ROM 自己带着代码。**

这条链路的两个前提，**两样都已经在仓库里**：

1. **符号表。** `FEBuilderGBA/bin/Debug/config/data/asmmap_<game>.txt`（也有 `.en` / `.zh` 变体）
   是**原版**的函数名 → 地址映射。格式是 tab 分隔的 `地址<TAB>名字<TAB>说明…`：

   ```
   0802852C	GetSupportBonusEntryPtr	{U}
   08028550	StoreAddedAffinityBonusesForSupportLevel	{U}
   080285B0	GetUnitSupportBonuses	{U}
   ```

   `{U}` = 美版，`{J}` = 日版。**这等于给原版 ROM 附了一份带注释的反汇编清单**，
   而且这个 hack 保留了原版的代码布局，所以符号表直接可用。

2. **反汇编器。** 需要能解 Thumb。`objdump`（本机是 LLVM 21）**不支持裸二进制**
   （`-b binary` 是 GNU 专属参数），所以用 Python 的 `capstone`：

   ```bash
   /Users/woxqaq/.workbuddy-ai/binaries/python/versions/3.13.12/bin/python3 \
     -m venv /Users/woxqaq/.workbuddy-ai/binaries/python/envs/default
   /Users/woxqaq/.workbuddy-ai/binaries/python/envs/default/bin/pip install capstone
   ```

   然后切一段 ROM 出来解：

   ```python
   from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_LITTLE_ENDIAN
   data = open(rom, 'rb').read()[start:end]
   for i in Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_LITTLE_ENDIAN).disasm(data, 0x08000000 + start):
       print(f"{i.address:08X}  {' '.join(f'{b:02x}' for b in i.bytes):<12} {i.mnemonic:<8} {i.op_str}")
   ```

**工作流**：`grep -i <关键词> asmmap_FE8.txt` 找符号 → 从符号表读出地址 → 反汇编该地址
到下个符号 → 读寄存器流。**不要试图反汇编整个 ROM**，按符号切是最省力的。

#### 3.13.1 实测收获：支援系统的全部算术

`grep -i support asmmap_FE8.txt` 直接给出整条函数链（`GetSupportLevelBySupportIndex`
/ `GetSupportBonusEntryPtr` / `StoreAddedAffinityBonusesForSupportLevel`
/ `GetUnitSupportBonuses` / `ProcessTurnSupportExp` …），反汇编后得到：

| 结论 | 证据（反汇编片段） |
|---|---|
| 表步长 8、按 `u8(a)==相性` 匹配、`u8(a)==0` 终止 | `adds r2,#8` / `cmp r1,r3` / `cmp r1,#0` |
| **`support_attribute_pointer` 这个「槽」就是函数字面量池里的那个字** | `ldr r2,[pc,#0]` 落在 `0x28534`，字面量 `0x088B05F8` |
| 加成 = `存值 × level`，level ∈ {0,1,2,3} | `ldrb r1,[r0,#1]` + `muls r1,r5,r1` |
| **六项各 `>>1`，只除一次** | 函数末尾 6 组 `ldrb`/`lsrs #1`/`strb` |
| 门槛 `>0x50→C, >0xA0→B, >0xF0→A` | `GetSupportLevelBySupportIndex` 的 3 个 `cmp` |
| 距离判据是 `|dx|+|dy|`（曼哈顿） | `subs`+`abs`+`adds r0,r1,r0`+`cmp r0,#3` |
| 只写偏移 1–6，**偏移 7 从不被读** | `StoreAdded` 里只有 `#1`–`#6` 六组 |

> ⚠️ **`support_attribute_pointer = 0x28534` 是「函数内字面量池的地址」** ——
> 这是 §2.2「指针槽」规则的一个极端例子：槽位可以落在**代码段**里。
> 所以「槽位偏移」和「表偏移」之间没有任何地址上的规律可循，只能靠反汇编确认。

> ⚠️ 反汇编出的是**本 ROM** 的代码，比反编译源码更权威（源码可能对应别的版本）。
> 但两者能互相印证：本节的每条结论都同时在
> `FireEmblemUniverse/fireemblem8u` 的 `src/bmreliance.c` + `include/bmreliance.h`
> 里有对应实现，且数值完全一致。

#### 3.13.2 反编译源码是第二意见（只在需要字段名时用）

`asmmap` 给的是**函数名**，不给**结构体字段名**。字节布局本身说明不了
「偏移 4 是回避还是必杀回避」，这时去查反编译源码的头文件：

| 想要 | 文件（`FireEmblemUniverse/fireemblem8u`） |
|---|---|
| 支援系统结构体与常量 | `include/bmreliance.h` |
| 支援系统实现 | `src/bmreliance.c` |

**注意 FE8 反编译把 support 叫 `reliance`**（`gSupportData` / `gAffinityBonuses` /
`GetUnitSupportBonuses`），`grep support` 在 include 目录里是搜不到的 —— 要找
`bmreliance.h`。头文件给出的关键定义：

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

> **`struct SupportData` 是 22 字节（`0x00..0x15`），但本 ROM 的记录按 0x18 对齐。**
> 读表用 0x18 步长（实测 62 条、61 个间隔全是 0x18），字段偏移用上表。
> 两者都对 —— 一个是结构体大小，一个是分配步长。

**独立交叉验证（`terrain.idAlignment` 检查）**：拿 `0x12`（Peak，飞行专属地形）当判据。
实测 **17 个飞行职业能踩、95 个地面职业不能踩**，例外只有
`Thug` / `Berserker` / 2 个 `Dragon`（这个 hack 里山贼系与怪物确实能踩 Peak）。
**两套 id 对得上**，所以给消耗表贴名字是安全的。

> **这只是标签，不是机制。** 地形的回避/防御/魔防修正在职业记录的
> `+68` / `+72` / `+76` 三个指针里（§3.4），已接入 —— `UnitClass.terrainBonuses`
> 给出 `{ avoid, def, res }` 三张 65 项表，`terrainBonusImmune` 标记三项全 0 的职业。

> 来源：`MapTerrainNameForm.cs` / `MapTerrainNameEngForm.cs`（`Init()` 的步长、终止条件、`GetName()`）。

---

### 3.14 强制出击表 + 编队人数 ⭐⭐

「这一章能带几个人上场、谁必须上」是阵容分析的前置条件。**两张表，一条链路。**

#### 3.14.1 编队人数 = 初始配置块的条数

**不需要新表。** 每章能出击的人数就是 §3.11.3 那个初始配置块（condition slot 10）的
**记录条数** —— 游戏自己的 `GetChapterAllyUnitCount`（`0x08012344`）就是数它，
一格一条 20 字节记录，读到 `u8(+0) == 0` 为止。`cli` 里叫 `Chapter.deploySlots`。

难度分开时游戏换用 slot 11 的块 → `Chapter.deploySlotsHard`
（本 ROM 只有 C10B 两者不同：12 → 9）。

⚠️ **未使用的槽位不是空的，而是填了一条模板记录**：同一个 `unitId` 配一个当章的 `classId`。
本 ROM 683 条配置记录里有 **534 条**是这种填充（C1 是 `unit 2 / Thief` ×6、
C11A 是 `unit 2 / class 9` ×12、C20 是 `unit 2 / class 53` ×16）。
**所以「数条数」是对的，「数名字」会数出 12 个同一角色。**

#### 3.14.2 强制出击表 —— `event_force_sortie_pointer`

FEBuilderGBA 的编辑器是 `EventForceSortieForm`（提示语「必ず出撃しなければいけないユニットを設定します」），
指针槽见 `ROMFE8U.cs:95`：

| 版本 | 槽 | 记录大小 | 终止 |
|---|---|---|---|
| FE8U | `0x8483C` | 4 | `u16(+0) == 0xFFFF` |
| FE8J | `0x86B08` | 4 | 同上 |
| FE7U | `0x8DDCC` | 4 | **定长 23 条**（无终止符，`mapId = 0x17 + i`） |
| FE7J | `0x8E6F8` | 4 | 同 FE7U |
| FE6J | `0` | — | 无此表 |

**参考程序的 `Init()` 只暴露两个字段**（`u16(+0)` 和 `u8(+3)`），中间那个字节必须反汇编才拿得到。
`IsCharacterForceDeployed`（`0x080953F0`）尾调用 **`IsCharacterForceDeployed_`（`0x08084800`）**：

```asm
08084802  lsls r0, r0, #0x10
08084804  lsrs r4, r0, #0x10      ; r4 = 被测试的 unitId
08084806  ldr  r2, [pc, #0x34]    ; r2 = 表（槽已解引用）    → 0x1C099D0
08084808  ldrh r0, [r2]           ; +0  unitId
0808480A  ldr  r1, [pc, #0x34]    ; r1 = 0xFFFF
0808480C  cmp  r0, r1
0808480E  beq  -> return 0        ;    表尾
08084810  ldr  r3, [pc, #0x30]    ; r3 = @ChapterData (0x0202BCF0)
08084814  ldrb r0, [r2, #2]       ; +2  route 过滤器
08084816  cmp  r0, #0xff
08084818  beq  -> 跳过 route 判定 ;     0xFF = 不限
0808481A  ldrb r1, [r3, #0x1b]    ;     ChapterData+0x1B = 編指定
0808481C  cmp  r0, r1
0808481E  bne  -> 下一条
08084820  ldrb r0, [r2, #3]       ; +3  mapId 过滤器
08084822  cmp  r0, #0xff
08084824  beq  -> 跳过 map 判定   ;     0xFF = 不限
08084826  movs r0, #0xe
0808482A  ldrsb r0, [r3, r0]      ;     ChapterData+0x0E = マップID
0808482C  cmp  r1, r0
0808482E  bne  -> 下一条
08084830  ldrh r0, [r2]           ;     unitId 也要对上
08084832  cmp  r4, r0
08084834  bne  -> 下一条
08084836  movs r0, #1              ;     必上
...
08084848  adds r2, #4              ; 下一条：步进 4
0808484A  ldrh r0, [r2]
0808484C  cmp  r0, r5              ; r5 = 0xFFFF
0808484E  bne  -> 0x0808480C
```

**记录格式：`u16 unitId` / `u8 route` / `u8 mapId`，两个过滤器 `0xFF` 都表示「不限」，
三个条件全中才算必上。** `mapId` 是**地图设置索引**（`EventForceSortieForm` 自己把它交给
`MapSettingForm.GetMapNameAndANYFF`）。

#### 3.14.3 ⚠️ `route` 字节静态判不了

它比的是 `ChapterData + 0x1B`，**那是 RAM 里的值**。原版取值已钉死：

| 值 | 含义 | 谁写它 |
|---|---|---|
| `0x01` | 序盤 | 初始值 |
| `0x02` | E 編 | `Command_EirikaMode`（`0x08086564`） |
| `0x03` | F 編 | `Command_EphraimMode`（`0x08086580`） |

（`asmmap_FE8.txt` 的 `@ChapterData@1B byte 編指定 序盤=0x1,A編=0x2,F編=0x3`；
两个函数各只有一处引用，都在 `0x9F3634` 的分线选单表里。）

**本 ROM 28 条记录里 14 条带 route 过滤，其中 12 条是 `0x01`，而它们指向的地图横跨
分线前 / A 线 / B 线 / 合流后** —— 所以 `0x01` 在这里要么是惰性的，要么那些记录根本不生效。
**静态无法分辨，`cli` 的做法是：不过滤，原样报出 `routeFilter`，让调用方自己判断。**

#### 3.14.4 实测（`fixtures/dream-of-five.gba`）

- 表在 `0x1C099D0`，**28 条 × 4 字节**，13 个唯一单位
- **Rena 全程必上**（2 条 `map = 0xFF`，route `0x01` / `0x02`）
- **Arcus 8 章**（A 线中段 7 章 + C25）、**se'Mori 7 章**（B 线中段全部）
- 其余 10 人各 1–2 章（C6x 的 Garath/Marie、C15 的 Severin/Stolypin、C17x 的 Annelise/Thyra、C20 的 Sheila…）
- 45 张单周目剧情图：**槽位中位数 12、最多 18（C20 / C25）、最少 1，合计 522 格**
- **C6x 是 3 格 3 必上 → 0 自由位**；Postscript / C23x 只有 1 格（单人剧情图）

**交叉验证（已进 `validate`）**：每条指名某张图的强制出击记录，其单位都应出现在那张图的
配置块里 —— **26 条里 24 条命中**，例外是 C15 的 Severin / Stolypin（靠开场事件入场，不预置）。

> 来源：`ROMFE8U.cs:95`、`EventForceSortieForm.cs`、`asmmap_FE8.txt`（`IsCharacterForceDeployed_` /
> `@ChapterData@1B` / `Command_EirikaMode` / `Command_EphraimMode`）。
> 实现：`cli/src/tables/forceSortie.ts`（`readForceSortie` / `forcedUnitsForMap` / `alwaysForcedUnits`）。

---

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

### 3.16 DoF 的战役结构（分析层结论）⭐

**这一节不是 ROM 解析，是 `cli/scripts/training-plan.ts` 与 `dream-of-five.analysis.md` 得出的
结论。** 它们回答「练哪些人、支援怎么配」，判断依据都是 §3.11 / §3.14 的解析结果。

#### 3.16.1 分线游戏 —— 中段两条线角色完全不同

| 段 | 章节索引 | 人数 |
|---|---|---|
| 分线前 | 0–8（P…C6x） | 21 |
| **A 线** | 9–17（C7A…C14A + C8x） | 9 |
| **B 线** | 19–27（C7B…C14B + C10x） | 12 |
| 合流后 | 36–50（C15…C26） | 16 |

索引 18 = `Crossroads`（章号 6.5）= 分线点；28–35 是 `@001F` 遭遇图。
**单周目 ≈ 34 张图；单周目角色 A 线 46 / B 线 49。**

**三条推论（已验证）：**

1. **96 条支援边里 0 条跨线** —— 支援网按路线切干净。**支援规划必须先定线。**
2. **3 对开局白送的支援全锁在 A 线**（`Franseza×Seren` 241、`Lyndra×Morwen` 161、
   `Stolypin×Rotariu` 200 但加入点不可信）。**B 线没有开局支援。**
3. 分线前只有 2 个杖，**Lizaveta 只有 D 级杖(31)**，第二治疗要等 A 线 C11A/C12A 或 B 线 C9B。
   （原写「A 线 C7–C14 全程没有新飞行」**已被 Annelise 推翻**，见 §3.16.3。）

**⚠️ 两条陷阱：**

- **分组必须用 `mapIndex`，不能用 `chapterNumber`** —— 章号在两条线上重复
  （C6x / C7A / C7B 都是 7）。章节对象的索引字段叫 **`mapIndex`**（不叫 `index`）。
- **可玩名单三口径**：255 槽位 → **62** 带支援数据 → **61** 有实际伙伴 → 剔除
  **Rophon(#38)**（成长 1111、0 伙伴，调试单位）。

#### 3.16.2 分阶段自由位（= 槽位 − 必上）—— 回答「练谁」的真正约束

| 阶段 | 图数 | 槽位 | 自由位 | 自由位/图 |
|---|---|---|---|---|
| 分线前 P–C6x | 9 | 69 | **58** | 6.4 |
| 分线点 Crossroads | 1 | 12 | 11 | 11.0 |
| A 线中段 C7A–C14A | 9 | 106 | 87 | 9.7 |
| B 线中段 C7B–C14B | 9 | 117 | 100 | 11.1 |
| 合流 C15–C21 | 8 | 102 | 89 / 90 | 11.1 |
| 终盘 C22–Postscript | 8 | 100 | 91 | 11.4 |
| **合计** | **35** | **389 / 400** | **336 / 350** | |

→ **分线前 9 图只有 58 格要分给 21 人（平均 2.8 章）→ 必须只重点练 8–10 个。**
→ 终盘 16 格 vs 49–51 人可用，最后阵容只装得下名单的 1/3。

**训练计划模型**（`cli/scripts/training-plan.ts`，读 `cli/out/*.json`，**不重新解析 ROM**；
`--route=A|B`、`--json` → `cli/out/dream-of-five.training-plan.md`）：
窗口（可出场章数）/ 预期（均匀轮换出场章数）/ 练满（满勤终盘五维和）/ 空间（练满 − 当前）/
⭐独占（有几章是全场唯一承担该职能的人，只看杖·飞行·重甲·再动·盗贼）。
**评分权重是拍的，报告里明说「优先看原始列」。**

#### 3.16.3 ⚠️ 加入点的可用性回退规则（值得复用）

```
joinChapter < 55 且非 null → 可信，直接用
否则 ① earliestEvidenceChapter（placement/recruit/load/cutscene）
     ② min(①, 最早必上章)   ← 强制出击是**硬下界**：能被点名必上 = 必然已加入
     都没有 → 保守当作「终盘前不可得」
```

- **Annelise** → 索引 14（C11A）。**她推翻了「A 线 C7–C14 全程没有新飞行」**
  （`recruit` 指向无标题 map#60 不可信，但 note 明说她被 `load` 在 C11A）。
- **Stolypin** → 36（C15 必上下界）；**Amaryl** → 50（C26）—— 她**没有 `recruit` 指令**，
  只在 C26 被 `load`，窗口只有 3 章。

#### 3.16.4 其他可复用结论

- **转职状态可从 `caps` 反推**：本 hack 未转职职业 `str/skl/spd/def` 上限一律 **20**，
  转职职业 **≥25**。`caps.str >= 25` 即 `isPromoted`。
- **`classes.json` 的对象 key 不是 class id**（`classes['2']` 的 `id` 是 3）。
  必须 `Object.values(C).find(c => c.id === classId)`，否则职业全查错一位。
- **合流后 16 人里只有 Dismas（成长 425）/ Jauger（420）值得喂**；**Sheila**（五维 100 +
  飞行 + S 枪）是这批唯一「必拿」。
- **B 线中段职能比 A 线均衡**：C9B 一次性到货 7 人（Wren=B杖、Bellona=飞龙、Leda=舞者）；
  A 线要到 C11A/C12A 才有 Severin/Meliza。**Arcus 只在 A 线是准常驻**（A 中段 8 章 / B 仅 1 章）。
- **武器等级数值 → 等级**：`1–30 E / 31–70 D / 71–120 C / 121–180 B / 181–250 A / 251 S`
- **相性配对加成**（两人都 A）= `floor((rawA + rawB) × 3 / 2)`，用原始半点值 →
  `atk` 恒 +3、`critAvoid` 恒 +15；`def` 只有 Thunder/Ice/Anima 给。
  相性名硬编码在 `InputFormRef.cs:7006`（1炎 2雷 3風 4氷 5闇 6光 7理）。
- **产物**：`cli/out/dream-of-five.analysis.md`（v3）+ `dream-of-five.training-plan.md`
  + `dream-of-five.*.json`

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

`FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/` 下有两个 `#ENGINE` 补丁，它们**直接标出了代码地址**：

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

## 3.19 敌人摆放 —— FE8 没有「敌人表」，敌人在同一个配置记录里 ⭐⭐

**一句话结论**：FE8 **没有**一张「敌人摆放表」。玩家、友军、敌人用的是**同一种 20 字节记录**，
是不是敌人由记录自己 `+3` 字节里的 **2 个 bit** 决定；而记录块由**事件脚本**引用。
所以「敌人在哪」= 「顺着脚本走，读每条记录的阵营位」。

### 3.19.1 记录格式（FE8U 20 字节；FE6/FE7 是 16）

`ROMFE8U.cs:261` `eventunit_data_size = 20`。读入规则照抄 `EventUnitForm.Init`
（`EventUnitForm.cs:147-178`）：定长 20 字节，扫到 `u8(+0) == 0` 终止。

| 偏移 | 宽 | 控件 | 含义 |
|---|---|---|---|
| `+0` | u8 | `B0` | ユニットID（**0 = 终止**） |
| `+1` | u8 | `B1` | クラスID（**0 = 用该角色自己的职业**） |
| `+2` | u8 | `B2` | このユニットが行動し終わった後に行動するユニット |
| `+3` | u8 | `B3` | **`UNITGROW` 位域 —— 见 3.19.2** |
| `+4` | u16 | `W4` | 配置前座標（FE8 打包 `x&#124;y<<6&#124;ext<<12`，`U.MakeFe8UnitPos`） |
| `+6` | u8 | — | （`W4` 的高字节之后） |
| `+7` | u8 | `B7` | 配置後座標の件数 |
| `+8` | p32 | `P8` | 配置後座標の配列（8 字节/条：`pos u16, speed u8, unitid u8, unk u8×2, wait u16`） |
| `+12..15` | u8×4 | — | 所持道具 1–4 |

⚠️ **`+3` 是 u8，不是 u16** —— `+4` 就是座標。参考代码里 `InputFormRef.Init`
（`EventUnitForm.cs:166`）写成 `u16(addr+3)`，`EventUnitForm.cs:501` 又写 `u8(addr+3)`；
按 u16 读会把两个字段混在一起（`(x>>3)&0x1f` 恰好还对，但原始值是脏的）。
CLI 取 u8。

### 3.19.2 `+3` 位域 = 「这单位是谁的」

`InputFormRef.cs:993-1094`（`linktype == "UNITGROW"`）是**逐字节的读改写实现**，
下拉项名字在 `EventUnitForm.Designer.cs:1259-1263 / 1274-1276 / 1309-1313`：

| 位 | 掩码 | 控件 | 取值 |
|---|---|---|---|
| 0 | `& 0x01` | `L_3_UNITGROW_GROW` | 0 = 成長させない / 1 = クラス依存（自动升级模式） |
| 1–2 | `>>1 & 0x3` | `L_3_UNITGROW_ASSIGN` | **0 自軍 / 1 友軍 / 2 敵軍 / 3 消滅** |
| 3–7 | `>>3 & 0x1F` | `L_3_UNITGROW_LV` | レベル |

对应 `U.ParseUnitGrowAssign`（`U.cs:1730`）、`U.ParseUnitGrowLV`（`U.cs:1734`）。
CLI 侧：`PlacedUnit.side` / `.assign` / `.autolevel`（`chapters.ts`）。

> `assign == 3`（消滅）不是阵营 —— 是「地图载入时把这个单位删掉」，等待图标画成灰色
> （`ImageUnitWaitIconFrom.cs:173-176`）。`assign == 0` 配 `palette_type` 走自軍调色板。

### 3.19.3 块由**事件脚本**引用（没有别的入口）

带 `POINTER_UNIT` 参数的指令（`config/data/event_FE8.txt`，共 5 类）：

| 指令形态 | 名字 | 典型用途 |
|---|---|---|
| `402C0100XXXXXXXX20300000` / `402C0000XXXXXXXX` | LOAD1（`@LOAD1`） | **招募** + **章节初始敌人** |
| `412C0100XXXXXXXX`（`20300000`） | LOAD2（`@LOAD2`） | 读入既有成员 / 开局重放自军块 |
| `422C0000XXXXXXXX` | LOAD3（`@LOAD3`） | 过场专用 |
| `40050200XXXXXXXX400A0000…` | 増援 | **增援**（多数是敌人） |
| `40050200XXXXXXXX4005030001000000400A0000…` | 増援（普通以上） | 仅普通及以上难度 |
| `40050200XXXXXXXX40050300ZZZZZZZZ40050400WWWWWWWW400A0000YYYYYYYY` | ユニット設定付き特殊イベント | 一次最多 3 块 |

ROM 自己的处理器：**`Event2C_LoadUnits @ 0x0800FB84`**（事件 opcode `2C`）。
它按 `(指令描述符)[0] & 0xF` 分派：`0/2` 用描述符 `+4` 的指针，`1` 走 `r8=2` 分支，
**`3` → `bl GetChapterEnemyUnitDefinitions`**。

⭐ **DoF 实测：完全不用「簡単/普通以上」双指针形态**（`40050200 <ptr> 40050300 <ptr>`，
带指针校验的字节扫描 = **0 例**；单指针 247 例）。所以反汇编器不会漏读「簡単」那块。
DoF 的双指针只有 3 处「普通以上」，三指针 1 处。

### 3.19.4 章节的初始敌人在哪 → **START_EVENT（槽 18）**

条件表 20 槽里 **FE8 没有 `ENEMY_UNIT`**（`eventcond_FE8.txt`；FE7 才有，槽 6–9，FE6 在槽 5）。
FE8 的常规章节初始敌人靠**章开始事件**用 `402C0100` 摆进去。DoF 实测：

- **槽 0 TURN** 223 块 —— 增援
- **槽 18 START_EVENT** 209 块 —— 初始敌人 + 招募
- **槽 2 OBJECT** 25 / **槽 3 ALWAYS** 18 —— 事件触发式
- **槽 19 END_EVENT** 27 —— 收尾

### 3.19.5 ⭐ ROM 侧访问器（决定性证据）

| 函数 | 地址 | 读哪 |
|---|---|---|
| `GetChapterAllyUnitDataPointer` | `0x08083348` | 条件表 `+0x28`（槽 10）；`gChapterData[0x14] & 0x40`（**hard mode**）时读 `+0x2c`（槽 11）；魔物图读 `+0x30/0x34/0x38`（槽 12–14） |
| `GetChapterEnemyUnitDefinitions` | `0x080833B0` | `+0x3c/0x40/0x44` = **槽 15/16/17 = `FREEMAP_ENEMY_UNIT`** |
| `GetChapterAllyUnitCount` | `0x08012344` | `GetChapterAllyUnitDataPointer()` 后按 20 字节步长数到 `u8(+0)==0`，**不过滤阵营** |

⚠️ **`GetChapterEnemyUnitDefinitions` 不是「常规章节敌人表」** —— 它只读魔物图那三个槽。
`0202BCF0 = @ChapterData`，`@ChapterData@0E` = マップID，`@ChapterData@14 & 0x40 = Set for hard mode`
（符号表里逐字写着）。`GetChapterEventDataPointer @ 0x080346B0` 就是拿 mapId 取条件表。

### 3.19.6 实测普查（`cli/scripts/unit-placement-census.ts`）

DoF：**502 个块**、**2723 条敌人记录**、88 个敌人职业、等级 0–20（均值 9.7）。
自检全绿：0 个空块 / 0 个职业 id 落在职业表外 / 0 个 `unitId==0` / 0 个非敌人记录 lv>20 /
槽 10 里 0 条非自军。**这条链是通的，敌人属性可以开始算。**

### 3.19.7 ⚠️ 两个真发现（别当成 bug 去"修"）

**① `mapIndex 22`（C10B: Needle's Eye）是全 ROM 唯一 `槽11 ≠ 槽10` 的章节。**
槽 10 = 12 条自军；槽 11 = **9 条全是友軍**。因为 `GetChapterAllyUnitCount` 不过滤阵营，
hard 模式 `deploySlotsHard` **真的是 9**。而那 9 条**同时被 start event 用 `402C0100`
（`0x14c2128`）加载**，所以绿军本来就会出场 —— 可疑的只是「出击位数量」。
**上机核实之前不要信这个数**。

**② 11 个章节填了槽 12–17**（魔物遭遇用的 3 套自军 + 3 套敌人，各约 9 条）。
这些是「随机遭遇版」的编成，**不是章节初始敌人**。

### 3.19.8 下一个坑（已经走了 → 见 §3.20）

敌人属性可算，但 **`GetAutoleveledStat` 会烧随机数**（见 §3.18.6）：基准
`成长 × 等级 / 100` 确定，末位有 ±1 随机成分 → 输出应是区间，不是定值。
而且**敌方装备**在记录 `+12..15`，武器重量/攻速要接道具表。
**§3.20 把这条链走完了。**

---

## 3.20 敌人属性投影 —— 从配置记录到攻速 ⭐⭐

§3.19 解决了「敌人在哪」；这一节解决「敌人多快」。产物是 CLI 命令
**`enemy-stats`**（`src/analysis/enemyStats.ts`），经济报告的参考敌攻速就是它给的。

### 3.20.1 公式与四项来源

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

### 3.20.2 ⭐⭐ 自动升级的总开关 = `+3` bit 0

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

### 3.20.3 ⭐ 两条自动升级路径，分派在 `0x08017C36`

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

### 3.20.4 `AutolevelUnit @ 0x08018120` 逐行

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

### 3.20.5 `AutolevelRealistic @ 0x08018160`

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

### 3.20.6 `GetAutoleveledStat` 的闭式（会烧随机数）

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

### 3.20.7 转职加成 = 9（普通）/ 19（hard）

`GetCurrentPromotedLevelBonus @ 0x08037B44`：`ldrb r1,[r0,#0x14]; movs r0,#0x40; ands`
—— 即 `gChapterData[0x14] & 0x40`（hard 位）置位返回 **0x13 = 19**，否则 **9**。

### 3.20.8 实测（本 ROM，普通模式）

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

### 3.20.9 口径与残余不确定性

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

### 3.20.10 命令

```bash
node src/index.ts enemy-stats ../fixtures/dream-of-five.gba --compact \
  --out out/dream-of-five.enemy-stats.json      # 普通模式
node src/index.ts enemy-stats ../fixtures/dream-of-five.gba --hard ...   # hard（转职轮 9→19）
```

输出含 `totals` / `overall` / `byRoutine` / `chapters`（逐章分位数 + 逐职业）/
`samples`（逐条记录，供消费方自己按阶段聚合）/ `negativeSamples` / `limitations`。
`validate` 有三条对应检查：`enemy.records` / `enemy.statBand` / `enemy.negativeAs`。

---

## 4. 陷阱清单

### 4.1 file offset vs GBA 地址

代码里 `u8/u16/u32(addr)` 的 `addr` 是 **file offset**；而 `p32()` 读出来的是 **GBA 地址**，必须 `- 0x08000000`。

`U.toOffset()`（`U.cs:2206`）自动做这件事：值 ≥ `0x08000000` 且 < `0x0A000000` 就减基址，否则原样返回。**TS 里要显式实现这个函数**，别假设输入一定是什么。

### 4.2 `RomInfo.*_pointer` 是槽位不是地址

见 §2.2。**每次读表前先 `p32()`。** 例外：以 `_address` 结尾的字段（`max_level_address`、`text_recover_address`、`*_switch*_address` 等）是直接偏移。

### 4.3 一半的字符串是「未压缩」存的 —— 不处理就会莫名读不出名字

**这是最容易踩、也最难自己发现的坑。** 症状很迷惑：一部分角色名读得好好的，
另一部分全是空串，而且空串的记录**别的字段（职业、等级、能力值）全都正常** ——
所以你会以为是文本表本身有洞，而不是解码器缺了一条分支。

根因：文本表条目有两种格式，见 §3.9。打了 un-huffman 补丁的字符串，
指针带 `+0x80000000` 偏移，必须走 `UnHffmanPatchDecode` 而不是 `huffman_decode`。

**一句话判据**：条目值在 `0x88000000..0x8A000000` → 未压缩；在 `0x08000000..0x0A000000` → Huffman。

**验证方法**：
1. 解出角色 ID 1 的名字，看是不是正常角色名。不是 → 文本层有问题，别继续往下做。
2. 统计「非空名字 / 可玩角色数」。原版接近 100%；如果只有一半左右，
   先怀疑这条分支，而不是怀疑文本表。

另外 `PatchUtil.SearchPriorityCode()` 还会检测 UTF-8 补丁（`PriorityCode = UTF8`），
遇到这种 ROM 需要走 `U.AppendUTF8` 分支。目前 CLI 只实现了 LAT1 路径。

### 4.4 支援表没有固定条数、也不按 ID 排序

必须走「角色记录 `+44` → 支援指针」这条路。不要假设表是连续的、也不要假设第 *n* 条属于角色 *n*。

`SupportUnitForm` 的有效性判定还考虑了「飞地」（`SupportUnitForm.cs:76` 附近的注释说支援数据可能是跳着存的），所以遍历整张表要小心。

### 4.5 角色 ID 从 1 开始，职业 ID 从 0 开始

- 角色：ID `n` → 表偏移 `(n-1) * 52`
- 职业：ID `n` → 表偏移 `n * 84`

写代码时最容易在这里差一位。

### 4.6 支援关系是双向冗余存储

A→B 和 B→A 是两条独立记录。分析「支援关系图」时要**去重**，否则每条边会算两次。

### 4.7 `config/data` 在 `bin/Debug` 下，不在源码树的 `config/`

FEBuilderGBA 运行时会读 `config/data/*.txt`（预抽取的名称表、事件 opcode 表、职业特性位名等）。
**源码树里的 `FEBuilderGBA/config/` 确实不存在**，但 `FEBuilderGBA/bin/Debug/config/data/`
一直在（422 个文件）—— 详见 §1.1。

**早期版本在这里下过错误结论**（「仓库里没有这些文件」），导致白白放弃了一整轮功能。
**教训**：断言「某数据不可得」之前，先 `find . -name '<文件名>'` 或 `ls bin/Debug`，
不要只看源码目录。

对我们的 CLI 来说，大部分数据我们从 ROM 里自己解码，**但有三样必须读这些文件**
（见 §1.1 表）：职业特性位名、事件 opcode 表、章节条件槽顺序。

⚠️ **不要直接去读 `FEBuilderGBA/bin/Debug/config/data/`** —— 那会把 CLI 和 C# 仓库耦合。
CLI 只读自己 vendored 的 `cli/data/`（27 个文件的子集）。读取逻辑在 `cli/src/config/data.ts`。

### 4.8 未标注字段不要臆测

§3 里标「（未标注）」的字段，是 C# 侧标签文本就是 `??` 或没有对应标签的。**不要猜它们的含义**，需要时先跑参考程序看它怎么显示。

### 4.9 不要「读满」定长表 —— 表尾后面是别的东西

定长表（职业表、支援加成表等）后面**不是空白填充**，而是链接器紧接着塞进去的其他数据。
如果你按 `maxCount` 硬读到底，就会把那些字节当成记录解析。

实测 `dream-of-five.gba` 的职业表：

| index | `+4` 的值 | 名字 | 判断 |
|---|---|---|---|
| 0–127 | 0–127 | 正常职业名 | ✅ 真实数据 |
| 128+ | 0 或垃圾 | `""` / `"Dark"` / `"Gunnels"` / `"Juna Fruit"` | ❌ 别的数据 |

危害不在于「多读了几条」，而在于**它静默污染映射表**：
如果你用「职业 ID → 名字」建 Map，后读到的垃圾记录会**覆盖**掉前面的正确名字。
症状是某个职业的晋升目标突然变成 `"--"` 或 `"Gunnels"`，而所有记录看上去都「有名字」，
非常难定位。

**正确做法**：照抄 `ClassForm.Init()` 的读入判定（§3.4）——
index 0 恒保留，之后遇到 `u8(addr+4) == 0` 立即停。
不要自作聪明地「多读一点更保险」。

**自检**：打印 `id === index` 成立的记录数。如果明显小于总记录数，
说明你读过头了，或者表基址不对。

### 4.10 定长表 vs 扫终止符，两张表的规则不一样

| 表 | 读入规则 | 出处 |
|---|---|---|
| 角色表 | **固定条数** `i < unit_maxcount` | `UnitForm.Init()` |
| 职业表 | **扫终止符** `u8(addr+4) != 0`，index 0 例外 | `ClassForm.Init()` |

不要「统一处理」。想当然地把角色表也改成扫终止符，会在第一个 `ID == 0` 的空槽处提前截断；
反过来把职业表读满，就是 §4.9 的坑。**每张表都去读它自己的 `Init()`。**

### 4.11 有符号字段当无符号读 —— 能力值会静默变巨

角色表 `+12..+19`（HP/力/技/速/防/魔防/幸/体格）是**相对职业基础值的有符号增量**
（§3.3.1）。用 `u8()` 读的后果不是报错，而是**看起来合理的大数值**：
`0xFF` 变成 255、`0xFE` 变成 254，于是「体格 −2」显示成「体格 254」，
一个负调整的角色突然变成全队体格最高。

**症状**：某个角色某一项高得离谱（≥128），而其他项正常。
**判据**：任何 > 127 的基础能力值都应先怀疑是负数。
**对策**：`rom.i8()`，并且永远用 `职业基础值 + 增量` 作为「初始能力」对外输出。

同样的陷阱也存在于**任何**标着「初期値」/「増減値」/「補正」的字段 —— 先确认符号性，再决定 `i8`/`u8`。

### 4.12 「参考代码里没有这段计算」≠「数据不在 ROM 里」⭐⭐

**这条已经让本项目白扔过三轮工作。**

FEBuilderGBA 是**编辑器**：它的职责是把 ROM 里的表显示出来让你改。
它**不需要**算战斗结果，所以「没有任何加成/伤害/命中算术」是它的正常状态。

于是「我在 C# 里搜不到 X 的计算公式」**完全不能推出**「X 的数据不在 ROM 里」。
三次错误的结论都是这么来的：

| 错误结论 | 真相 |
|---|---|
| 「出场时间拿不到」（理由是 `FEBuilderGBA/config` 不存在） | 数据在 `bin/Debug/config/data/`，链路在 `MapSettingForm` / `EventCondForm` / `EventScript`（§3.11） |
| 「地形名拿不到」 | `MapTerrainNameForm.cs` 就在读它（§3.12） |
| 「支援 C/B/A 门槛拿不到」 | 门槛写在 `SupportUnitForm.Designer.cs:460` 的 `EXPLAIN.Text` 里（§3.5.1） |
| 「相性加成表被改过 / 和公版对不上」 | 表没被改；存的是**半点值**，游戏最后 `>>1`（§3.7.1、§3.10.1(3)） |

**第四个错法更隐蔽**：数据读对了，但**误解了量纲**，于是把「值不符合预期」当成了
「ROM 数据有问题」。所以还要加一条并列的规则：

> **「值看起来是脏数据」时，先怀疑自己漏了一层变换（×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量），
> 别先怀疑 ROM。** 这一条和上一条一样贵 —— 三次里有一次是它。

**正确的排查顺序**：

1. 这张表有没有一个 `XxxForm`？（`grep -l "<关键词>" *.cs` 找 Form 文件）
2. 有的话读它的 `Init()`（指针槽/步长/终止条件）**和 `.Designer.cs`**
   —— `EXPLAIN.Text` / `AccessibleDescription` / Label 文本里常藏着门槛、枚举、单位、注意事项。
3. **值不对时，去反汇编 ROM 自己的代码**（§3.13）：
   `grep -i <关键词> bin/Debug/config/data/asmmap_FE8.txt` 找函数名 → 反汇编 → 读寄存器流。
   ROM 里的代码是**终审法官**，比任何外部资料和任何推理都硬。
4. 只有 1–3 都空手而归，才可以说「参考代码里没有」。
5. 即便那时也要分清：**「参考代码没有」和「ROM 里没有」是两回事。**
   前者还能靠反汇编/实测补，后者才是真的边界。

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

## 5. CLI 工程约定

**目录：`cli/`（仓库根目录下，与 `FEBuilderGBA/` 平级）**

### 技术选型

- **TypeScript + Node.js**（已确定）
- 二进制读取：Node 内置 `Buffer` 就够了，不需要额外依赖
- **零运行时依赖**（已落实）。开发期只依赖 `typescript` + `@types/node`
- **不需要构建步骤**：Node ≥ 22.6 用内置类型擦除直接跑 `.ts`
  （要求 `allowImportingTsExtensions` + import 里写 `.ts` 后缀）

### 实际目录结构

```
cli/
├── package.json            # type: module, engines.node >= 22.6
├── tsconfig.json           # NodeNext / strict / noEmit
├── data/                   # vendored config/data 子集（27 文件，见 §1.1）—— 进 git
├── out/                    # dump 产出的 JSON（喂给 AI）；生成物，已 .gitignore
├── scripts/                # 分析层（不在 src 里，因为它们产出报告而不是给 CLI 用）
│   ├── economy-plan.ts     # 经济规划报告（§3.18 重量/追击 + §3.20 敌攻速 + §3.11.8 宝箱）
│   ├── training-plan.ts    # 培养计划报告
│   ├── emit-mgba-units.ts  # 给 mgba 凹点助手导单位表
│   └── unit-placement-census.ts  # 敌人/友军配置普查（§3.19.6）
└── src/
    ├── index.ts            # CLI 入口（node:util parseArgs）
    ├── load.ts             # loadRom()：识别 → 建表 → 解码 → 组装
    ├── rom/
    │   ├── RomBuffer.ts    # u8/u16/u32/i32/p32/p32p + toOffset/toPointer/isSafe*
    │   └── detect.ts       # 游戏代码识别（§3.1）
    ├── config/
    │   └── data.ts         # 读 cli/data/*.txt（vendored 副本，§1.1）
    ├── data/
    │   └── layouts.ts      # 各版本指针布局 + resolveTableSlot（§2.2 的「搜索槽位」）
    ├── tables/
    │   ├── common.ts       # ResolvedTable、武器等级读取
    │   ├── units.ts        # 角色表（§3.3）
    │   ├── classes.ts      # 职业表（§3.4）+ 移动消耗表（§3.4.1 交叉校验）
    │   ├── classFlags.ts   # 职业特性位 → 机动性/舞蹈/盗贼（§3.4.1）
    │   ├── eventScript.ts  # 事件反汇编器（§3.11.4）
    │   ├── chapters.ts     # 地图设置表 / 条件表 / 初始配置 / 加入推导（§3.11）
    │   ├── mapObjects.ts   # 章节条件表 slot 2 的 OBJECT 记录：宝箱/村庄/门/制圧点/商店（§3.11.8）
    │   ├── shops.ts        # 商店条目表（吃 mapObjects 的产物）
    │   ├── forceSortie.ts  # 强制出击表：记录格式 / route+map 过滤器（§3.14）
    │   ├── supportBonus.ts # 相性名 + 相性加成表 + 等级缩放 + 距离/上限常量（§3.7）
    │   ├── terrainNames.ts # 地形名表（§3.12）+ 提示串（MakeHint_Full）
    │   └── supports.ts     # 支援关系（§3.5）+ 门槛/对话封顶（§3.5.1）+ 去重图 + 自洽校验
    ├── text/
    │   └── huffman.ts      # 文本解码（§3.8 + §3.9 的两种格式）+ displayName/stripAllCodes
    └── analysis/
        ├── report.ts       # dump 命令的输出结构（喂给 AI 的那份 JSON）
        ├── roles.ts        # 机动性/武器/治疗派生（§3.4.1）
        ├── enemyStats.ts   # 敌人属性投影：自动升级 + 装备重量 → 攻速（§3.20）
        └── validate.ts     # 自洽性检查（§6）
```

### 命令一览

```bash
cd cli
node src/index.ts info     ../fixtures/dream-of-five.gba
node src/index.ts units    ../fixtures/dream-of-five.gba
node src/index.ts classes  ../fixtures/dream-of-five.gba
node src/index.ts roles    ../fixtures/dream-of-five.gba     # 队伍搭配：武器/机动/治疗/相性覆盖
node src/index.ts supports ../fixtures/dream-of-five.gba
node src/index.ts terrain  ../fixtures/dream-of-five.gba     # 地形名 65 条（§3.12）
node src/index.ts chapters ../fixtures/dream-of-five.gba     # 出场/加入 + 编队人数 + 必上（§3.11 / §3.14）
node src/index.ts objects  ../fixtures/dream-of-five.gba     # 宝箱/村庄/门/制圧点/商店 + 商店条目（§3.11.8）
node src/index.ts enemy-stats ../fixtures/dream-of-five.gba --out out/dream-of-five.enemy-stats.json  # 敌攻速分布（§3.20）
node src/index.ts text     ../fixtures/dream-of-five.gba 703 --range 0x214-0x218
node src/index.ts dump     ../fixtures/dream-of-five.gba --out out/report.json
node src/index.ts validate ../fixtures/dream-of-five.gba   # 退出码 0 = 无 error 级失败
```

**`chapters`** 默认只列**有支援数据的角色**的加入顺序（这是 AI 排队伍时真正关心的集合），
加 `--all` 放开到全部。每行带 `joinChapter` / `joinChapterNumber` / `joinChapterTitle` /
`joinChapterIsStory` / `joinSource` / `joinEvidence` / `placedClassId` / `earliestEvidenceChapter`，
以及在「`LOAD2` 早于加入」/「完全没有加入证据」/「加入点落在无标题的沙盒图上」时给一条 `note`（§3.11.7）。

同一个命令还输出**编队数据**（§3.14）：

- 每章 `deploySlots` / `deploySlotsHard` —— 该章出击位数
- 每章 `forcedUnits[]` —— 必上单位，带 `routeFilter` / `everyMap` / `recordAddress`
- 顶层 `forcedDeployment` —— 整张表（`table` / `everyMap` / `records` / `limitations`）
- `stats` 里的 `forceSortieRecords` / `unitsForcedSomewhere` / `maxDeploySlots`

> ⚠️ **`joinChapter` 是表索引，不是章号。** 要读 `joinChapterNumber` 或 `joinChapterTitle`。
> `joinChapterIsStory: false` 表示加入点落在未使用槽位或遭遇图上，**该行不可信**（§3.11.2.1）。

**`--playable-only`**（用于 `units` / `roles`）把范围收窄到**有支援数据的单位**。
这是纯从 ROM 推出的「可玩名单」代理（§3.11.7）。实测：
255 个已填槽位 → 62 个，职业从 82 降到 44，治疗者从 27 降到 8 且**全是有名字的角色**
（不加这个开关时，治疗者列表里会混进 `Priest`、`Outlaw@001F` 这类通用模板）。

**`text` 命令是最有用的诊断入口**：它直接打印每个 id 命中的存储格式
（`huffman` / `unhuffman` / `direct` / `invalid`），排查「名字读不出来」时先跑它。

### 编码约定

- **所有 ROM 偏移写 `0x` 十六进制字面量**，不要写十进制。代码里到处是十六进制，混用会出错。
- **指针表按游戏版本分文件或分常量对象**，不要用 `if (version === 'FE7U')` 散落各处：
  ```ts
  const FE7U = { unitPointer: 0x9A274, unitDataSize: 52, /* ... */ } as const;
  const FE7J = { unitPointer: 0x9AC50, unitDataSize: 52, /* ... */ } as const;
  ```
- **每个结构体解析函数都写上「来源」注释**，指向对应的 C# 文件和 Form：
  ```ts
  /** 角色表记录，52 字节。来源: UnitFE7Form.cs / UnitFE7Form.designer.cs */
  ```
  这样以后 C# 侧更新了，能快速定位要改哪里。
- **边界检查**：每次读取前校验偏移在 ROM 长度内。C# 侧靠 `U.isSafetyOffset`，我们要有等价物。
- **数据模型不要直接用日文字段名**，用英文；但保留一个注释映射回日文原标签，方便对照。

### 输出

`dump` 产出的 JSON 是喂给 AI 的输入，结构见 `analysis/report.ts`：

```
meta                  ROM 身份 + 解析出的表地址（便于复查）
units[]               角色：初始能力 / 成长 / 武器等级 / 相性 / 职业定位
                     （`stats` = 有符号增量，`startingStats` = 职业基础值 + 增量 ← 比较用这个）
classes[]             职业：基础 / 上限 / 转职加成 / 移动力
supports.edges[]      去重后的支援边（初始值 + 成长值 + startingRank
                      + turnsToConversation{C,B,A} + turnsTo{C,B,A}）
supports.byUnit[]     每个角色的支援对象清单（同样带两组回合数）
supports.rankThresholds    C/B/A 门槛 81 / 161 / 241（§3.5.1）
supports.conversationCaps  支援对话解锁点数 80 / 160 / 240（§3.5.1）
supports.distances         加成生效 3 格、攒点 1 格
supports.maxTotalSupportLevels  单人可持有支援等级总数 5
supportAffinities[]   7 条相性：原始半点值 `bonuses` + 展开后的 `byRank{C,B,A}`（§3.7）
terrainNames          65 条地形名 + 表地址/步长（§3.12）
chapters[]            每章：章号 / 标题 / 初始配置 + LOAD 指令（§3.11）
availability          加入推导：joinOrder[]（加入章节/章号/标题/来源/证据）+ 统计
limitations[]         ⚠️ 读这份报告前必读：哪些输入不在这里
derived.growthRanking     成长率总和排名
derived.supportRanking    支援对象数量排名
derived.bestGrowthPerStat 各能力成长最高的角色
derived.roleCoverage      机动性 / 治疗 / 魔法 / 武器类型覆盖
```

**`limitations` 字段是刻意加的。** 它明写「哪些数据不在这份报告里」，
防止下游（人或 AI）把「数据里没有」误当成「数据里是 0」。
**它曾经列过「出场时间」「C/B/A 换算」「地形名」「加成如何随等级放大」四条，
现在这四条都已实现**（§3.11 / §3.5.1 / §3.12 / §3.7.2）。
剩下的边界是**模拟层面**的东西：地形回复量、武器三角系数 —— 那不是「表没找到」，
而是「游戏运行时的规则」。

---

## 6. 验证策略（重要）

不能靠「读代码觉得对」来确认偏移正确 —— 必须拿真实 ROM 验证。

**分层验证：**

1. **自洽性检查**（不需要外部工具）—— 已实现为 `validate` 命令
   - 解出的角色名是正常文字，不是乱码（`text.names` / `text.printable`）
   - 角色 ID 唯一、连续（`unit.uniqueIds` / `unit.idSequence`）
   - 每个角色的职业 ID 都能解析到有名字的职业（`unit.classIds`）
   - 支援关系双向对称（A→B 和 B→A 数值一致）→ `support.reciprocal`
   - 支援人数 `+21` 与实际非零相手数量一致 → `support.partnerCount`
   - 支援指针全部落在 ROM 内 → `support.pointers`
   - 相性加成表读到**恰好 7 条且 ID 依次为 1..7** → `support.affinityTable`
     （条数不对或 ID 不连续 = `support_attribute_pointer` 槽位或步长错了）
   - **加成按半点缩放** → `support.bonusHalving`
     断言 7 行展开后都是 `atk` 在 C/B/A = `0/1/1`、`critAvoid` = `2/5/7`。
     这是「有没有忘记最后那个 `>>1`」的**最廉价哨兵** —— 忘记的话 `atk` 在 C 会是 1。
   - 加成记录第 7 字节全为 0 → `support.bonusPadding`
     （游戏只读偏移 1–6；非零说明步长错了）
   - **相性名与参考程序的硬编码表完全一致** → `support.affinityNames`
     （7/7 一致；同时验证了 ROM 文本表与相性 ID 顺序）
   - **门槛与对话封顶相差 1** → `support.rankThresholds`
     断言 `C == 80+1 && B == 160+1 && A == 240+1`（§3.5.1）
   - 每条支援都能到 C（成长值为 0 且初始值 < 81 的会永远到不了）→ `support.reachable`（**warn**）
   - **地形名表读到 ≥ 65 条**（`MoveCostForm` 有 `J_0..J_64` 共 65 列）→ `terrain.nameTable`
     （条数不足 = `map_terrain_name_pointer` 槽位或步长错了）
   - 英文版下大部分地形名解码非空 → `terrain.namesDecode`（**warn**）
   - **地形名 id 与消耗表 id 对齐** → `terrain.idAlignment`（**warn**）
     判据：飞行职业能踩 `0x12`（Peak）而地面职业不能。
     实测 17 个飞行能踩 / 95 个地面不能；例外 `Thug` / `Berserker` / `Dragon` 是**真实数据**，不是错误
   - **有移动力的**职业都有 **65** 项消耗表 → `class.movementCosts`
     （移动力为 0 的静止职业跳过，见 §3.4.1；**65 不是 64**，见 §3.4）
   - 每个已填槽位都能派生出一个职业定位 → `roster.roleCoverage`
   - **章节链路自洽**（§3.11）：
     - 地图设置表能读出记录且条数 > 0 → `chapter.mapSettingTable`
     - **有真标题 / 未使用槽 / 遭遇图的分裂能算出来** → `chapter.storyVsPlaceholder`（**warn**）
     - **标题里的 `C<n>` 与 `+0x80/2` 逐一吻合** → `chapter.numberMatchesTitle`
       （这是 `+0x80` 解读正确性的**独立证据**；外传允许落在 `n` 或 `n+1`）
     - 每个带事件 plist 的章节都能解析到条件表 → `chapter.conditionTables`
     - 每个初始配置块都在 `u8 == 0` 处正常终止 → `chapter.placementBlocks`
     - **强制出击表能解析且记录大小为 4** → `chapter.forceSortieTable`
     - **必上单位确实预置在该章** → `chapter.forcedUnitsArePlaced`（**warn**）
       26 条地图级记录里 24 条命中；例外是 C15 的 Severin / Stolypin（靠开场事件入场）。
       这条同时验证了两张表（强制出击表 + 初始配置块）的偏移都对。
     - **每个编号章节都有出击位** → `chapter.deploySlots`（**warn**）
       实测 48 张有编号的图：中位数 12、最多 18、最少 1。
     - 困难模式出击数与普通模式一致（差的地方单独列出）→ `chapter.hardDeploySlots`（**warn**）
     - 事件脚本走查未出现连续未知 opcode → `chapter.scriptWalks`（**warn**）
     - 有支援数据的角色大多能推出加入章节 → `roster.joinEvidence`（**warn**）
   - **能力值自洽**（§3.3.1）：
     - 没有任何角色的「职业基础值 + 增量」`<= -1` → `unit.statWraps`
       （按参考代码说明，这种值在载入时会被补码成最大值，属于损坏数据）
     - 报告出负增量的角色数量 → `unit.signedBaseStats`（**warn**）
       —— 这个数字同时也是「有没有把有符号字段当无符号读」的哨兵：
       若为 0 而 ROM 里明显有 `0xFF`/`0xFE` 这类字节，说明读取方式错了

   > **检查项分两级**：`severity: 'error'` 的失败会让退出码变 1；
   > `severity: 'warn'` 只提示，不影响 `ok`。
   > 「成长率 > 100」是 **warn 而非 error** —— 成长率是 u8（上限 255），
   > 升级判定是 `rand(0..99) < growth`，所以 >100 只意味着「必定成长」，
   > 是**合法**的 hack 手法（实测 `dream-of-five.gba` 里有 17 个这样的值）。
   > 把它当 error 会误报。

   > **另一个易犯的误报**：把「没有消耗表」当 error。Gorgon Egg、Arcane Lock
   > 和空白填充职业的移动力就是 0，本来就没有消耗表。判定条件必须加上
   > `movementRange > 0`，否则 9 个合法职业会被报成错误。

   > **跨表交叉验证**：「有支援数据的角色」应当与「可玩名单」高度重合。
   > FE8U 实测 62 个、ID 连续 1–62；而唯一那条 0 个支援对象的记录
   > （debug 单位 Rophon，成长率总和 1111）正是异常项 —— 两个独立的
   > 数据源互相印证，说明解析是对的。

2. **交叉验证**（用参考程序）
   - 构建并运行 FEBuilderGBA（见 §8），打开同一个 ROM，对比它显示的角色数据/支援数据和我们解析的是否一致
   - 这是最可靠的手段，值得为此在 Windows 上跑一次参考程序

3. **常识验证**
   - 用已知的 FE7 角色属性对照（比如某个角色的成长率是公开数据）

**注意**：`cli/` 里的代码在 macOS/Linux 上都能跑（纯 Node，不依赖 WinForms）。只有 §8 的参考程序需要 Windows。

---

## 7. 权威来源索引

按「想查什么 → 读哪个 C# 文件」整理：

| 想查什么 | 读这个文件 |
|---|---|
| ROM 里所有表的指针/大小 | `FEBuilderGBA/ROMFE7U.cs`、`ROMFE7JP.cs`、`ROMFE8U.cs`、`ROMFE8JP.cs`、`ROMFE6JP.cs` |
| ROM 版本识别 | `FEBuilderGBA/Rom.cs` → `LoadLow()` |
| 角色表结构 | `FEBuilderGBA/UnitFE7Form.cs` + `UnitFE7Form.designer.cs` |
| 角色通用查询（名字、ID 反查） | `FEBuilderGBA/UnitForm.cs` |
| 职业表结构 | `FEBuilderGBA/ClassForm.cs` + `ClassForm.designer.cs` |
| **职业特性位 → 位名** | `FEBuilderGBA/InputFormRef.cs` → `GetInfoByBitFlag()` (7453) + `bin/Debug/config/data/unitclass_checkbox_*.txt`（§3.4.1） |
| 支援关系表 | `FEBuilderGBA/SupportUnitForm.cs` |
| **支援 C/B/A 门槛（81/161/241）** | `FEBuilderGBA/SupportUnitForm.Designer.cs:460` → `EXPLAIN.Text`（§3.5.1） |
| **支援对话解锁点数（80/160/240）** | **反汇编** `GetUnitSupportBonuses` / `UnitGainSupportExp`（§3.13） |
| **相性加成如何随等级放大** | **反汇编** `StoreAddedAffinityBonusesForSupportLevel`（§3.7.2 / §3.13） |
| **支援距离 / 单人 5 级上限** | **反汇编** `GetUnitSupportBonuses` / `CanUnitSupportNow`（§3.5.1） |
| 支援会话表 | `FEBuilderGBA/SupportTalkFE7Form.cs` |
| 支援相性加成表 | `FEBuilderGBA/SupportAttributeForm.cs`（**只有读写，没有等级换算**） |
| 相性名称（炎雷風氷闇光理） | `FEBuilderGBA/InputFormRef.cs:7006` → `GetAttributeName()`；**也可从 ROM 文本表解出**（文本 id 见 §3.7） |
| **地形名表** | `FEBuilderGBA/MapTerrainNameForm.cs` + `MapTerrainNameEngForm.cs`（§3.12） |
| **文本控制码清理** | `FEBuilderGBA/TextForm.cs:1262` → `StripAllCode()`（单位名也要过，见 §3.12） |
| 文本解码（Huffman） | `FEBuilderGBA/FETextDecode.cs` |
| **原版函数符号表** | `FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt`（`.en` / `.zh` 变体）（§3.13） |
| **FE8 反编译（字段名/常量的第二意见）** | `FireEmblemUniverse/fireemblem8u` → `include/bmreliance.h` + `src/bmreliance.c`（§3.13.2） |
| **地图设置表 / 终止判定** | `FEBuilderGBA/MapSettingForm.cs` → `IsMapSettingEnd()` (64)（§3.11.2） |
| **章节条件表 → 初始配置块** | `FEBuilderGBA/EventCondForm.cs` → `MakeUnitPointer()` (1564) / `MakeUnitPointerEventScan()` (1743)（§3.11.3） |
| **事件脚本反汇编器** | `FEBuilderGBA/EventScript.cs` → `DisAseemble()` + `bin/Debug/config/data/event_*.txt`（§3.11.4） |
| **强制出击表** | `FEBuilderGBA/EventForceSortieForm.cs`（只暴露 2 个字段）+ `ROMFE8U.cs:95` + 反汇编 `IsCharacterForceDeployed_`（§3.14） |
| **搜索型指针槽的解析** | `FEBuilderGBA/U.cs` → `FindROMPointer()` 三个重载（7644 / 7667 / 7705）（§2.2 / §3.11.2） |
| 指针/偏移工具函数 | `FEBuilderGBA/U.cs` → `toOffset` / `isPointer` / `isSafetyOffset` |
| ROM 读写原语 | `FEBuilderGBA/Rom.cs` → `u8/u16/u32/p32/p32p` |
| `InputFormRef` 参数含义 | `FEBuilderGBA/InputFormRef.cs` → `Init()` (5792)、`GetDataSize()` (5037)、`IDToAddr()` (5561) |
| 控件名 → 偏移的约定 | `FEBuilderGBA/InputFormRef.cs` → `GetDataSize()` |

**通用挖法**（拿到新表时）：找到对应 `XxxForm.cs` 的 `Init()` → 读出指针槽/大小/条数 → 打开 `XxxForm.designer.cs`，用 §2.4 的两条 grep 还原字段偏移和名称。

---

## 8. 附录：参考程序的构建与运行

只有在**交叉验证数据**时才需要。日常开发 CLI 用不到。

### 项目概况

| | |
|---|---|
| 语言 / UI | C# / Windows Forms |
| 目标框架 | .NET Framework 4.0（`app.config` 要求运行时 4.5） |
| 解决方案 | `FEBuilderGBA.sln`（VS2010 格式，`ToolsVersion 12.0`） |
| 工程 | 单个 `FEBuilderGBA/FEBuilderGBA.csproj` |
| 规模 | ~477,000 行 C#，~768 个 `.cs`（全部平铺在 `FEBuilderGBA/` 下） |
| 包管理 | **无** —— 没有 NuGet，没有 restore |
| 平台 | **仅 Windows** |

### 构建

```bat
msbuild FEBuilderGBA.sln /p:Configuration=Debug /p:Platform=x86
```

或用 Visual Studio 打开 `FEBuilderGBA.sln` 直接构建。输出在 `FEBuilderGBA/bin/Debug/`。

### 运行所需的两样外部资源 —— **仓库里已经有了**

> ⚠️ 早期版本写「这两样都不在仓库里，必须自己补」，**这是错的**。实测两者都在，
> 且**都被 git 跟踪**（`FEBuilderGBA/bin/Debug/config/` 有 43,075 个文件）：

1. **`config/` 目录树** —— 已在 `FEBuilderGBA/bin/Debug/config/`：
   ```
   config/
   ├── data/          游戏数据表（422 个文件，见 §1.1）
   ├── patch2/        社区补丁 + MOD_*.txt
   ├── translate/     <lang>.txt 翻译资源
   └── config.xml     用户设置（首次运行生成）
   ```
2. **`7-zip32.dll`**（LGPL 2.1）—— 已在 `FEBuilderGBA/bin/Debug/7-zip32.dll`。
   见 `README.7-zip32.dll.md`。

`Program.cs` 的 `CheckConfigDirectory()` / `Check7ZipDLL()` 会校验它们。
**所以在这台机器上直接 `msbuild` 就能跑**，不需要从安装包拷任何东西。
（`bin/Debug` 下目前只有 `config/`、`7-zip32.dll`、`FEBuilderGBA.exe.config` ——
exe 本身仍需自己构建。）

### 测试（DEBUG 构建）

没有测试框架。`Program.DebugTESTRunner()` 用反射调用全程序集里的静态无参方法：`TESTNOW_*` → `TEST_*` → （带 `--test`/`--testonly` 时）`TESTFULL_*`。断言用 `Debug.Assert`，测试方法就地写在被测代码所在的文件里，包在 `#if DEBUG` 中。

```bat
:: 只跑测试然后退出
FEBuilderGBA\bin\Debug\FEBuilderGBA.exe --testonly
```

### 常用命令行参数

| 参数 | 用途 |
|---|---|
| `--rom=<path>` | 启动时打开指定 ROM |
| `--lastrom` | 打开上次使用的 ROM |
| `--force-version=<FE7U\|FE7J\|...>` | 强制指定 ROM 版本 |
| `--lint` | ROM 检查并退出 |

### 改这个 C# 项目时的注意事项（如果真要改）

- 命名空间统一是 `FEBuilderGBA`，不要新建命名空间
- **不要手改 `*.Designer.cs`** —— 是设计器生成的
- **新加的 `.cs` 文件必须手动加进 `FEBuilderGBA.csproj` 的 `<Compile Include>`** —— 这个工程不用通配符，漏了就不会被编译
- 提交信息/标签格式：`ver_YYYYMMDD.NN`

---

## 9. 快速参考

```bash
# 仓库结构
FEBuilderGBA/    ← 只读参考（C#，仅 Windows）
cli/             ← 我们的 CLI（TypeScript/Node，跨平台）
mgba/            ← mGBA Lua 凹点助手（见 §3.15 / §3.17）

# 挖一个表的结构
grep -oE "this\.[A-Za-z_0-9]+ = new (System\.Windows\.Forms\.)?(NumericUpDown|TextBoxEx|ComboBoxEx|CheckBoxEx|ListBoxEx)" <Form>.designer.cs \
  | sed 's/this\.//' | awk '{print $1}' | sort -u          # 控件名 = 类型字母 + 字节偏移
grep -nE 'this\.[A-Za-z_0-9]+\.Text = "' <Form>.designer.cs  # 标签文本 = 字段名

# 找一张表的定义（读入规则也在这里，见 §4.10）
# ⚠️ 别只看 Form.cs —— 门槛/说明文字常写在 Designer 的 EXPLAIN.Text 里（§3.5.1 就是这么找到的）
grep -n "static InputFormRef Init" <Form>.cs
grep -n "EXPLAIN.Text\|AccessibleDescription" <Form>.Designer.cs

# ⭐ 参考代码答不上来时：反汇编 ROM 自己的代码（§3.13）
grep -i <关键词> FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt   # 原版函数符号表
# 拿到地址后按符号切一段出来解（capstone，见 §3.13）
/Users/woxqaq/.workbuddy-ai/binaries/python/envs/default/bin/python /tmp/disasm.py \
  fixtures/dream-of-five.gba 0x28550 0x285B0

# ⭐⭐ 找地址的捷径：patch2 里的 #ENGINE 补丁常直接写出「要改哪条指令」（§3.18）
ls FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/          # 引擎级补丁
grep -n "ADDRESS\|DETERMINATION_ADDRESS\|^OFF\|^FIX" \
  FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/<补丁>.txt
# 例：PATCH_Eliminate attack speed penalty.txt → 0x02AB92，OFF=40 1A（subs r0,r0,r1）
#     → 反汇编 0x2AB74 就是 BattleLoadAS（攻速公式），见 §3.18

# 跑我们的 CLI
cd cli && node src/index.ts validate ../fixtures/dream-of-five.gba
cd cli && node src/index.ts roles    ../fixtures/dream-of-five.gba --playable-only
cd cli && node src/index.ts supports ../fixtures/dream-of-five.gba
cd cli && node src/index.ts terrain  ../fixtures/dream-of-five.gba
cd cli && node src/index.ts chapters ../fixtures/dream-of-five.gba
cd cli && node scripts/unit-placement-census.ts            # 敌人/友军配置普查（§3.19.6）
cd cli && node scripts/unit-placement-census.ts --chapter 22   # 单章逐块明细
cd cli && node scripts/unit-placement-census.ts > out/unit-placement-census.txt   # 存证
cd cli && node src/index.ts enemy-stats ../fixtures/dream-of-five.gba --compact \
  --out out/dream-of-five.enemy-stats.json                # 敌攻速逐阶段分布（§3.20）

# mgba 凹点助手（见 §3.15 升级抽点 / §3.17 战斗掷骰）
node cli/scripts/emit-mgba-units.ts            # 重新生成 mgba/units.lua（从 cli/out/*.units.json）
node mgba/test/run.mjs                         # 跑自测（fengari 假内存，124 项）
node mgba/test/run.mjs --preview               # 顺带打印面板快照
/Users/woxqaq/.workbuddy-ai/binaries/python/envs/default/bin/python mgba/test/battle_golden.py
                                               # 战斗模型黄金值（独立 Python 实现，改战斗模型后先跑这个）
# 实机：mGBA → Tools → Scripting → Open → mgba/fe-aodian.lua（无命令行载入）
cd cli && node src/index.ts text     ../fixtures/dream-of-five.gba --range 0x214-0x218
cd cli && ./node_modules/.bin/tsc --noEmit

# config/data：CLI 读 vendored 副本；上游源头在 FEBuilderGBA（见 §1.1 / §4.7）
ls cli/data/                                        # 我们读的（27 个文件）
ls FEBuilderGBA/bin/Debug/config/data/ | head       # 上游源头（422 个文件，刷新用）
```

**第一条要写对的链路（已实现，见 `cli/src/load.ts`）：**

```
读 0xAC 的 6 字节游戏代码 → 选指针布局（FE7 固定 / FE8 搜索）
  → p32(unit_pointer) 得到角色表
  → 角色记录 +0 取文本 ID
      → 查文本表条目 → 分类：0x88xxxxxx = 未压缩 / 0x08xxxxxx = Huffman
      → 解码 → 过 displayName（剥 @XXXX）→ 角色名
  → 角色记录 +44 取支援指针 → 24 字节支援记录 → 支援关系图（去重）
       → 对话封顶 80/160/240 → turnsToConversation{C,B,A}
       → 门槛 81/161/241 → turnsTo{C,B,A}（累计，见 §3.5.1）
  → 角色记录 +9 取相性 → 查相性加成表（7 条 × 8 字节）
       → 半点值 × {0,1,2,3} ÷ 2 = C/B/A 加成（§3.7.2）
       → 相性名也可从文本表解出（id 见 §3.7）
  → 角色职业 ID → 职业记录 +56 取指针 → 65 项移动消耗表 → 机动性（交叉校验）
       → 该表第 n 项 = 地形名表第 n 条（§3.12，同一套 id）
  → 职业记录 +40..+43 特性位 → 机动性主判据（§3.4.1，key 表来自 config/data）
```

**出场/加入链路（已实现，见 `cli/src/tables/chapters.ts`，§3.11）：**

```
p32(map_setting_pointer) → 148 字节地图记录
  → +0x80 = 章号 ×2（游戏自己的 Chapter Number）  ← 判断「第几章」看这个
  → +0x70 = 章节标题文本 id（`C7A: ...`）
  → +116 = 事件 plist 索引
  → p32(map_event_pointer + i*4) = 条件表（20 槽，顺序来自 eventcond_FE8.txt）
  → slot 10/11 = PLAYER_UNIT 初始配置块（20 字节/条，u8(+0)==0 终止）
  → START_EVENT 脚本 → 事件反汇编器（opcode 表来自 event_FE8.txt）
  → LOAD1 (402C....) = 加入章节；LOAD2 (412C....) = 过场预载
```

**敌人/友军摆放链路（已实现，见 `cli/src/tables/chapters.ts` + `scripts/unit-placement-census.ts`，§3.19）：**

```
⚠️ FE8 没有「敌人表」—— 玩家/友军/敌人共用同一种 20 字节记录
   是不是敌人 = 记录自己 +3 字节 bits 1-2（0 自军 / 1 友军 / 2 敌军 / 3 消灭）
   记录块由事件脚本引用，5 类指令：
     402C0100 / 402C0000  LOAD1   → 招募 + 章节初始敌人
     412C0100             LOAD2   → 读入既有成员 / 开局重放自军块
     422C0000             LOAD3   → 过场
     40050200XXXXXXXX400A0000…    → 增援
     40050200…4005030001000000…   → 增援（普通以上）
   ROM 侧处理器：Event2C_LoadUnits @ 0x0800FB84（事件 opcode 2C）
   常规章节初始敌人 → START_EVENT（槽 18）；增援 → TURN（槽 0）/ ALWAYS（槽 3）
   ROM 侧访问器：GetChapterAllyUnitDataPointer 0x08083348（槽 10/11 + 魔物 12-14）
                GetChapterEnemyUnitDefinitions 0x080833B0（只读槽 15/16/17 = 魔物图！）
                GetChapterAllyUnitCount      0x08012344（不过滤阵营）
```

**敌人属性 → 攻速链路（已实现，见 `cli/src/analysis/enemyStats.ts` + `enemy-stats` 命令，§3.20）：**

```
记录(+0 unitId) → 角色表 → +12..19 有符号增量（速度/体格）
记录(+1 classId，0 = 用角色自己的职业) → 职业表 → +0x0E 基础速度 / +0x11 体格
记录(+3 bit0 GROW)  ── 0 ─→ 不做自动升级
                    └─ 1 ─→ 0x08017C36 分派:
                              (角色.flags|职业.flags)&0x80 置位 → AutolevelRealistic
                              角色 id > 0x40                          → AutolevelUnit
                              否则                                     → AutolevelRealistic
   AutolevelUnit      0x08018120：count = 等级−1（+ 转职轮 9/19，掩码 0x100）
                                  成长率取 unit[+4] = **职业表** +0x1B..0x21
   AutolevelRealistic 0x08018160：count = 等级 − 角色表等级，逐级模拟
                                  （CheckForLevelUp 0x0802BA28 循环）
   GetAutoleveledStat 0x0802B9C4：x = 成长×count + rand(0, v/8−1) − v/16
                                  → 增益 ∈ [floor(xMin/100), floor(xMax/100)+1]  ← 烧 RNG
记录(+12..15 道具) → 道具表 +23 武器重量
攻速 = 速度 − max(0, 重量 − 体格)   ← 有符号，引擎不钳零
```

**编队人数 / 强制出击链路（已实现，见 `cli/src/tables/forceSortie.ts`，§3.14）：**

```
出击位数 = 上面那个初始配置块的记录条数（= 游戏的 GetChapterAllyUnitCount）→ deploySlots
         （slot 11 的块 = 困难模式 → deploySlotsHard）

p32(0x8483C) → 强制出击表（4 字节/条，u16(+0)==0xFFFF 终止）
  → +0 u16 unitId
  → +2 u8  route  ← 比 ChapterData+0x1B（RAM 值，静态判不了，原样输出）
  → +3 u8  mapId  ← 地图设置索引，0xFF = 全图
  → 三个条件全中 = 必上
```

**三个最容易出错的地方（按踩坑概率排序）：**

1. `RomInfo.*_pointer` 是**槽位偏移**，读表前必须 `p32()`（§4.2）
2. 文本表条目有**两种存储格式**，只实现 Huffman 会丢掉约一半的字符串（§4.3 / §3.9）
3. 定长表**不能读满**，职业表要扫终止符（§4.9 / §4.10）

**最容易「编数据」的地方（不是 bug，是认知陷阱）：**

> **总纲一：把「参考代码里没有这段计算」当成「数据不在 ROM 里」，是本项目犯过三次的错误。**
> FEBuilderGBA 是编辑器不是模拟器，它**不需要**算战斗结果。正确的问法是
> 「这个字段有没有一个 Form 在读它」，而不是「有没有一段代码在用它」。
> 门槛、枚举、提示串经常就写在某个 `Designer.cs` 的 `EXPLAIN.Text` 里。
>
> **总纲二：把「值看起来像脏数据」当成「ROM 有问题」，是同一毛病的另一种形态。**
> 先怀疑自己漏了一层变换（×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量），别先怀疑 ROM。
> 这时**去反汇编 ROM 自己的代码**（§3.13）—— 它是终审法官。

- ~~出场时间 / 加入章节拿不到~~ —— **错，已实现**（§3.11）。别再手工编加入顺序。
- ~~「骑马 / 重甲」分不开~~ —— **错，特性位能分开**（§3.4.1）。
- ~~地形名拿不到~~ —— **错，`map_terrain_name_pointer` 就是它**（§3.12），65 条。
- ~~支援 C/B/A 换算拿不到~~ —— **错，门槛写在 `SupportUnitForm.Designer.cs:460`，缩放算术在 ROM 的代码里**（§3.5.1 / §3.7.2）。
- ~~相性表「被改过 / 和公版对不上」~~ —— **错，表是未改动的公版，只是存的是半点值**（§3.7.1 / §3.10.1(3)）。
- **移动消耗表是 65 项不是 64** —— 少读一列会静默丢掉地形 `0x40`（"Mast"）（§3.4）。
- **角色表里的能力值是「相对职业基础值的有符号增量」，不是初始能力** —— 必须加上职业基础值
  才能得到游戏显示的值，而且要用 `i8` 读（§3.3.1 / §4.11）。增量为 0 是最常见的值，不是缺数据。
- **地图设置表索引不是章号** —— 79 条记录里只有约 30 张是单周目能打到的剧情图，
  其余是未使用槽位 / 遭遇图 / bonus 图。把索引当章号会报出「第 60 章」这种不存在的东西（§3.11.2.1）。
- **单位名要过 `displayName`（剥 `@XXXX`）** —— 本 ROM 有 17 个名字尾部带 `@001F` 字形码，
  拿 `"Franseza@001F"` 当 key 就是在拿噪声当 key（§3.12）。
- **不要暴力扫字节找 unitId** —— 2,186,116 个候选，纯噪声（§3.10 反面教材）。
- **`40050200....` 是增援分派，不是招募** —— 靠 `0x2C` opcode 过滤（§3.11.4）。
- **部署槽位是模板填的，别按名字去重** —— 本 ROM 683 条配置记录里 534 条是填充
  （同一个 `unitId` 配当章 `classId`）。**数条数**才是出击位数（§3.14.1 / §4.13）。
- **强制出击表的 `route` 字节静态判不了** —— 它比的是 RAM 里的 `ChapterData+0x1B`。
  本 ROM 12 条记录写着 `0x01` 却指向 A 线/B 线/合流后的地图，两种解释都成立。
  **如实输出 + 说明影响**，不要二选一当事实写下去（§3.14.3 / §4.14）。
