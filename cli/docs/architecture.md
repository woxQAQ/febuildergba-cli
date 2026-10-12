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

| 模块           | 拥有的职责                                           | 不应承担的职责                       |
| -------------- | ---------------------------------------------------- | ------------------------------------ |
| CLI / commands | 参数、资源生命周期、输出、错误展示、产物发布         | ROM 解码、游戏规则、SQL 映射         |
| extract        | 解码和提取编排、快照物化、来源信息、提取诊断         | 数据库、终端输出、下游分析           |
| analysis       | 证据选择、可用性策略、输入装配、按问题计算、分析诊断 | ROM 解码、SQL、终端输出              |
| repository     | schema/revision 检查、SQL 映射、事务、连接           | 解析器、游戏算法、分析选择、警告打印 |
| model          | 普通事实契约、共享纯规则                             | I/O、service 或 repository 实现      |

`model/snapshot.ts` 的 `ExtractionSnapshot` 是完整提取结果。
它包含来源 metadata、数据可用状态、解码事实、章节顺序、单位属性和诊断，
不包含 ROM buffer、文本解码器、布局配置或操作码定义表。
`repository/write.ts` 只写入这些已有结果，不在事务内运行模拟器。

`model/records.ts` 是读取契约，返回原始单位属性 delta 和职业 base。
`analysis/service.ts` 的 `unitsOf` 用共享游戏规则装配 starting stats。
分析算法只接收各自声明的普通数据，不接收连接。

## 完整性与诊断

Repository 区分两件事：

- schema/revision 不匹配：无法按当前存储契约读取，打开时拒绝并要求重建；
- 章节或事件输入不可用：返回提取时保存的 availability，不将空表解释为合法空集合。

`prepareAnalysis` 建立一次分析会话，按实际请求的证据检查 availability。
事件不完整时保留结果，并在 `diagnostics()` 中报告限制；不可用时拒绝相关分析。
不读取事件的命令不会加载事件层或得到无关的 partial 提示。
Repository 的原始读取方法仍可用于检查缺失输入的产物，本身不执行这项分析策略。

提取 service 通过 snapshot 返回诊断；分析会话通过 `diagnostics()` 返回诊断。
CLI 决定 stderr 格式，service 和 repository 不直接打印。

## 验证

使用 `npm run typecheck`、`npm run check` 与真实 ROM 工作流验证，
不添加单元测试。架构调整不改变存储 schema/revision：
旧的当前 revision 快照应仍可读取，同一 ROM 的表内容与分析 JSON 应保持一致。
