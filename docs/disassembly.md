# 反汇编 ROM 自己的代码（§3.10 / §3.13）

> 本文件是 [`AGENTS.md`](../AGENTS.md) 的拆分件，章节编号保持原样（`§x.y` 交叉引用仍有效，
> 被引章节可能落在其他文件里）。索引与拆分原因见 [`docs/README.md`](README.md)。

## 3. FE7 / FE8 数据字典

> 下面所有偏移都是 **file offset**（不是 GBA 地址）。GBA 地址 = file offset + `0x08000000`。
> 所有 `*_pointer` 字段都是**指针槽**，用前先 `p32()`。

### 3.10 参考代码里**仍然拿不到**的东西 ⭐⭐

> **本节被写错过三次，每次的代价都一样大。**
>
> 第一次：断言「出场时间拿不到」「职业特性位拿不到」，理由是 `FEBuilderGBA/FEBuilderGBA/config` 目录不存在。
> **这个理由本身是错的** —— 数据在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/`（见 §1.1）。
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

### 3.13 反汇编 ROM 自己的代码 —— 参考代码解释不了时的终审法官 ⭐⭐⭐

**当「这个字段到底怎么用」参考代码答不上来时，ROM 里有答案：ROM 自己带着代码。**

这条链路的两个前提，**两样都已经在仓库里**：

1. **符号表。** `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_<game>.txt`（也有 `.en` / `.zh` 变体）
   是**原版**的函数名 → 地址映射。格式是 tab 分隔的 `地址<TAB>名字<TAB>说明…`：

   ```
   0802852C	GetSupportBonusEntryPtr	{U}
   08028550	StoreAddedAffinityBonusesForSupportLevel	{U}
   080285B0	GetUnitSupportBonuses	{U}
   ```

   `{U}` = 美版，`{J}` = 日版。**这等于给原版 ROM 附了一份带注释的反汇编清单**，
   而且这个 hack 保留了原版的代码布局，所以符号表直接可用。

2. **反汇编器。** 需要能解 Thumb。`objdump`（LLVM）**不支持裸二进制**
   （`-b binary` 是 GNU 专属参数），所以用 Python 的 `capstone`。
   任一 Python 3 解释器都行，没有 capstone 就让 `uv` 现拉一个：

   ```bash
   uv run --with capstone python \
     .workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py \
     <rom.gba> <startOffset> <endOffset>
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

> 地形名表（步长、终止条件、与消耗表 id 的 Peak 交叉验证）见 [`rom-layout.md`](rom-layout.md) §3.12；
> 地形加成三表（职业记录 `+68` / `+72` / `+76`）见 §3.4。本节不重复。

---
