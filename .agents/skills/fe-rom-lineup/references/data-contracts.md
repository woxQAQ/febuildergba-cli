# 数据契约与推导边界

本文件按需解释当前接口，不保存尚未实施的改造提案。下列 `src/` 路径均相对仓库根；若文档与当前实现或实测不符，以实现和实测为准，并在答案中说明差异。

## 1. 命令输出与输入状态

成功的 CLI 输出统一经过 `src/cli/emit.ts`，形状为 `{ data, meta }`：

| 命令                                                                                 | `data` 形状                 |
| ------------------------------------------------------------------------------------ | --------------------------- |
| roster / joins / availability / niches / roles / projection / transitions / recruits | 数组                        |
| gains                                                                                | `{ gold, items }`           |
| expcurve                                                                             | `{ budgets }`               |
| extract                                                                              | `{ db, elapsedMs, tables }` |

`meta` 包含 `command`、`path`、`diagnostics`，DB 命令还包含 `game`。`expcurve` 的 `meta.parameters` 包含 `actor`、`difficulties`、`sources`、`assumptions`；不要读取旧路径 `meta.actor` 或把内部分析函数的返回结构当 CLI 信封。

`meta.diagnostics` 是本次命令实际触发的诊断，不是整个库的完整性证明。读事件时会带出 partial 和 debug map 排除信息；只读单位的命令没有义务触发事件诊断。提取进度与运行时警告仍可能在 stderr，失败时检查退出码及 stderr。

SQL 查询前确认所需输入可用：

```sql
SELECT chapters_available, events_available FROM inputs;
```

这些布尔列在 SQLite 中是 0/1；0 表示该层不可用，不能把相关空表当作“没有单位、事件或收益”的证据。章节与事件分析由 `src/analysis/service.ts` 检查 availability。旧库被拒绝时重建；不要修改旧库伪装成新 schema。

## 2. 候选集合与入队证据

入队规则在 `src/analysis/appearances.ts` 的 `isPlayerArmyAppearance`：

- 玩家侧 `placement`；
- 玩家侧 `recruit`，或友军侧 `recruit` 且单位具有 character 标记（当前取 `hasSupportData`）；
- `load` / `cutscene` 不构成入队；敌方 recruit 也不能单凭该指令当作入队。

收集过程排除 debug map，并过滤没有职业、等级与物品内容的占位布阵行。这里的证据是静态识别结果，不是一次实际游玩的招募记录。

`availability.data` 的四种 `joinState` 为 `on_route` / `off_route` / `unresolved` / `never`。完整 joiner 集合用 `joinMapIndex !== null`；当前播放序上的集合用 `joinState === "on_route"`。`joinUnresolved` 只有两种非空原因：

- `recruit-from-enemy`：敌方 recruit 记录不能确定是真招募还是普通生成；
- `load-only`：出现于玩家或友军侧，但没有已识别的入队指令，交接时点未定。

不自己补入队章。`never` 只陈述当前模型没有识别到入队；有 partial 或不支持的机制时，不扩大为游戏中绝不可能入队。

`derived_play_order` 是一条线性化播放序，含插入的外传，不覆盖所有分支。要进一步判断离线入队地图是否有转场入口，用 `transitions.data` 构图，从播放序地图沿正向边取可达闭包。到不了只证明当前转场图无入口，不证明所有脚本机制都无法进入。

全名册审计使用四个数：

1. `roster.data.length`：有 support 且非空的单位数；
2. `joins.data` 中 `kind === "join"` 的行数；
3. 名册 ID 集合减 joiner ID 集合；
4. joiner ID 集合减名册 ID 集合。

后两项必须按 ID 集合差计算，不能用两个计数相减。名册内未识别入队者包含 unresolved 和没有入队证据的单位；不要统称永不入队。`joins` 每单位至多一条 join 和一条 appearance，不能用总行数除以 2。

## 3. SQL 只补充同一批 ID

读取成长时可以取原始行，再以候选 ID 集合过滤：

```sql
SELECT id, name, class_id, level,
       growth_hp, growth_str, growth_skl, growth_spd,
       growth_def, growth_res, growth_lck
FROM units ORDER BY id;
```

这个查询本身不是候选池。用 `availability` 得到的 unit id 筛选结果，核对每个候选都有且只有一行；不能再次加 `has_support_data = 1` 而漏掉名册外入队者，也不能让空槽进入比较。若使用 SQL `IN`，参数绑定这些候选 ID。

`units.growth_*` 是个人成长；`classes.enemy_growth_*` 是敌人职业成长。`growth_total` 不描述分布，不能替代声明过的加权成长分。权重属于本次策略，不是固定的 ROM 事实。

常用字段归属：

| 事实                         | 当前表/列                                          |
| ---------------------------- | -------------------------------------------------- |
| 职业原始反向关联字节         | `classes.base_class_id`；不能单独推导转职方向      |
| 单位所处职业的晋升标记缓存   | `units.class_is_promoted`                          |
| 转职加成                     | `classes.promotion_bonus_hp` 等六列，无幸运加成    |
| 分支表                       | `class_branches.class_id / branch_1 / branch_2`    |
| 物品类别、武器标记、等级字母 | `items.type_name / is_weapon / weapon_rank_letter` |
| 转职效果码                   | `item_promotions.effect_code`，不在 items          |
| 商店内序号                   | `shop_items.position`                              |
| 事件加载中的单位             | `event_unit_loads.block_id` → `load_block_units`   |

`projection`、`availability`、`niches`、`gains`、`joins` 是计算结果，不是可直接查询的同名表。章节顺序与敌人推导属性分别物化在 `derived_play_order`、`derived_unit_stats`。`chapter_placement_steps` 是入场移动，不是敌人 AI 行动记录。

`node:sqlite` 的 `StatementSync` 支持 `.get()` 与 `.all()`。SQLite 中 SQL 数值字面量 `0x2d` 就是整数 45；把 `"0x2d"` 作为字符串参数绑定不等于绑定整数 45。`sqlite3` 使用显式 `-json` / `-csv` / `-list`，不依赖本机默认显示格式。带字符串常量的 SQL 用文件、参数绑定或带引号的 heredoc，避免 shell 引号吞掉 SQL 引号。

## 4. projection 的实际数学含义

权威计算在 `src/analysis/projection.ts` 的 `growBy`、`maxedStats`、`ceilingThrough`：

1. 从 `startingStats`（class base + unit delta）出发，应用当前职业 cap；
2. 加 `growth_* × max(0, 20 − level) / 100`，应用当前职业 cap；
3. 若有转职目标，加目标职业的六项转职加成并应用 cap；
4. 按转职后 1 级到 20 级的 19 次成长累计，再应用目标职业 cap；
5. 展示时保留一位小数。幸运没有该实现中的职业 cap，体格不在 StatLine 中。

例如 50% 成长率累计 10 级得到 5 点；每次随机成长都成功才是 10 点。当前实现未追踪随机分布，先累计再截断也不自动等于随机截断后的期望。源码注释的 ceiling / every growth succeeded 与这个算式不一致，解释输出时采用算式语义，不能保证实际值一定低于它。

`projection.data` 覆盖非空名册与已识别入队者的并集；仍用候选 ID 过滤。如果候选确实没有行，检查空槽、识别口径及数据缺失，不凭空重算替代。

- `promotable` 直接表示当前职业在模型图中有出边；
- `maxedByBranch` 给每个直接目标的属性，最多建模一次转职，不递归完成多级链；
- `maxed` 取 class id 最小分支；无出边时只在当前职业内成长；
- 可转职单位没有“不转职”的投影分支；
- `classLine` 是去重名称后的展示，可能含入队前的基础职业，不能按项数算剩余转职次数；
- `promotedAtJoin` 同时要求晋升标记与无出边，false 不等于能转职。

转职图复用 `src/model/promotion.ts` 的 `buildPromotionGraph`，分支表为主源，原始反向关联辅以排序仲裁。不要自行用 `base_class_id` 或分支表的零值取代这个规则。模型没有出边时，区分“已知终位”与“方向证据不足”；不把所有无边职业都标成同一种结论。

## 5. niche 是能力线索

`src/commands/niches.ts` 按 `武器集|移动方式@特殊行动` 分组；`+` 连接的武器是同一职业可用武器的并集。`roles` 只在需要更细地查看移动分类时运行。

`classCount === classIds.length`，是该 niche 中非空职业的原始条目数，没有按同名同 profile 折叠。名字可能重复；实际连接用 class id。它不衡量玩家侧拥有多少个独立选择。

`joinerCount` 按不同单位计数，包含当前职业和最多四步转职可达的职业，也包含离线入队者。四步外可能遗漏；计数为 0 只代表本次遍历没有找到，计数为 1 也不是所有机制下唯一可达的证明。不要以 `classCount === 1` 为玩家能力稀缺的必要条件。

全局可达集合还没有约束路线、道具与互斥分支。推荐时使用固定分支、固定目标时点的能力，并在合格方案中重新按 unit id 计可替代人数。武器组合不同不必然对应不同任务能力：剑枪骑兵与剑骑兵都可能满足“骑马用剑”，需要按声明的需求映射，而非强求两个完整 niche 键相等。
