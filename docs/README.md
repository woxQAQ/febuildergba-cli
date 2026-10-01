# docs/ —— AGENTS.md 的拆分件

> **为什么会有这个目录**：`AGENTS.md` 是「每次会话都会被注入」的项目指南。
> 它一度长到 167KB，其中 §3 数据字典独占 110KB —— 结果**注入时被截断**，
> 后面 2/3 的内容对 AI 实际不可见。于是按主题拆到这里。
>
> **章节编号一律保持原样**（`§3.18`、`§5.1` …）。全仓的 `§x.y` 交叉引用
> （`MEMORY.md` / `SKILL.md` / 源码注释 / `mgba/README.md`）仍然有效。
> ⚠️ 被引用的章节可能落在**别的**文件里 —— 用下面的索引查。
>
> 入口是 [`AGENTS.md`](../AGENTS.md)；**先读它的 §0.1 文档地图与 §0.2 八条最贵的教训。**

## 文件索引

| 文件 | 覆盖的章节 | 一句话 |
|---|---|---|
| [`rom-layout.md`](rom-layout.md) | §3.1–§3.4、§3.12 | 版本识别、关键指针表、角色表（52B）、职业表（84B）、地形名表（65 条） |
| [`supports-and-text.md`](supports-and-text.md) | §3.5–§3.9 | 支援关系（24B）、支援会话（20B）、相性加成（8B，**存半点值**）、Huffman 解码、两种文本格式 |
| [`chapters-and-events.md`](chapters-and-events.md) | §3.11、§3.14、§3.16、§3.19 | 出场/加入链路、编队人数与强制出击、DoF 分线结构、**FE8 没有敌人表** |
| [`battle-math.md`](battle-math.md) | §3.15、§3.17、§3.18、§3.20 | 升级抽点、战斗掷骰消耗、攻速与追击、敌人属性投影 |
| [`disassembly.md`](disassembly.md) | §3.10、§3.13 | 参考代码拿不到的东西 + **反汇编 ROM 自己的代码**的完整方法 |
| [`cli-conventions.md`](cli-conventions.md) | §5、§6 | CLI 技术选型 / 目录结构 / 命令 / 编码约定；验证策略与判据分级 |
| [`reference-build.md`](reference-build.md) | §8 | 参考程序（C#，仅 Windows）的构建与运行 |

留在 [`AGENTS.md`](../AGENTS.md) 里的：§0 定位与路径基准 · §1 目标与进度 · §1.1 `config/data` ·
§2 挖结构方法论 · §4 陷阱清单 · §7 权威来源索引 · §9 快速参考。

## 章节速查（全部 `§x.y` 一行摘要）

### §3.1 – §3.4、§3.12 ROM 布局与核心表 → `rom-layout.md`

| 节 | 内容 |
|---|---|
| §3.1 | ROM 版本识别（file offset `0xAC` 起 6 字节游戏代码） |
| §3.2 | 关键指针表（各版本 `*_pointer` 的槽位偏移） |
| §3.3 | 角色表 —— `unit_pointer`，52 字节/条（§3.3.1 增量是有符号的） |
| §3.4 | 职业表 —— `class_pointer`，84 字节/条（§3.4.1 職業特性位） |
| §3.12 | 地形名表 —— `map_terrain_name_pointer`，65 条 |

### §3.5 – §3.9 支援系统与文本 → `supports-and-text.md`

| 节 | 内容 |
|---|---|
| §3.5 | 支援关系表 24B/条（§3.5.1 C/B/A 门槛 81/161/241 与完整升级机制） |
| §3.6 | 支援会话表 20B/条 |
| §3.7 | 支援相性加成表 8B/条（§3.7.1 半点值 · §3.7.2 完整公式） |
| §3.8 | 文本解码 Huffman（`FETextDecode.cs:327`） |
| §3.9 | 文本表条目有两种格式（反 Huffman 补丁） |

### §3.11、§3.14、§3.16、§3.19 章节、事件与单位摆放 → `chapters-and-events.md`

| 节 | 内容 |
|---|---|
| §3.11 | 出场时间 / 加入章节完整链路（§3.11.8 OBJECT 槽 = 宝箱/村庄/门/商店） |
| §3.14 | 强制出击表 + 编队人数（§3.14.1 `deploySlots`） |
| §3.16 | DoF 的战役结构（分线、自由位、加入点回退） |
| §3.19 | 敌人摆放 —— **FE8 没有「敌人表」**，敌人和自军共用 20 字节配置记录 |

### §3.15、§3.17、§3.18、§3.20 战斗数学 → `battle-math.md`

| 节 | 内容 |
|---|---|
| §3.15 | 升级抽点算术 + mgba 凹点助手 |
| §3.17 | 战斗掷骰模型（一次「打这个敌人」烧掉多少随机数） |
| §3.18 | 攻速与追击（`BattleLoadAS` / `BattleCheckDoubling`） |
| §3.20 | 敌人属性投影 —— 从配置记录到攻速 |

### §3.10、§3.13 反汇编 → `disassembly.md`

| 节 | 内容 |
|---|---|
| §3.10 | 参考代码里**仍然拿不到**的东西（三个曾经的错误结论） |
| §3.13 | 反汇编 ROM 自己的代码 —— 参考代码解释不了时的终审法官 |

## 系统链路图

### 第一条要写对的链路（已实现，见 `cli/src/load.ts`）

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

### 出场/加入链路（已实现，见 `cli/src/tables/chapters.ts`，§3.11）

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

### 敌人/友军摆放链路（见 `cli/src/tables/chapters.ts` + `scripts/unit-placement-census.ts`，§3.19）

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

### 敌人属性 → 攻速链路（见 `cli/src/analysis/enemyStats.ts` + `enemy-stats` 命令，§3.20）

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

### 编队人数 / 强制出击链路（见 `cli/src/tables/forceSortie.ts`，§3.14）

```
出击位数 = 上面那个初始配置块的记录条数（= 游戏的 GetChapterAllyUnitCount）→ deploySlots
         （slot 11 的块 = 困难模式 → deploySlotsHard）

p32(0x8483C) → 强制出击表（4 字节/条，u16(+0)==0xFFFF 终止）
  → +0 u16 unitId
  → +2 u8  route  ← 比 ChapterData+0x1B（RAM 值，静态判不了，原样输出）
  → +3 u8  mapId  ← 地图设置索引，0xFF = 全图
  → 三个条件全中 = 必上
```

## 三个最容易出错的地方（按踩坑概率排序）

1. `RomInfo.*_pointer` 是**槽位偏移**，读表前必须 `p32()`（§4.2）
2. 文本表条目有**两种存储格式**，只实现 Huffman 会丢掉约一半的字符串（§4.3 / §3.9）
3. 定长表**不能读满**，职业表要扫终止符（§4.9 / §4.10）
