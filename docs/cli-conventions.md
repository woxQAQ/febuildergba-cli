# CLI 工程约定与验证策略（§5 / §6）

> **本文件是 `AGENTS.md` 的拆分件**（原 `§5 + §6`）。章节编号保持原样，`§x.y` 交叉引用仍有效。
> 索引见 [`docs/README.md`](README.md)，入口是 [`AGENTS.md`](../AGENTS.md)。

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
