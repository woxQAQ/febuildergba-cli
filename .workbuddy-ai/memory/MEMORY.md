# 项目长期记忆 — FEBuilderGBA

> **数据字典在仓库根 `AGENTS.md`**（§2 挖结构 / §3 数据字典 / §3.13 反汇编 / §3.14 编队与必上 /
> §3.15 RNG / §3.16 DoF 战役结构 / §3.17 战斗掷骰 / §3.18 攻速追击 / §3.19 敌人摆放 /
> §3.20 敌人属性投影 / §4 陷阱 / §6 验证）。
> 本文件**只记判断规则与容易再犯的错**。
> 逐日过程见同目录 `YYYY-MM-DD.md`。**按重要性排序 —— 被截断时先丢尾部。**

## 定位

- **`FEBuilderGBA/` 的 C# 是只读参考**（ROM 布局的权威规格），不是要开发的项目。
- 产出在仓库根：**`cli/`**（TS，`node src/index.ts <cmd>` → JSON）+ **`mgba/`**（凹点助手）。
- 目标 ROM：FE8U hack「DoF」`fixtures/dream-of-five.gba`。**游戏代码 `BE8E01`，标题字段被改成了
  FE7U 的 `FIREEMBLEM2E` —— 以游戏代码为准。** 未支持 FE7J/FE8J/FE6J（SJIS）。

## ⚠️ 四条最贵的教训

**① `config/data` 在 `bin/Debug`，不在源码树。** `FEBuilderGBA/bin/Debug/config/data/`（422 文件）
是上游源头；`FEBuilderGBA/config/data/` **不存在**；`cli/data/` 是 vendored 副本（27 文件）。
**下「某数据不可得」的结论之前，先 `find . -name '<文件名>'` 或 `ls bin/Debug`。**

**② 别把「参考代码里没有这段计算」当成「数据不在 ROM 里」。** FEBuilderGBA 是**编辑器**不是模拟器，
从不算战斗结果。正确问法是「有没有一个 `Form` 在读这个字段」。三次翻车：出场时间 / 职业特性位 →
在 `bin/Debug/config/data/`；地形名 / 支援 CBA 门槛 → `MapTerrainNameForm.cs`、
`SupportUnitForm.Designer.cs:460` 在读；相性表「和公版对不上」→ **表没改，只是存的是半点值**。

**③ 值看起来像脏数据时，先怀疑自己漏了一层变换**（×2 / ÷2 / 有符号 / 单位 / 累计 vs 增量）。
正确动作是**反汇编 ROM 自己的代码**：`bin/Debug/config/data/asmmap_FE8.txt` = 原版 FE8U
「函数名 → 地址」映射（tab 分隔，`{U}`=美版 `{J}`=日版），hack 通常保留原版代码布局。
本机 `objdump` 不支持裸二进制 → 项目级 `.workbuddy-ai/skills/febuildergba-rom-extraction/scripts/disasm.py`
（capstone）。⚠️ 它遇一条解不出的指令就静默停止；跨数据洞要自己设 `md.skipdata = True`。
⚠️ **看到 `bl <addr>` 必须去 `asmmap` 查那个地址是什么，不能凭形状猜。** 我把
`bl 0x08000C80` 当成普通除法 helper，得出「不烧随机数」这个**完全相反**的结论并写进了报告；
它其实是 `NextRN_N`（`0x08000C0C–0x08000CC0` 整段都是 RNG 函数族）。
**「这段算术是确定的」和「这段算术带随机」是两个相反的结论，猜错的代价是整份报告的性质变了。**

**④ ⭐ 找地址的捷径：`patch2/` 里的 `#ENGINE` 补丁直接写出「要改哪条指令」。**
`FEBuilderGBA/bin/Debug/config/patch2/FE8U/SYSTEM/*.txt` 里，`ADDRESS=` /
`DETERMINATION_ADDRESS=` 是**文件偏移**，`OFF:`/`FIX:` 是**改前/改后的原始字节** ——
拿 OFF 的字节去 ROM 里核对，一致就说明「这条指令还在原地」，于是**不用翻符号表也能定位**。
实例：`PATCH_Eliminate attack speed penalty` → `0x02AB92`，`OFF=40 1A`（`subs r0,r0,r1`）→
反汇编 `0x2AB74` 就是 `BattleLoadAS`。**想要「某个机制在哪」时先 `ls patch2/FE8U/` 看一眼。**

## ⭐ 事件脚本解析的坑（已修，别再犯）

- **`parseScriptLine` 不能按 `\t` 切 info 列** —— 会丢掉描述里内嵌的 `[TERM]`/`[MAPTERM]`，
  遍历器认不出终止指令、一路读过头（症状：330 条 LOAD + 963 次 walk 中断 + 金币虚高）。
  正确做法 = `EventScript.SplitInfo`（按方括号切分）。
- **`category` 在 `sp[2..]` 里，不在 info 列**（`ParsePopupHintAndCategory`）。读错列 →
  `{ITEM}`/`{GOLD}` 检测永不成立。
- `innerFailure`：参考实现 `if (inner !== 'exit') return inner` 会在子事件非正常结束时**中断调用者**；
  本 hack 几乎每个子事件都以 unknown 收尾 → 需要 `{ innerFailure: 'continue' }`。
- **脚本里有分支**（`400A0000 <ptr>`）→ 遍历器逐段收集，**「段数」是上界**，不等于到手件数。

## ⭐ 经济（2026-10-01）

产物 `cli/scripts/economy-plan.ts` → `cli/out/dream-of-five.economy-{A,B}.md`。纯分析层。

- **物品 `+26` 是 u16「每次使用单价」**（不是 u8）。总价 = 耐久 × 单价，卖价 = 总价 ÷ 2。
  普通武器高字节为 0，用 u8 碰巧对；宝石/钱袋用高字节（Diamond `0x4E20`=20000）。
- **金币指令**：`40050300XXXX000021370000` = 入手 / `...22370000` = 失去。复合形态
  `400A0000<ptr>40050300XXXX000021370000` 在**偏移 8** 内嵌金额 → 反汇编只返回一条复合指令，
  **必须按字节扫**。全 ROM 只有 **4 条**给钱指令 + **4 个金箱**。
- **宝箱/村庄/门/制圧点/商店是同一个 12 字节 `CONDTYPE.OBJECT` 记录**，挂章节条件表 slot 2，
  `u32(+0)==0` 终止：`+0` 発生タイプ / `+2` 達成フラグ / `+4` 重载（店=条目表指针、宝箱=物品 id
  低字节、其余=事件脚本指针）/ `+6` (宝箱)金额 / `+8,+9` x,y / `+10` 種類。金箱不变式：物品栏 `0x77` 且金额 > 0。
  ⭐ **字段名/取值别去猜** —— `EventCondForm.Designer.cs` 的控件名就是答案：`OBJECT_N05/N06/N07/N08/N0A_*`
  里的 **`Nxx` 直接就是 `発生タイプ`**（05 制圧/民家、06 訪問村、07 宝箱、08 扉、0A 店），
  后缀是偏移（`J_2_FLAG`/`J_4_ITEM`/`J_6`+标签「ゴールド」/`L_8_MAPXY_9`/`J_10`）。完整表见 AGENTS.md §3.11.8。
- **消耗模型必须按 `deploySlots` 算，不能按全名单算。** 按 52 人 × 10 次/章算得出「满编要 26 万金」
  这种没用的数字；改成 `deploySlots` 后是 4 万，才和 4 万现金对得上。
- **非主线图判据（可复用）**：`startEvent < 0x1000000` = 原版 FE8U 数据区 = 遗留槽位；本 hack 新写的
  事件脚本**全部**在 `0x1000000` 以上（47/47 张主线图）。遭遇图 = 标题字面 `@001F`。
  **合并「同一张图的多个槽位」时签名只能用 `startEvent|condTableAddress`** —— 带上 `titleTextId`
  就合并不了（Castle Frelia 是槽位 56 有标题 id，63–78 指向同一脚本但 id 为 0）。
- **§3 性价比表里「有标价」≠「买得到」**：109 件里 29 件本路线商店买不到（`@001F` 秘密屋 /
  原版遗留图 / 任何商店都不卖 —— Hammerne、Bolting、Purge 都在里面）。要标 `†`。
- ⭐ **重量/追击已进模型**（报告 §3.0）：`攻速 = 速度 − max(0, 重量 − 体格)`（**只有超出的部分扣**），
  追击条件 `|攻速差| ≥ 4`（**双向**），追击 = **直接多打一次**（不是 +50%）。**体格不随等级涨**。
  **这两条是反汇编核实的**（`BattleLoadAS @0x0802AB74` 先钳位再相减；`BattleCheckDoubling @0x0802AF90`
  两处 `cmp #3`+`ble`），DoF **没改这段代码**（`0x02AB92` 的字节 = 补丁的 `OFF`）。详见 AGENTS.md §3.18。
  ⚠️ **敌方攻速曾经是常数，现在不是了**（2026-10-01 接进模型，详见下面「⭐ 敌人属性可以算了」一节
  与 AGENTS.md §3.20）。下面这段保留着「当时的判断链」，教训仍有效。
  敌人和自军走**同一个公式**（`BattleLoadAS` 对双方都跑），缺的只是**输入**。
  ✅ **「敌人在哪」已经走通**（见下面「⭐ FE8 没有敌人表」一节）：FE8 **没有 `ENEMY_UNIT` 槽**
  （FE7 在 6–9、FE6 在 5；`EventCondForm.cs:1406-1417`），敌人和自军**共用同一种 20 字节配置记录**，
  阵营由记录自己 `+3` 字节的 bits 1–2 决定，记录块由事件脚本引用。
  ⚠️ **就算走通了也不是确定值**：自动升级 `GetAutoleveledStat @0x0802B9C4` 里
  `bl 0x08000C80` = **`NextRN_N`**、`GetStatIncrease @0x0802B9A0` 里 `bl 0x08000CA0` = **`Roll1RN`**
  → 基准 = `成长 × 等级 / 100`，**随机成分 ±1 点**。详见 AGENTS.md §3.18.6。
  ⭐ **教训：反汇编里看到 `bl <addr>` 必须去 `asmmap` 查那个地址是什么** —— 我把 `0x08000C80`
  当成除法 helper，得出「不烧随机数」这个**完全相反**的结论并写进了报告。`0x08000C0C–0x08000CC0`
  是 RNG 函数族（`LoadRNState`/`NextRN_100`/`NextRN_N`/`Roll1RN`/`Roll2RN`）。
  排序键 = `期望/金 × 平均出手次数(1 或 2)`；§5 采购清单用**各阶段自己的速度**（`levelsAt` 线性摊派）。
  ⚠️ 实测：E 级铁系在**每个阶段**都是最优（40/40 选品与终盘一致）→ **早期省的不是武器钱，是追击**；
  而次一档里 **30/31 行**都有人会因此掉追击 → 不能整队统一配。
  ⚠️ 反直觉：**体格大 ≠ 带得动** —— Armour（con14/spd11）重量上限只有 `14+11−敌攻速−4`；
  按终盘敌攻速 14.8 算是 **6**（按分线前 6.3 算是 14.7）→ **「带得动」随阶段变**，
  这正是 §5 采购清单按阶段算的原因（见「⭐ 敌人属性可以算了」一节）。
- ⭐ **特效成立时武器威力 ×3**（`BattleLoadAttack @0x0802AABC` 里 `×2+×1`；判据 `IsSlayerApplied
  @0x08016C88`，倍率表 `gSlayerEffectivenessTable @0x088ADF39`）。**§3 性价比表不建模特效** ——
  所以「特效系排名低」是假象。但**即使 ×3，Ridersbane 的含追击期望/金（0.15→0.45）仍低于钢枪 0.86**
  → 关键不是「效率」而是「够不够」：敌人防御一高，便宜的武器是 0 伤害，`期望/金` 这个比值本身失效。
  **报告 §3 只能决定「日常批量采购」，特效系/银系买什么必须看具体地图。** 详见 AGENTS.md §3.18.5。

## ⭐ FE8 没有敌人表 —— 敌人在同一个配置记录里（2026-10-01）

**「定位敌人摆放表」的答案是：这张表不存在。** 完整版见 AGENTS.md §3.19。

- **玩家/友军/敌人共用同一种 20 字节记录**（`eventunit_data_size`，FE6/FE7 是 16）。
  **是不是敌人 = 记录自己 `+3` 字节的 bits 1–2**：
  `bit0` = 自动升级模式 / `bits1-2` = 阵营（**0 自军 / 1 友军 / 2 敌军 / 3 消灭**）/ `bits3-7` = 等级。
  ⭐ 判据来源：`InputFormRef.cs:993-1094`（`linktype == "UNITGROW"`）是逐字节读改写，
  下拉项文字在 `EventUnitForm.Designer.cs:1259-1263`。**别去猜字段名，控件名就是答案。**
  ⚠️ **`+3` 是 u8 不是 u16** —— `+4` 就是坐标。参考代码自己不一致（`EventUnitForm.cs:166` 写 u16、
  `:501` 写 u8），按 u16 读会把两个字段混在一起（`(x>>3)&0x1f` 恰好还对，但原始值是脏的）。
- **记录块由事件脚本引用**（没有别的入口）：`402C0100`/`402C0000` LOAD1（招募**和**初始敌人）、
  `412C0100` LOAD2、`422C0000` LOAD3、`40050200…400A0000…` 増援、`…4005030001000000…` 増援（普通以上）。
  ROM 处理器 = `Event2C_LoadUnits @ 0x0800FB84`（事件 opcode `2C`）。
- **常规章节的初始敌人在 `START_EVENT`（条件表槽 18）**；增援在 `TURN`（槽 0）/ `ALWAYS`（槽 3）。
  ⚠️ **`GetChapterEnemyUnitDefinitions @ 0x080833B0` 不是「常规章节敌人表」** —— 它只读
  `+0x3c/40/44` = **槽 15/16/17 = `FREEMAP_ENEMY_UNIT`**，是**魔物图**用的。
  常规章节读 `GetChapterAllyUnitDataPointer @ 0x08083348`：`+0x28`（槽 10）/ hard 时 `+0x2c`（槽 11）。
  ⭐ `0202BCF0 = @ChapterData`，符号表里逐字写着 `@14 & 0x40 = Set for hard mode`。
- ⭐ **`FEBuilderGBA` 的「ユニット配置」表单只列脚本引用的块** ——
  `EventCondForm.MakeUnitPointer` 只扫 TURN/TALK/OBJECT/ALWAYS/TUTORIAL，
  跳过 PLAYER_UNIT / FREEMAP_* / TRAP / START/END。所以它**不是**「玩家初始配置」的入口。
- **普查工具** `cli/scripts/unit-placement-census.ts`（支持 `--chapter N`）。
  DoF 实测：**502 块 / 2723 条敌人记录 / 88 个敌人职业 / 等级 0–20（均值 9.7）**，
  0 空块 / 0 职业 id 落在职业表外 / 0 `unitId==0`。
- ⚠️ **两个真发现，别去"修"**：
  **① `mapIndex 22`（C10B）是全 ROM 唯一 `槽11 ≠ 槽10` 的章节** —— 槽 11 是 **9 条全友軍**，
  而 `GetChapterAllyUnitCount @ 0x08012344` **不过滤阵营**，所以 hard 模式出击位**真的是 9**；
  那 9 条同时被 start event（`0x14c2128`）加载，绿军本来就会出场。
  **② 11 个章节填了槽 12–17**（魔物遭遇的 3 套自军 + 3 套敌人），**不是章节初始敌人**。
- ⚠️ **DoF 完全不用「簡単/普通以上」双指针增援形态**（带指针校验的字节扫描 = 0 例）→
  反汇编器不会漏读「簡単」那块。**做这类结论时扫描必须加「参数是合法 GBA 指针」约束**，
  否则 4 字节字面量会在全 ROM 里撞出几百个假阳性。

## ⭐ 敌人属性可以算了 —— 攻速投影（2026-10-01）

**产物**：CLI 命令 **`enemy-stats`**（`cli/src/analysis/enemyStats.ts`），
`cli/out/dream-of-five.enemy-stats.json`。经济报告的 `ENEMY_AS = 10` 常数**已删除**，
换成逐阶段真实分布。完整版见 AGENTS.md §3.20。

`敌攻速 = 职业基础速度 + 角色表增量 + 自动升级 − max(0, 武器重量 − 体格)`，四项都从 ROM 读。

- ⭐⭐ **自动升级的总开关是 `+3` bit 0，而且它在阵营判断之前。**
  `Event2C_LoadUnits` 走到 `0x08017C10` 第一件事就是 `ldrb r1,[r6,#3]; ands r0,r1,#1; beq`。
  编辑器里这一位叫「成長率: 成長させない / クラス依存」。**DoF 有 11%（303/2805）的敌人记录是 0**
  → 漏掉会把它们的属性算高。
- ⭐⭐ **`unit[+0]` = pCharacter、`unit[+4]` = pClass。顺序反了会读错成长率表。**
  证据：`AutolevelRealistic @0x08018160` 读 `unit[0]->+0x0B` 当「角色表初始等级」
  （角色表 `+0x0B` 就是等级），而 `IncreaseUnitStatsByLevelCount @0x08017FC4` 读
  `unit[4]->+0x1B` 当成长率（职业表 `+0x1B` 就是 `enemyGrowths`）。**所以敌人用职业成长率。**
- **两条路径，分派在 `0x08017C36`**：`(角色.flags|职业.flags) & 0x80` 置位 → `AutolevelRealistic`；
  否则角色 id > 0x40 → `AutolevelUnit`；否则 `AutolevelRealistic`。
  DoF 实测 **2458 / 44 / 303（无）**。`AutolevelUnit` 的 `count = 等级 − 1`；
  `AutolevelRealistic` 的 `count = 等级 − 角色表等级`，用**角色自己**的成长率逐级模拟
  （`CheckForLevelUp @0x0802BA28` 循环）。
- ⚠️ **转职那一轮的掩码是 `0x100`**（`0x0801812E`: `movs r1,#0x80; lsls r1,r1,#1`），
  即 `(角色.abilityFlags[1] | 职业.abilityFlags[1]) & 0x01` = 特性2 bit0「上級クラス(武器S)」。
  **是 `& 0x01`、而且角色与职业要 OR 进来** —— 我原先记成 `& 0x02`、只取职业，都是错的。
  加成值 = `GetCurrentPromotedLevelBonus @0x08037B44`：`gChapterData[0x14]&0x40` → **19 / 9**。
- ⚠️ **`IncreaseUnitStatsByLevelCount` 的那个 id 参数根本没被读** —— 成长率永远来自 `unit[+4]`。
  7 个字节落到 `unit[+0x12, +0x14..0x19]`（**`+0x13` 跳过**），顺序 hp/str/skl/**spd(+0x16)**/def/res/lck。
- ⭐ **攻速可以是负数，不是 bug**：`BattleLoadAS` 从有符号字节里减惩罚，引擎不钳零。
  DoF 74/2805 条为负：Gorgon Egg（速 0 拿 w10 → −4）、Artillerist（速 0 拿 Ballista w20 → −11）、
  Arch Mogall（体格 5 拿 w20 → −8.8）、Warlock（体格 10 拿 w20）。
- ⚠️ **`classId == 0` 表示「用角色自己的职业」，不是「职业 0」。** 探针里写错过一次。
- ⚠️ **按章去重 vs 全 ROM 去重，两个数都对**：`collectPlacementSites` 章内去重 → **2805** 条；
  普查脚本全 ROM 再去重 → **2723** 条。Lagdou Ruins 10（map 55）与 C15（map 36）共享 5 个块。
  **别当成矛盾。**
- DoF 实测分布：`min −14 / p25 6.0 / 中位 9.95 / p75 13.95 / max 32.0`；
  逐阶段中位 **分线前 6.3 ｜ 本线中段 9.8 ｜ 合流 10.8 ｜ 终盘 14.8**（分线点 map18 无敌人）。
  旧的常数 10 恰好等于全 ROM 中位数 —— 巧合，但说明当时拍得不离谱。
- **口径**：武器取记录 `+12..15` 里**最重**的那把（换成「第一把」中位数只动 0.1–0.3）；
  自动升级烧 RNG 所以每条是区间（报告取均值）；遍历是下界（遇到 10 条连续未知指令就放弃）。
- `validate` 新增三条检查：`enemy.records` / `enemy.statBand` / `enemy.negativeAs`（49 项 / 0 error）。

## ⭐ DoF 是分线游戏

分线前 `mapIndex` 0–8（21 人）｜A 线 9–17（9 人）｜分线点 18｜B 线 19–27（12 人）｜合流 36–50（16 人）。
（分阶段自由位表、加入点回退规则见 AGENTS.md §3.16。）

- **分组必须用 `mapIndex`，不能用 `chapterNumber`**（C6x / C7A / C7B 章号都是 7）。
- 96 条支援边 **0 条跨线** → **支援规划必须先定线**；B 线没有开局支援。
- 可玩名单三口径：255 槽 → **62** 有支援数据 → **61** 有实际伙伴 → 剔除 **Rophon(#38)**。
- **`classes.json` 的对象 key 不是 class id** → 要 `Object.values(C).find(c => c.id === classId)`。
  **转职可从 `caps` 反推**（未转职 `str/skl/spd/def` 上限一律 20，转职 ≥25）。
- 编队 `deploySlots` = 初始配置块条数；未用槽位是模板填的（683 条里 534 条是同一 `unitId` +
  当章 `classId`）→ **数条数对，数名字会数出 12 个同一角色**。
- **写校验脚本先确认字段真的存在** —— 曾用不存在的 `name` 过滤，集合恒为空、检查恒通过
  （79/79 全过）。**「全过」可能只是空集。**

## 杂项

- `RomInfo.*_pointer` 是**指针槽**偏移，表地址 = `p32(slot)`（u32 落在 `[0x08000000,0x0A000000)`
  就减 `0x08000000`）；`_address` 结尾的才是直接偏移。⚠️ 指针槽可以在**代码段**里。
- 控件名 = `<B|W|D|P><字节偏移>`，旁边 Label 的 Text 是字段名 —— 还原结构体最快。
  **表的读入规则逐字照抄 `Init()`**（定长 vs 扫终止符）；定长表读满会静默污染 ID→名字 映射。
- 角色表 `+12..+19` 是**相对职业基础值的有符号增量**（必须 `rom.i8()`）；**增量为 0 是最常见的值**。
- **跟本仓库相关的 skill 一律放项目级** `<仓库根>/.workbuddy-ai/skills/`（用户明确要求）。
  ⚠️ 项目级 skill **不在启动索引里**，`Skill` 工具调用会失败 → 直接 `Read` SKILL.md。
- 参考程序仅 Windows 可构建；`cli/` 与 `mgba/` 跨平台。`cli/out/` 是生成物（已 `.gitignore`）。
- 单位名过 `displayName()`（剥 `@XXXX`）；**章节标题不能剥** —— 地图标题分类依赖字面 `@001F`。
- RNG/凹点的判断规则在 AGENTS.md §3.15（升级抽点）+ §3.17（战斗掷骰）；
  产物 `mgba/fe-aodian.lua` + `mgba/test/`（自测 124 项，`node mgba/test/run.mjs`）。
- ⚠️ **凹点助手是只读面板，没有热键**（2026-10-01 按用户要求删掉了整套 `L+…`/`R+…` 组合键，
  包括写 RNG 的 `L+Start`）。原因：和游戏自己的按键冲突（FE8 里 `L` 是切换光标单位）+
  用户一直当只读面板用。原来靠热键调的参数现在都是 `CONFIG` 项（`FOCUS`/`K0`/`UNIT_MODE`/
  `SLOT`/`BATTLE_NUDGE`），改完要重载脚本。**别再往面板加按键。**
- ⚠️ **mGBA 面板闪烁 = 每帧无条件重画**：写一次文本缓冲就重传一次纹理 →
  「内容不变就别碰缓冲」（`CONFIG.RENDER_DIFF`）。异常同理，判据必须是「消息变了才再报」，
  **不能是「成功后复位」**（渲染每 N 帧才跑一次，中间的帧会把状态复位 → 照样刷屏）。
- **凹点的实际手法是「打敌人 → 长经验 → 升级」** → 预测必须先把「这一仗消耗几个随机数」算进去。
  ⭐ 关键：`Roll1RN`/`Roll2RN` **概率 0 也照烧 1/2 个**；`gBattleStats(0x0203A4D4)` 低位
  **1=真实战斗（已在烧）/ 2=模拟预览（一个没烧）** → **预览界面就是预测点**。
  一次普通出手：`未命中→2 / 命中→3 / 命中且必杀→4`（未命中在 `0x0802B43C` 跳走，后面全不执行）。
  ⚠️ 面板用 `+0x64`/`+0x6A`（**最终**命中/必杀），不是 `+0x60`/`+0x66`。
  消耗是**算出来的不是量出来的** → 首次用先跟「标记后烧掉的随机数」对一下，不一致用 `R+↑/↓` 修。
