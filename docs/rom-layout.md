# ROM 布局与核心表（§3.1 / §3.2 / §3.3 / §3.4 / §3.12）

> **本文件是 `AGENTS.md` 的拆分件。** 原 §3 数据字典有 110KB，把 `AGENTS.md` 撑到 167KB，
> 而它作为「项目指南」每次会话都会被注入 —— **注入时会被截断**，所以按主题拆到 `docs/`。
> **章节编号一律保持原样**（`§3.1`–`§3.20` 等），全仓（`MEMORY.md` / `SKILL.md` / 源码注释）
> 的 `§x.y` 交叉引用仍然有效。
> ⚠️ 被引用的 `§x.y` 可能落在 `docs/` 的**其他**文件里 —— 完整索引见 [`docs/README.md`](README.md)。
> 入口仍是 [`AGENTS.md`](../AGENTS.md)。

## 3. FE7 / FE8 数据字典

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
`FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/unitclass_checkbox_FE8.txt` 里**（见 §1.1）——
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
