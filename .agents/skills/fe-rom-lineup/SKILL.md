---
name: fe-rom-lineup
description: Recommend a Fire Emblem GBA training lineup from a ROM or extracted db. Picks joiner candidates, then scores growth quality, class differentiation, join timing, promotion-item and weapon economy, and special classes. Use when asked which units to train or field, or to compare units or classes from a ROM in this repo.
---

# 阵容推荐：从一个 ROM 到一份可审计的名单

回答「给你一个 ROM，推荐一个阵容」。产出是一份排序后的名单加每人的理由、稀缺能力覆盖表、一份声明过的假设清单。不产出战斗模拟、不产出必胜承诺。

整份答案的通货是假设：把策略选择写出来，把从表里读出来的数字和算出来的数字分开。仓库里声明假设的既有形状见 `src/analysis/expcurve.ts` 的 `meta.assumptions`，照它做。

## 0. 先有产物

所有命令从仓库根跑，`node` 需要 22.18 以上，输出是 JSON。

```bash
node src/index.ts extract <rom.gba> --out <db>   # 只解析一次，之后全部读 db
```

- 一个 db 对应一个 ROM，是全量重建的快照，不要为每个问题重新解 ROM。表与契约见 `src/repository/schema.ts`，两条流程见 `docs/architecture.md`。
- extract 若告警「N/M event scripts ... partial」，把它写进答案：事件派生的事实是上界，不是一次通关。告警只写 stderr，而且 `extract` 的 JSON 里没有 warnings 字段，所以**不要用 `| tail` 截断它的输出**，会把它切掉。
- 开头核对规模，看**三个**数：`roster` 行数、`joins` 的入队行数、以及两者之差（名册里永不入队的人数）。四个 fixture 实测：dream-of-five 62/58 差 7；Vision Quest 62/58 差 4；dragonherald **35/48 差 1**；theDrownedKing 62/52 差 10。
  前两对数没有判别力（62/58 出现两次），差值与第三个方向才有：**名册比候选池小**（dragonherald 差 1，但池子是 48）说明这个 ROM 的多数可操作单位没有 support data，不能拿名册当池子。
- `joins` 每个单位输出两行（`kind="join"` 与 `kind="appearance"`），入队行数指前者。dream-of-five 上是 58 join + 235 appearance = 293 行。

## 1. 候选池 = 入队者，不是名册

```bash
node src/index.ts joins <db>         # 每单位两行：join（最早进玩家军）与 appearance（最早露面）
node src/index.ts availability <db>  # 每单位 joinPosition / joinMapIndex / availableCount / gaps / 逐章状态
```

- 名册（`roster`，即 `has_support_data`）里有相当一部分单位永远不入队，不是候选；反过来，**入队者里也可能有名册外的单位**。四个 fixture 实测名册外的入队者：dream-of-five 3 个（Sorcha 63、无名 66、重名 Garath 185）、dragonherald **14 个**、Vision Quest 与 theDrownedKing 各 0 个。dragonherald 的 48 个入队者里 14 个不在名册里，接近三分之一。不要假设两个集合互相包含，也不要把「名册等于池子」当成小块和大的差别——dragonherald 的名册（35）比池子（48）还小。
- 池子一律用命令取，不要在 SQL 里数。可达性遍历（布阵块 + 可达 load 点 + recruit 判定 + debug 图排除）住在 `src/analysis/appearances.ts`，手写 SQL 会数出另一个数。
- `availability` 对所有见证过的单位出行，含敌人与 NPC。入队者的判据是 `joinMapIndex` 非 null，**不是** `joinPosition`。两个字段会分叉：在播放序外地图上入队的单位有 `joinMapIndex` 但 `joinPosition` 为 null（dream-of-five 有 13 个），用前者不会漏人。
- **已知上限（一）**：`derived_play_order` 是**单条路线**的线性化，外传按插入点拼接，其他分支只留在 `meta`。所以分叉 ROM 上 `joinPosition: null` 有两种含义：只在另一条线入队，或永远不入队。用 `transitions` 区分：能走到主线的就是前者。四个 fixture 实测这种单位 dream-of-five 13 个、dragonherald 16 个、Vision Quest 与 theDrownedKing 各 0 个——dragonherald 的 16 个里有 11 个挤在**同一张不进播放序的地图**（map 60）上，别把它当成 11 个独立的分支入队。占比从六分之一到三分之一，见 §5。
- **已知上限（二）**：只用 `LOAD2`（`load` 而非 `LOAD1`）登场、之后靠脚本转为可操作的单位，静态上判不出入队。Vision Quest 有 4 个这样的名册单位（Hollace 18、Erasmus 19、Otilie 49、Rakkaus 68）。遇到「有 support data、有头像、但 `joinMapIndex` 为 null」的单位，写进分析的限制段，不要自己补一个入队点。

## 2. 成长质量：按分布加权，永远不看总和

```sql
SELECT id, name, growth_hp, growth_str, growth_skl, growth_spd,
       growth_def, growth_res, growth_lck, growth_total
FROM units WHERE has_support_data = 1 ORDER BY id;
```

- `growth_total` 是陷阱列。同一个总数可以是两种命：dream-of-five 上 Dismas 总和 425 里幸运 225，Rophon 总和 1111 里幸运 1。
- 得分 = 七个成长列的加权和。权重是策略不是数据，必须在答案里声明。默认起点：spd 1.2、str 1.0、skl 0.8、def 0.8、res 0.5、hp 0.4、lck 0.1。改动权在用户。
- 成长只描述轨迹，不描述终点。上下界用 `projection`（起始属性与满练上限，cap 分步生效），不要自己算。
- `maxed` 是**期望值**（成长率乘等级数再除 100），不是「每次成长都成功」，所以带小数。它只给 class id 最小的那条分支；每条分支各自的上限在 `maxedByBranch` 里。按属性取跨分支最大值会拼出一个不存在的单位。
- `promotedAtJoin` 的含义是「这个职业没有可转的目标了」，不是从单位表的 `is_promoted_class` 直接抄的。三阶链里一个职业可以既是转职目标、又还要再转一次（Vision Quest 的 Mage 37、Shaman 45、Pirate 66），现在它们会正常给出 `maxedByBranch`。若某单位 `maxedByBranch` 为空、而它的 `class_branches` 有子节点，那是数据里没有出边，不是 CLI 漏了。

## 3. 职业差异化：练一个单位的理由是它的 niche

niche 键 = 武器集 × 移动方式 × `special_action`。这个集合直接由命令给出，不要手写 SQL：

```bash
node src/index.ts niches <db>          # 每个 niche：武器集、职业数、能到达它的入队者及其名字
node src/index.ts roles <db>           # 每个职业的 mobility 分类
node src/index.ts projection <db>      # 每单位的 classLine / maxed / maxedByBranch
```

- `niches` 的输出按「稀缺但可达」排序：`joinerCount` 为 1 的在最前，为 0 的（没有任何入队者能到）垫底。一个只有一两人能到的 niche 就是练这些单位的理由；一个人人都能到的不构成理由。
- 计数按 **profile**，不按名字：职业表里有同名同 profile 的重复条目（Vision Quest 的 Hero 17/18、Paladin 7/8、Thief 13/14、Rogue 50/51）。`niches` 已经把同 profile 合到一行。
- 一个职业可以同时是「转职目标」与「还要再转一次」的中间层（三阶链）。不要因为它在某个 niche 里出现过就当成终位。
- 上限集中度：武器集窄、攻击侧上限高的专精职业优于同成长的万金油职业。这是「狂战士优于勇者与圣骑」的结构化解释，依据是 `maxedByBranch` 里各分支的 cap，不是名字。
- `wl_*` 的数值是武器等级，不是字母也不是名字：`1/31/71/121/181/251` 分别是 `E/D/C/B/A/S`。换算实现是 `src/tables/items.ts` 的 `weaponRankLetter`。CLI 没有命令输出字母，所以**直接用数值比大小**（>0 即有该武器），不要自己猜字母（实测常见错误：把 121 读成 A、181 读成 S，实际是 B 和 A）。
- **`+5` 不是单向的，不要自己写转职图。** 实测两个 ROM 上它是成对互指的（`Brawler 1.+5 = 3`，而 `Great Chief 3.+5 = 1`），字段本身说不出哪端是基础。方向靠 `sortOrder` 仲裁，而 hack 可能不填（Vision Quest 127 个职业里 51 个为 0）。`buildPromotionGraph` 的处理是：分支表当主源；`+5` 只在两侧都有排序、且目标不是分支表里的基础职业时才参与。`niches` 和 `projection` 都已经用它。
- **已知上限**：两份数据都无法表达方向时，该职业拿不到转职目标。实测两类：`+5` 自指（Vision Quest 的 Axe Cavalier 56 → 56）、排序未填且 `+5` 指向外（dream-of-five 的 Enforcer 90）。舞娘与傍子是终位职业，本来就没有转职。这类单位在答案里标「转职方向未定」，不要猜。

## 4. 技能：原版为空， hacked ROM 才进场

先看规模：

```sql
SELECT (SELECT COUNT(*) FROM skills) skills, (SELECT COUNT(*) FROM unit_skills) unit_skills,
       (SELECT COUNT(*) FROM class_skills) class_skills,
       (SELECT COUNT(*) FROM unit_skill_learn) unit_learn,
       (SELECT COUNT(*) FROM class_skill_learn) class_learn;
```

- 全 0 就是原版 ROM，本节跳过，不要浪费步数。GBA 三部原版模型没有技能。
- 有行时（hacked ROM），三个来源形状不同，要按单位拼：`unit_skills` 是固有技能，`class_skills` 是职业静态绑定（通常在职业名上就能看出，如 Canto / Dance / Steal），`class_skill_learn` 是分级习得。职业带技能的权重高于单位固有技能，因为职业表现一个单位的定位。
- `class_skill_learn.level` 的 **255 是哨兵**，意思是“无等级门槛”，不是“永远不学”。有技能系统的 ROM 上这类行往往占一半以上（Vision Quest 168 行里 68 行是 255）。
- 四个开关列 `player_only` / `enemy_only` / `both_sides` / `hard_only` 决定生效范围，读它们再决定要不要算进玩家侧的强度。

## 5. 入队窗口

```bash
node src/index.ts availability <db>                          # joinPosition / availableCount / gaps
node src/index.ts expcurve <db> --actor-level <入队等级>       # 逐章经验带宽
node src/index.ts expcurve <db> --difficulty hard            # 只看一个难度；默认三个都出
```

- 窗口长度 = `availableCount / totalAfterJoin`，但**先判 null 再除，否则整个池子里有三分之一的单位会算出 `NaN`**。`availableCount` / `totalAfterJoin` / `gaps` 是 `number | null`：**入队章不在播放序上时为 `null`**（不是 0）。判据是 `joinPosition === null && joinMapIndex !== null`（`joinMapIndex` 为 null 是永不入队，是另一种情况，两个都要能报出来）。四个 fixture 实测：dream-of-five 58 个入队者里 13 个、dragonherald 48 个里 16 个，Vision Quest 与 theDrownedKing 各 0 个。为什么不是 0：0 会被读成“没入队”，而这些单位确实入队了，只是在播放序没覆盖的地图上，主线窗口无定义。晚期入队单位没有多少章来回本，窗口长的才配折价。
- 对这批单位不要自己编一个窗口。他们可能在支线、外传，也可能只在跳章菜单里——**写进限制段，让他们按成长分和 niche 参评，不按窗口折价**。
- `gaps` 的元素形状是 `{ fromPosition, toPosition, reason }`，不是 `start`/`end`。`availableCount` 已经扣过它们。注意：有 gap 的单位里，相当一部分的唯一 gap 就在自己的入队章，所以“可用章数”会系统性的少算入队那一章。这是 `availability` 的启发式边界，写进限制段即可。
- 想看经验带宽而不是章数，用 `expcurve --actor-level`。它给每章的 `totalExp` 与 `expectedLevels`，从入队章起累加就是该单位的经验上限。**不要直读 `expectedLevels` 当“还能升几级”**，它不 clamp 到 20 级；只用它做相对比值（例如“晚期入队者只吃到 35% 的剩余预算”）。
- **难度是一条真的轴，不要按一种难度把话说死。** `expcurve --difficulty easy|normal|hard` 只出一个难度的预算，默认三个都出（所以一次输出是 3 × 章数行）。实测同一条主线 easy→hard 的经验预算：dream-of-five 31137→54302（+74%）、vision_quest 38972→90035（2.3×）、theDrownedKing 44919→72961（+62%）、dragonherald 50343→60387（+20%）。同一个晚期入队单位在两个难度下的窗口结论可以反过来，所以在答案里声明按哪个难度说话，并且换难度时要重算而不是照抄。

## 6. 转职道具：时机与分配

```sql
-- 道具本体
SELECT id, name FROM items WHERE is_promotion_item = 1;
-- 哪些基础职业能用这件道具（不是它能转出的职业）
SELECT item_id, class_id, effect_code FROM item_promotions;
-- 哪些商店进货转职道具，按章
SELECT s.map_index, si.item_id FROM shop_items si
  JOIN shops s ON s.id = si.shop_id
WHERE si.item_id IN (SELECT item_id FROM item_promotions);
-- 宝箱
SELECT map_index, item_id FROM map_objects WHERE kind = 'chest';
```

把 SQL 写成文件或用 heredoc 跑，不要在单引号 shell 字符串里嵌单引号，否则 `kind='chest'` 会被 shell 吃成 `kind=chest` 并报 `no such column`。

- **先确认这件道具拿不拿得到，再谈分配。** 每件 `is_promotion_item=1` 的道具都要把三个来源（`shop_items`、`map_objects` 宝箱、`gains` 的 `items[]`）求并，零结果的写进限制段，不要当可分配资源。Vision Quest 的 Katzbalger 138 就是零路线。
- 事件授予用 `gains` 命令取（`items[].mapIndex` 与 `items[].unitId`）。`event_item_grants` 表本身没有 `map_index`，不要直接查它。
- **点名授予要拆。「点名」指 `unitId` 是真实单位 id**：`65535` 是“当时行动的单位”，`0` 是无指定，`null` 是没有单位字段。dream-of-five 的 88 条授予里只有 **21 条**真正点名了单位，52 条是 `65535`，6 条是 `0`，9 条是 null。只尊重那 21 条。
- **`item_promotions.class_id` 的语义是「能用这件道具的基础职业」**，不是「它能转出的职业」。验证：万能道具（effect_code 45）在 Vision Quest 上列 43 个职业，全部非终位（按 `promotes_to_class_id` 判）；`Rogue 51` 不在列表，`Thief 13` 在。`classes` 表没有 `is_promoted_class` 列（那列在 `units` 上），终位判据用 `promotes_to_class_id = 0`。
- **时机必须先折成 play position**：`map_index` 到 `derived_play_order.position`。不在播放序里的地图不在主线上，这种道具报「无主线时机」，不许报「早期」。但**不要把具体例子当成规则**：dream-of-five 的秘密商店在 map 32 且不在播放序，而 Vision Quest 的秘密商店也在 map 32 却在播放序中（position 46）。每张地图都要真查，不要按商店种类推断。
- 分配规则：道具给「它能用的、niche 最稀缺的、成长质量最高的、窗口还没走完的」单位。窄口径道具（effect 25/26/27/28/29/47/49/50）给需要那条分支的人。
- **万能道具先查供给量再决定要不要分配。** Vision Quest 的 Earth Seal 136 有 20 条获取路线（10 次事件授予 + 5 宝箱 + 5 店），这是日用品，不是分配决策；dream-of-five 只有 4 份，才是真选择。供给充足就照实说，不要臆造一个“谁拿”的权衡。

## 7. 武器预算

- 金钱走 `gains` 的 `gold[].mapIndex` + `delta`，按 play position 累计。`event_gold` 表没有 `map_index`，不要直接查它。dream-of-five 主线只有 position 10 的 8000，之后的事件金都在塔图这类离线地图上。
- 价格看 `items.unit_price`（每条用量的单价，买入是 `uses * unit_price`）。**`items` 表没有 `kind` 列**，类别用 `items.type_name` 或 `items.is_weapon`。商店种类在 `shops.kind`（weapon / item / secret / prep；prep 的 `map_index` 是 NULL）。
- 结论是「第几章买得起什么」；若这条轴全程不咬死，就明说它不咬死，不要编一个约束。对照时要算**价格乘数量**：dream-of-five 的银系 50 到 100 相对 8000 收入不咬死，但 Vision Quest 的窄口径转职道具是 10000 一件，那就是真约束。

## 8. 组装答案

1. 排序名单，每人一行理由，点明是哪些轴的数值定了他的位置。排序键要自己声明（例如「稀缺 niche 优先，然后成长分乘窗口折价」），skill 不规定它。
2. 团队层的稀缺能力覆盖表：直接引用 `niches` 里 `joinerCount` 最小的几行，并明确哪些 slot 本名单没填。
3. 假设块：成长权重向量、难度、死亡策略、随机的立场（默认按成长率期望值）、extract 的 partial 告警、窗口折价公式。
4. 一句模型不承诺什么：没有战斗结果、没有安全性、没有逐章属性。

难度要写成**声明过的选择**，不是默认值：写明按哪个难度、因为什么。依据放 `expcurve --difficulty <d>` 的实测预算差（§5）。死亡策略与难度常同时变化，别只改一个。
另外把这两类"没算进去"写进假设块，而不是默默跳过：入队章不在播放序的单位（没有窗口折价，按成长与 niche 参评），以及静态上判不出入队的 LOAD2 单位（§1）。

## 不要

- 按 `growth_total` 排序。
- 用 SQL 手数候选池。
- 把 `availableCount` / `totalAfterJoin` 当数值直接除——入队章在播放序外时它们是 `null`，除出来是 `NaN`，而 `NaN` 参与排序会静默污染排名。先判 `joinMapIndex`，见 §5。
- 假设商店的 `map_index` 一定在播放序里。
- 把具体地例子当规则用（map 32）—— 每个 ROM 都要自己查。
- 把 `chapter_placement_steps` 当敌人行为，它只是初始移动意图。
- 物化单位 × 敌人矩阵；这个问题不需要战斗模型。
- 编数字。答案里每个计数都必须来自本次会话跑过的命令或查询。
- 把 node 一行式里的 SQL 嵌进单引号 shell 字符串，把脚本落成文件。`node:sqlite` 的 `StatementSync` 有 `.all()`，**没有 `.get()`**，取一行用 `.all()[0]`。
- 在 `/tmp` 下跑 `node src/index.ts`，入口文件找不到；所有命令从仓库根跑，db 路径用绝对路径。
