# CLI、service 与 repository

一个数据库对应一份 ROM，是可以全量重建的分析快照；不维护迁移或多 ROM 平台。

## 两条流程

```text
extract command
  → extract/service.ts：读取 ROM、解码、生成完整快照
  → repository/write.ts：事务写入
  → 关闭连接、原子发布数据库

DB command
  → repository/read.ts：只读打开、检查产物契约
  → analysis/service.ts：检查所需证据、装配输入、执行分析
  → CLI 展示结果与诊断、关闭连接
```

`index.ts` 只解析、分发与输出，不预先打开命令资源。
DB 命令用 `commands/types.ts` 中的 `defineDbCommand` 共享连接生命周期，
成功或失败都在 `finally` 中展示诊断并关闭连接。

## 职责与依赖

| 模块           | 拥有的职责                                                             | 不应承担的职责                       |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| CLI / commands | 参数、资源生命周期、输出、错误展示、产物发布                           | ROM 解码、游戏规则、SQL 映射         |
| extract        | 解码和提取编排、快照物化、来源信息、提取诊断                           | 数据库、终端输出、下游分析           |
| analysis       | 证据选择、可用性策略、输入装配、按问题计算、分析诊断                   | ROM 解码、SQL、终端输出              |
| repository     | schema 检查、外键强制、SQL 映射、事务、连接、写入顺序（TABLE_WRITERS） | 解析器、游戏算法、分析选择、警告打印 |
| model          | 普通事实契约、共享纯规则                                               | I/O、service 或 repository 实现      |

`model/snapshot.ts` 的 `ExtractionSnapshot` 是完整提取结果。
它包含来源 metadata、数据可用状态、解码事实、章节顺序、单位属性和诊断，
不包含 ROM buffer、文本解码器、布局配置或操作码定义表。
`repository/write.ts` 只写入这些已有结果，不在事务内运行模拟器。

`model/records.ts` 是读取契约，返回原始单位属性 delta 和职业 base。
`analysis/service.ts` 的 `unitsOf` 用共享游戏规则装配 starting stats。
分析算法只接收各自声明的普通数据，不接收连接。

## 完整性与诊断

Repository 区分两件事：

- schema 不匹配：库早于当前构建（缺表或缺列），打开时拒绝并要求重建；
- 章节或事件输入不可用：返回提取时保存的 availability，不将空表解释为合法空集合。

产物没有 revision 计数器：库是可全量重建的，schema 守卫（缺表/缺列即拒）
已经覆盖「旧库」这一种过期形态，解码规则变化直接体现为列或表的变化。
外键在写入连接上以 `PRAGMA foreign_keys = ON` 显式开启并断言生效（SQLite
自身默认按连接关闭；node:sqlite 恰好开启，但不依赖这个驱动选择），插入顺序
即依赖顺序，悬空引用会让提取失败而不是静默存 null。少数列是哨兵而非引用
（如 `units.affinity_id` 的 0、`force_sortie.map_index` 的 0xFF），没有父行，
按设计不带外键，见 schema.ts 模块注释。读取顺序一律走显式键，不依赖
rowid。无 INTEGER PRIMARY KEY 别名表的 rowid 稳定性 SQLite 不保证，而
schema 守卫看不见这种变化。

布局缺失有两种，刻意不互换（`data/layouts.ts` 模块注释）：
字段省略 = 每游戏常量尚未转录，游戏有这张表，移植没有，提取发诊断并把相关
表留空；`null` = 游戏确实没有该表（FE6 的 `support`/`forceSortie`，各有证据），
空表即事实，不发诊断。“空表是合法空集合”只在后一种情况下成立。

写入顺序只声明一次：`repository/write.ts` 底部的 `TABLE_WRITERS` 数组，
由 `repository/pipeline.ts` 的 `assertWritePipeline` 在每次开事务前对照
schema 校验三件事：填了未登记的表、登记了没人填的表、外键目标写在引用者
之后。它取代了过去“调用序列 + TABLES 数组 + 注释”三处各写一遍的顺序。

`prepareAnalysis` 建立一次分析会话，按实际请求的证据检查 availability。
事件不完整时保留结果，并在 `diagnostics()` 中报告限制；不可用时拒绝相关分析。
不读取事件的命令不会加载事件层或得到无关的 partial 提示。
Repository 的原始读取方法仍可用于检查缺失输入的产物，本身不执行这项分析策略。

提取 service 通过 snapshot 返回诊断；分析会话通过 `diagnostics()` 返回诊断。
CLI 决定 stderr 格式，service 和 repository 不直接打印。

## 注释语言

源码注释三语分工，每种语言只承担一个角色：

- 日文：FEBuilderGBA designer 里的字段标签（攻撃、必ず出撃、CC分岐表），是偏移量
  转录的依据，保留原样，不当翻译用；
- 中文：输出契约类型（`ProjectionPoint`、`ExpEfficiency`、道具名表等）的字段文档，
  服务 JSON 的中文消费方；
- 英文：其余全部内部 rationale。

日文只作依据、中文只写契约、英文只写原理，不跨角色混用。

## 添加一张表

系统最重要的资产是数据表，“加一张表”因此是一条被刻意维护的路径。按顺序走，
每个触点只做一件事；需要动脑的只有第 2 步（提取器）和第 6 步（表的形状），
其余是接线：

1. `src/data/layouts.ts`：每游戏的指针槽常量。跨游戏都有的表，五套常量都要抄，
   `scripts/check-upstream.ts` 会对着 `ROMFE*.cs` 机械复核抄录的数字。某游戏独有的
   表，先看 `src/tables/skills.ts` 的先例：签名搜索绕开布局常量，比在五个游戏里写
   四个“未转录”便宜。字段省略 = 常量未转录，`null` = 游戏确实没有该表，两者不可互换。
2. `src/tables/foo.ts`：提取器本体。ROM 侧唯一需要理解游戏格式的地方。
3. `src/model/snapshotRecords.ts`：记录类型；`src/model/snapshot.ts`：快照字段。
   快照是纯数据契约，ROM buffer、文本解码器、布局配置都不过界。
4. `src/extract/service.ts`：`parse()` 里按依赖顺序调用一次，并决定可用性。表缺失
   是发诊断（未转录）还是静默（游戏没有），不要发明第三种约定。提取顺序目前仍是
   语句序而非机器校验：提取器输入是真实的数据流（units 需要 class bases，shops 需要
   items，playOrder 需要 transitions），顺序错误由写入侧的外键强制兜底。
5. `src/repository/schema.ts`：drizzle 表定义 + `TABLES` 登记。DDL、行数收据、
   读取侧 schema 守卫全部从这两样派生，没有第二份手写 SQL。
6. `src/repository/write.ts`：插入函数 + `TABLE_WRITERS` 数组里按依赖顺序加一项。
   顺序由 `assertWritePipeline` 在开事务前校验，位置放错会失败在提取开头而不是
   事务中段。逐列手写映射是有意的取舍：用一点重复换编译期类型安全。
7. 仅当被分析命令消费：`src/repository/read.ts`（`TABLES_READ` + handle 方法）、
   `src/analysis/data.ts`（输入接口）、`src/analysis/service.ts`（转发与门禁）。

加一张表不碰：CLI 与命令层（除非同时加命令，那是 `commands/registry.ts` 一行的事）、
`src/analysis/` 的计算模块（除非消费它）。

## 验证

使用 `npm run typecheck`、`npm run check` 与真实 ROM 工作流验证，
不添加单元测试。架构调整若改变存储 schema（列、表、外键、顺序契约），
旧快照按设计不再可读：重新 extract 即可，同一 ROM 的新表内容与分析 JSON
应保持一致。
