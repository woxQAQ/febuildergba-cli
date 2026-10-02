# 支援系统与文本解码（§3.5 – §3.9）

> 本文件是 [`AGENTS.md`](../AGENTS.md) 的拆分件，章节编号保持原样（`§x.y` 交叉引用仍有效，
> 被引章节可能落在其他文件里）。索引与拆分原因见 [`docs/README.md`](README.md)。

## 3. FE7 / FE8 数据字典

> 下面所有偏移都是 **file offset**（不是 GBA 地址）。GBA 地址 = file offset + `0x08000000`。
> 所有 `*_pointer` 字段都是**指针槽**，用前先 `p32()`。

### 3.5 支援关系表 —— 24 字节/条

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

#### 3.5.1 C/B/A 的门槛与完整升级机制

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

##### 但「门槛」和「能升级的点数」差 1 —— 中间隔着一次支援对话

上面那句「一定数の支援値がたまると、支援コマンドが表示され、**支援会話をすることで**次のレベルに進みます」
才是关键。支援点数**会被封顶**，必须真的去看支援对话才会进下一级。反汇编 ROM 自己的代码
（`GetUnitSupportBonuses` / `UnitGainSupportExp`）得到：

```
当前等级为「无」时，点数最多涨到 80      → 支援对话可用 → 对话后点数变 81  → 等级 C
当前等级为 C 时，点数最多涨到 160        → 支援对话可用 → 对话后点数变 161 → 等级 B
当前等级为 B 时，点数最多涨到 240        → 支援对话可用 → 对话后点数变 241 → 等级 A
```

- **80 / 160 / 240 是「解锁对话」的点数**（`SUPPORT_CONVERSATION_CAPS`；原版符号
  `sSupportMaxExpLookup`，值 = `SUPPORT_EXP_x − 1`）。
- **81 / 161 / 241 是「对话之后持有」的点数**（`SUPPORT_RANK_THRESHOLDS`；原版
  `SUPPORT_EXP_C/B/A = 81 / 161 / 241`）。
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

> 「上限 5」是**等级数之和**，不是「5 个伙伴」。一个 A(3) + 一个 B(2) 就满了；
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

### 3.7 支援相性加成表 —— 8 字节/条

表地址 = `p32(support_attribute_pointer)`。

**这不是「每级一条」，是「每个相性一条」。** 实测（FE8U）：

- 表里有 **7 条**记录，第 0 字节依次是相性 ID `1..7`。
- 读入规则 `SupportAttributeForm.Init()` 是 `return rom.u8(addr) != 0;` —— **读到第 0 字节为 0 就停**。
- 所以「7 条」不是巧合，而是相性总数（炎/雷/風/氷/闇/光/理）。

相性 1–7 = `炎雷風氷闇光理`，参考程序硬编码在 `InputFormRef.cs:7006`。
**ROM 里也有一张相性名文本 id 表**（反编译 `src/bmreliance.c` 的 `GetAffinityName`）：

```
相性 1..7 → 文本 id 0x510, 0x511, 0x512, 0x513, 0x50C, 0x50B, 0x50A
（index 0 → 0x534，未使用）
```

实测解码出来正是 `Fire / Thunder / Wind / Ice / Dark / Light / Anima` ——
与参考程序的硬编码表完全一致，**这是相性 ID 顺序的独立验证**：
两边不是互相抄的，是各自从 ROM / 源码独立得到的。

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

#### 3.7.1 表里存的是**半点值**，不是最终加成

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

### 3.9 文本表条目有「两种格式」—— 反 Huffman 补丁

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
