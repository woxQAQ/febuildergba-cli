# 四 ROM 阵容分析实战与改进

## 方法与证据

为每个本地 fixture 启动独立 scout，使用改进前的 skill / CLI 分析 normal、
无存档、提取播放序末端的培养候选。12 人是比较预算，不是部署数。
首轮全部被提取阻塞；修复公共入口后，在原线程继续，保留失败现场。
随后读取完整 trace 中的工具调用、错误与更正，而不只采纳最终建议。

- [Dragon Herald trace](delta://thread/ksQQmHXTlB91TFSS1k3HP1U6L5LOACxJ7pIBxBCM1BfKQnJPfbRbO8DGcZ0j)
- [Dream of Five trace](delta://thread/ksQQmHXTlB91TFSS1k3HP1U6L5LOACxKApIBxBCM1BfKQnJPfbRbO8DGcZ0j)
- [The Drowned King trace](delta://thread/ksQQmHXTlB91TFSS1k3HP1U6L5LOACxKDJIBxBCM1BfKQnJPfbRbO8DGcZ0j)
- [Vision Quest trace](delta://thread/ksQQmHXTlB91TFSS1k3HP1U6L5LOACxKH5IBxBCM1BfKQnJPfbRbO8DGcZ0j)

本地完整 JSON、SQL、报告与临时比较脚本在
`out/lineup-audit/baseline/<rom>/` 和 `out/lineup-audit/recovered/<rom>/`。
它们与 ROM 一样不提交；本文件记录可重建的结论与选择依据。
原报告是发现问题的历史快照，不应在修复后继续当作已经校准的最终阵容。

## 四个 ROM 的事实

以下为新 CLI 重新提取后的集合与诊断。joiner 包括序内与序外。
下表差异数只统计 on_route 的职业/等级问题，比较最早入队地图的全部变体，
包含 normal/hard 和条件加载，不代表每个变体都实际触发。

| ROM            | roster | joiner | on_route / off_route | 主线基线差异 | partial 脚本 |
| -------------- | -----: | -----: | -------------------: | -----------: | -----------: |
| dragonherald   |     35 |     48 |              32 / 16 |            7 |       49/751 |
| dream-of-five  |     62 |     58 |              45 / 13 |           12 |       34/764 |
| theDrownedKing |     62 |     52 |               52 / 0 |            7 |       33/584 |
| vision_quest   |     62 |     58 |               58 / 0 |           21 |       41/786 |

追加 `entry-autolevel` 检查后，四个 ROM 的主线基线问题总数分别为
7、14、8、30；已有职业/等级问题与自动成长问题可重叠，不相加计人数。
它们都是当前单位表投影未覆盖的前提，不证明这些人不可用。

所有 joiner 都有单位事实与 projection；“没有缺行”不等于“入队基线正确”。
partial 计数同时考虑非 exit 的停止原因和 exit 行里的未知指令，
不能只数 `stop_reason = 'unknowns'`。

## 从 trace 到改动

- 四次 extract 同报 `writer "meta" fills "inputs", which schema TABLES does not create`：
  将已有 `inputs` 注册到 `TABLES`；保留 schema 守卫，不迁移或补旧库。
- 多个 agent 在同一个旧库上批量重复失败，Dragon Herald 随后解析空 stdout：
  skill 先单条门控，只有退出码 0 才解析 JSON，失败只重建一次。
- 投影 help 写“全部成长成功”，实际是成长率乘等级跨度：
  更正 help、契约注释与经验预算 assumptions，不改变成长算式。
- 每份报告都重写 ID 差集、成长与分支能力连接：
  增加 `candidates` 事实汇合命令；权重、排序、资源分配仍留在 skill。
- Dragon Herald 初查只看加载，漏了 Tana 的布阵等级覆盖：
  共享 appearances 保留 `placedLevel`，候选审计覆盖布阵与加载变体。
- Rona 表职业26、入队72，Laguna 的同名 Archsage 实为46/70两个 ID：
  显式输出单位表情景、入队证据和 `baselineIssues`，不擅自选择来源重算。
- Elise 自带 Whip，TDK 特殊转职物品在带掉落标记的敌背包：
  `recruits` 保留 inventory/autolevel/ext/operand position，skill 补查背包及掉落条件。
- Diane 有 S 杖但没有杖：skill 分开武器家族、个人等级与具体装备分配。
- DoF 同列两个互斥 Finale，5000/3000 金币也属于互斥事件：
  skill 检查转场、闭环、目标章与现金情景，不累加为保证经验或现金。
- Vision Quest 误读长 `group_concat`，曾错误判断 Sigrid 无兼容道具：
  归类为消费错误，按源职业 ID 精确筛行，不宣称这是 CLI bug。
- 追加验收发现 Hester、Menahan 等人 class/level 相同但启用 autolevel：
  入队证据补 `placedAutolevel`，非零时提示 `entry-autolevel`，不将空 flags 当认证。
- 独立 review 发现缺失职业可被零基础值掩盖、候选行丢失也可能通过检查：
  缺失职业标错并保留 null/空 plans；端到端检查增加候选全集/唯一性及原始证据交叉核对。

## 新的最短完整名单入口

```bash
node src/index.ts extract fixtures/dragonherald.gba --out out/dragonherald-current.db
node src/index.ts candidates out/dragonherald-current.db
node src/index.ts recruits out/dragonherald-current.db
```

`candidates` 的三个部分：

- `audit`：名册、joiner、四类 joinState 的 ID 集合、双向差及缺行。
- `units`：单位表职业/等级/成长/基线、含 autolevel 的最早入队地图证据变体、基线问题，
  以及同一目标职业绑定的属性、能力、转职步数、训练跨度与后续边提示。
- `playOrder`：模型顺序、最后一项与最后可玩项。它不证明真实终盘或路线可执行。

能力分类由 `niches` 和 `candidates` 共享。
`recruits` 提供脚本/块/行/物品定位，不将敌携带物变成已取得库存。
全局 niche 可达性、逐章可用性、资源兼容与价格仍按需查询，
无需把每个局部比较都升级为全名册审计。

## 验证与未解决边界

真实 ROM 检查使用 `npm run check:fixtures`，自动发现本地 `.gba`，
为每个 ROM 重新提取并调用全部 DB 命令。检查外键、写入收据、候选集合、
投影/分支一致性、默认与 full availability、招募库存字段和显式经验参数。
候选 ID 必须完整且唯一，入队证据与原始布阵及加载站点交叉核对，
以发现等级/自动成长在组装或序列化时丢失。
攻击方使用非默认的 level13/classPower2/promoted，防止忽略 flags 仍通过。
原始 stdout/stderr 和汇总保存在独立的 `out/fixture-check-*`。
没有 ROM 时失败，不跳过后宣称通过；不添加单元测试。

另运行 typecheck、lint、格式检查与上游数据比较。隔离 reviewer 缺少 ignored
ROM 时只能核查源码和静态检查，不能代替主线程的真实四 ROM 验证。

本轮没有重新定义入队谓词或故事路线，没有做事件分支执行器、自动库存账本、
多次转职模拟、存档属性或战斗模拟。尚未验证 ally recruit 的实际控制权、
掉落槽、救援容量、事件触发、路线最终顺序和训练可完成性。
这些限制显式保留；事实汇合不把它们包装成已解决的问题。

## 接口收敛与支援补充

审计后的接口收敛删除了 `roster`、`roles` 和 `projection` 三个 CLI 外壳：
名册审计、职业能力及属性分支统一通过 `candidates` 消费，底层投影算法、
职业分类和原始数据库事实保留。此前 trace 与产物中的旧命令是历史记录。

支援应进入队伍组合取舍，不能因这轮试用没有消费就判为无用。`supports` 保留，
skill 要求完整名单检查配对、共同出勤、成长进度、亲和加成、站位与共享等级额度，
报告对同定位替换或搭档安排的实际影响，不预设整队全 A 或直接加进个人投影分。

接口按 `aToB` / `bToA` 保留原始方向，缺失方向不补值。Dragon Herald 有14条单向
记录，旧 `reciprocal` 仅判断反向存在，会把“只有大 ID 指向小 ID”错标为互惠；
现改为两端都存在，并以四个真实 ROM 的原始 `support_partners` 逐项交叉核对。
加成表及运行时规则仍需另查，不由配对记录直接推算已获得战斗收益。
