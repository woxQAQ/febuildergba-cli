# 章节、事件与单位摆放（§3.11 / §3.14 / §3.16 / §3.19）

> 本文件是 [`AGENTS.md`](../AGENTS.md) 的拆分件，章节编号保持原样（`§x.y` 交叉引用仍有效，
> 被引章节可能落在其他文件里）。索引与拆分原因见 [`docs/README.md`](README.md)。

## 3. FE7 / FE8 数据字典

> 下面所有偏移都是 **file offset**（不是 GBA 地址）。GBA 地址 = file offset + `0x08000000`。
> 所有 `*_pointer` 字段都是**指针槽**，用前先 `p32()`。

### 3.11 出场时间 / 加入章节 —— 完整链路

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
      → LOAD1（402C....）= 仲間にする（招募入队）这是「加入章节」
```

#### 3.11.2 地图设置表

`map_setting_pointer` 是**搜索型**槽：候选槽位有多个，靠
`U.FindROMPointer` 的 `Func<uint,bool>` 重载（`U.cs:7705`）逐个试。判据是
`isSafetyOffset(slot)` → `isSafetyPointer(u32(slot))` → `isSafetyOffset(tableOffset + 0x100)`
→ `func(tableOffset)`，其中 `func` 检查 `u32(tableOffset + 0x12) < 0xE`。

> **上游 bug**：`map_setting_pointer` 的 lambda 实际写的是 `rom.u32(0x12) < 0xE` ——
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

#### 3.11.2.1 索引 ≠ 章节号：`+0x80` 才是章号

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
| `402C....` | **LOAD1** | 招募入队（仲間にする）用它定「加入章节」 |
| `402C0000XXXXXXXX` | LOAD1 变体 | 不载入已阵亡单位 |
| `412C....` | LOAD2 | 载入已在队成员（过场用） |
| `422C....` | LOAD3 | 过场演出 |
| `40050200....` | 増援分岐 | 也是 `POINTER_UNIT`，但指向**敌方**块 |

> **`40050200....` 陷阱**：它同样携带 `POINTER_UNIT` 参数，会被天真实现当成招募。
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

#### 3.11.8 OBJECT 槽（slot 2）：宝箱 / 村庄 / 门 / 制圧点 / 商店

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

**金箱的不变式**：`発生タイプ == 0x07` 且 `+4 == 0x77` 时，金额才在 `+6`（u16）。
否则 `+4` 是普通物品 ID、`+6` 应为 0。DoF 的 57 个宝箱**全部满足**
「要么 `+4 == 0x77` 且金额 > 0，要么 `+4` 是真物品且金额 == 0」—— 这条已进 `validate`。

**商店的 `種類`（`+10`）取值是 `0x16 / 0x17 / 0x18`**（DoF 实测 33 个商店记录），
不要和 `発生タイプ`（`0x0A`）搞混 —— 前者是「店卖什么档次」，后者是「这是个店」。

**代码位置**：`cli/src/tables/mapObjects.ts`（记录解析）、`cli/src/tables/shops.ts`（条目表）。
`EventCondForm.cs:876` 读 `p32(addr + 4)` 作商店指针、`:882` 读 `u8(addr + 10)` 作店种类。

---

### 3.14 强制出击表 + 编队人数

「这一章能带几个人上场、谁必须上」是阵容分析的前置条件。**两张表，一条链路。**

#### 3.14.1 编队人数 = 初始配置块的条数

**不需要新表。** 每章能出击的人数就是 §3.11.3 那个初始配置块（condition slot 10）的
**记录条数** —— 游戏自己的 `GetChapterAllyUnitCount`（`0x08012344`）就是数它，
一格一条 20 字节记录，读到 `u8(+0) == 0` 为止。`cli` 里叫 `Chapter.deploySlots`。

难度分开时游戏换用 slot 11 的块 → `Chapter.deploySlotsHard`
（本 ROM 只有 C10B 两者不同：12 → 9）。

**未使用的槽位不是空的，而是填了一条模板记录**：同一个 `unitId` 配一个当章的 `classId`。
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

#### 3.14.3 `route` 字节静态判不了

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

### 3.16 DoF 的战役结构（**结论存档，不是 CLI 能力**）

> **这一节是结论存档。** 它由「读 `cli/out/*.json` 再推理」得出，不是 ROM 解析。
> 它曾经由 `cli/scripts/training-plan.ts` / `economy-plan.ts` 两个脚本产出报告 —— **那两个脚本已删除**：
> 它们把路线结构、评分权重、「谁是调试单位」这类**判断**硬编码进了 TS，而且同一份结论在两处各写了一遍。
> 边界规则见 **AGENTS.md §1.2**。本节保留的是**结论本身**（分线结构、回退规则），下次分析可直接复用，
> 但**不要**把它重新写回 CLI。
>
> 判断依据仍是 §3.11 / §3.14 的解析结果。

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

**两条陷阱：**

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

**「练谁」的模型骨架**（当时的口径，留作下次分析的清单，已不落在代码里）：
窗口（可出场章数）/ 预期（均匀轮换出场章数）/ 练满（满勤终盘五维和）/ 空间（练满 − 当前）/
独占（有几章是全场唯一承担该职能的人，只看杖·飞行·重甲·再动·盗贼）。
**评分权重是拍出来的** —— 正因为它不是 ROM 数据，所以不该出现在 CLI 里（§1.2）。
这类报告现在由 agent 读 `cli/out/*.json` 现场产出。

#### 3.16.3 加入点的可用性回退规则（值得复用）

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
- **当时的产物**（已随脚本删除；`cli/out/` 本身也是 .gitignore 的生成目录）：
  `dream-of-five.analysis.md`（v3）+ `dream-of-five.training-plan.md` + `dream-of-five.economy-*.md`。
  现在 `cli/out/` 里只剩 CLI 自己产出的 `dream-of-five.*.json`。

---

### 3.19 敌人摆放 —— FE8 没有「敌人表」，敌人在同一个配置记录里

**一句话结论**：FE8 **没有**一张「敌人摆放表」。玩家、友军、敌人用的是**同一种 20 字节记录**，
是不是敌人由记录自己 `+3` 字节里的 **2 个 bit** 决定；而记录块由**事件脚本**引用。
所以「敌人在哪」= 「顺着脚本走，读每条记录的阵营位」。

#### 3.19.1 记录格式（FE8U 20 字节；FE6/FE7 是 16）

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

**`+3` 是 u8，不是 u16** —— `+4` 就是座標。参考代码里 `InputFormRef.Init`
（`EventUnitForm.cs:166`）写成 `u16(addr+3)`，`EventUnitForm.cs:501` 又写 `u8(addr+3)`；
按 u16 读会把两个字段混在一起（`(x>>3)&0x1f` 恰好还对，但原始值是脏的）。
CLI 取 u8。

#### 3.19.2 `+3` 位域 = 「这单位是谁的」

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

#### 3.19.3 块由**事件脚本**引用（没有别的入口）

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

**DoF 实测：完全不用「簡単/普通以上」双指针形态**（`40050200 <ptr> 40050300 <ptr>`，
带指针校验的字节扫描 = **0 例**；单指针 247 例）。所以反汇编器不会漏读「簡単」那块。
DoF 的双指针只有 3 处「普通以上」，三指针 1 处。

#### 3.19.4 章节的初始敌人在哪 → **START_EVENT（槽 18）**

条件表 20 槽里 **FE8 没有 `ENEMY_UNIT`**（`eventcond_FE8.txt`；FE7 才有，槽 6–9，FE6 在槽 5）。
FE8 的常规章节初始敌人靠**章开始事件**用 `402C0100` 摆进去。DoF 实测：

- **槽 0 TURN** 223 块 —— 增援
- **槽 18 START_EVENT** 209 块 —— 初始敌人 + 招募
- **槽 2 OBJECT** 25 / **槽 3 ALWAYS** 18 —— 事件触发式
- **槽 19 END_EVENT** 27 —— 收尾

#### 3.19.5 ROM 侧访问器（决定性证据）

| 函数 | 地址 | 读哪 |
|---|---|---|
| `GetChapterAllyUnitDataPointer` | `0x08083348` | 条件表 `+0x28`（槽 10）；`gChapterData[0x14] & 0x40`（**hard mode**）时读 `+0x2c`（槽 11）；魔物图读 `+0x30/0x34/0x38`（槽 12–14） |
| `GetChapterEnemyUnitDefinitions` | `0x080833B0` | `+0x3c/0x40/0x44` = **槽 15/16/17 = `FREEMAP_ENEMY_UNIT`** |
| `GetChapterAllyUnitCount` | `0x08012344` | `GetChapterAllyUnitDataPointer()` 后按 20 字节步长数到 `u8(+0)==0`，**不过滤阵营** |

**`GetChapterEnemyUnitDefinitions` 不是「常规章节敌人表」** —— 它只读魔物图那三个槽。
`0202BCF0 = @ChapterData`，`@ChapterData@0E` = マップID，`@ChapterData@14 & 0x40 = Set for hard mode`
（符号表里逐字写着）。`GetChapterEventDataPointer @ 0x080346B0` 就是拿 mapId 取条件表。

#### 3.19.6 实测普查（`cli/scripts/unit-placement-census.ts`）

DoF：**502 个块**、**2723 条敌人记录**、88 个敌人职业、等级 0–20（均值 9.7）。
自检全绿：0 个空块 / 0 个职业 id 落在职业表外 / 0 个 `unitId==0` / 0 个非敌人记录 lv>20 /
槽 10 里 0 条非自军。**这条链是通的，敌人属性可以开始算。**

#### 3.19.7 两个真发现（别当成 bug 去"修"）

**① `mapIndex 22`（C10B: Needle's Eye）是全 ROM 唯一 `槽11 ≠ 槽10` 的章节。**
槽 10 = 12 条自军；槽 11 = **9 条全是友軍**。因为 `GetChapterAllyUnitCount` 不过滤阵营，
hard 模式 `deploySlotsHard` **真的是 9**。而那 9 条**同时被 start event 用 `402C0100`
（`0x14c2128`）加载**，所以绿军本来就会出场 —— 可疑的只是「出击位数量」。
**上机核实之前不要信这个数**。

**② 11 个章节填了槽 12–17**（魔物遭遇用的 3 套自军 + 3 套敌人，各约 9 条）。
这些是「随机遭遇版」的编成，**不是章节初始敌人**。

#### 3.19.8 下一个坑（已经走了 → 见 §3.20）

敌人属性可算，但 **`GetAutoleveledStat` 会烧随机数**（见 §3.18.6）：基准
`成长 × 等级 / 100` 确定，末位有 ±1 随机成分 → 输出应是区间，不是定值。
而且**敌方装备**在记录 `+12..15`，武器重量/攻速要接道具表。
**§3.20 把这条链走完了。**

---
