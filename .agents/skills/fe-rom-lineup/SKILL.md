---
name: fe-rom-lineup
description: Recommend a Fire Emblem GBA training lineup from a ROM or extracted db. Picks joiner candidates, then scores growth quality, class differentiation, join timing, promotion-item and weapon economy, and special classes. Use when asked which units to train or field, or to compare units or classes from a ROM in this repo.
---

# 阵容推荐：从一个 ROM 到一份可审阅的名单

输入一个 ROM，输出一份排序名单、每人的理由、稀缺能力覆盖表、一份声明过的假设清单。不产出战斗模拟，不承诺通关。

整份答案的通货是假设。策略选择要写出来，从表里读出的数字和算出来的数字要分开。仓库里已有的声明形状见 `src/analysis/expcurve.ts` 的 `meta.assumptions`，照它做。

## 0. 先有产物

所有命令从仓库根跑，`node` 需要 22.18 以上，输出是 JSON。

```bash
node src/index.ts extract <rom.gba> --out <db>
```

一个 db 对应一个 ROM，是全量重建的快照。解析一次，之后全部读 db，不要为每个问题重新解 ROM。表与契约见 `src/repository/schema.ts`，两条流程见 `docs/architecture.md`。

extract 若告警「N/M event scripts ... partial」，把行数写进答案，并说明事件派生的事实是上界。告警只写 stderr，`extract` 的 JSON 里没有 warnings 字段，所以不要用 `| tail` 截断输出。这条告警和 `node:sqlite` 的 `ExperimentalWarning` 共用 stderr，重定向时要把 stderr 存到文件再筛，`2>/dev/null` 会把它一起吞掉。

开头核对规模，看四个数，它们互不能替代：

| 量 | 含义 |
| --- | --- |
| `roster` 行数 | `has_support_data = 1` 的单位数 |
| `joins` 的 join 行数 | 真正进入玩家军的单位数 |
| `\|roster \ joiners\|` | 名册里永不入队的人数 |
| `\|joiners \ roster\|` | 名册外的入队者数 |

后两个是集合差，不是减法。`roster − joiners` 只是一个数，它既不等于「永不入队」，也可能为负。这两个方向各自说明一件事：名册外有入队者，说明这个 ROM 的可操作单位不在 support 表里，不能拿名册当池子；名册里永不入队的人多，说明名册里掺了不可用的头像槽。两者都出现也很常见。

`joins` 对每个单位出 `kind="join"` 与 `kind="appearance"` 两类行，入队行数只数前者。`appearance` 是「单位 × 最早露面的章」，一个单位可以有多条，路人、敌人、NPC 都算，所以总行数不是单位数的两倍。不要用 `总行数 / 2` 反推单位数。

## 1. 候选池是入队者，不是名册

```bash
node src/index.ts joins <db>         # join（最早进玩家军）与 appearance（最早露面）
node src/index.ts availability <db>  # joinPosition / joinMapIndex / availableCount / gaps / joinUnresolved
```

池子一律用命令取。可达性遍历住在 `src/analysis/appearances.ts`，包含布阵块、可达 load 点、recruit 判定与 debug 图排除，手写 SQL 会数出另一个数。

`availability` 对所有见证过的单位出行，含敌人与 NPC。入队者的判据是 `joinMapIndex` 非 null，不是 `joinPosition`。两个字段会分叉：在播放序外地图上入队的单位有 `joinMapIndex`，`joinPosition` 为 null。用前者不会漏人。

`joinMapIndex` 为 null 的单位分两种，靠 `joinUnresolved` 区分：

- `joinUnresolved` 为 null，是确认不入队。这类不进池子。
- `joinUnresolved` 非 null，是判不出。取值有两种：
  - `recruit-from-enemy`：唯一像入队的证据是敌方侧 `LOAD1`。原版用这条指令表达「说得敌方单位」，hack 也拿它当普通生成器。
  - `load-only`：单位在玩家侧出现过，但只有 `LOAD2`/`LOAD3`，没有任何一条记录把它加入队伍。脚本之后会移交。
  这两类都按「可能入队」处理：写进答案的限制段，不参与窗口折价，也不自己补一个入队点。

这些单位有 support data、有头像，但 `joinMapIndex` 为 null。`joinUnresolved` 是唯一能证明它们是「判不出」而不是「不入队」的字段，不要只凭 `joinMapIndex` 下结论。

`derived_play_order` 是单条路线的线性化，外传按插入点拼接，其他分支只留在 `meta`。所以 `joinPosition` 为 null 而 `joinMapIndex` 非 null 的单位，可能只在另一条线入队，也可能是入队点根本不在转场图的可达部分里。用 `transitions` 当有向图、以播放序的章为种子做可达闭包，方向是「主线到目标图」。闭包到不了的，答案里写「离线入队，转场图无入口」，不要因此判成「永不入队」，它们确实有 join 行。

## 2. 成长质量按分布加权

```sql
SELECT id, name, growth_hp, growth_str, growth_skl, growth_spd,
       growth_def, growth_res, growth_lck
FROM units WHERE has_support_data = 1 ORDER BY id;
```

不要按 `growth_total` 排序。总量骗人有两种形态，先判是哪种：

- 总量有方差但分布错位。同一个总数可以堆在幸运上，也可以堆在攻防速上，排序结果完全不同。
- 总量被归一化。有些 ROM 把成长总量压成常量，若干单位的 `growth_total` 完全相同，它连区分度都没有。

判据是 `SELECT COUNT(DISTINCT growth_total), MIN(growth_total), MAX(growth_total) FROM units WHERE has_support_data = 1`。两种形态的结论一样：只用加权和。

得分是七个成长列的加权和。权重是策略不是数据，必须在答案里声明。默认起点：spd 1.2、str 1.0、skl 0.8、def 0.8、res 0.5、hp 0.4、lck 0.1。改动权在用户。

成长只描述轨迹，不描述终点。上下界用 `projection` 取，cap 分步生效，不要自己算。

两个界的差是「还剩多少成长空间」，记为 `headroom = Σ(maxed) − Σ(startingStats)`，两项都取 `projection` 的输出。它和加权成长率经常分歧，而且分歧是真结论：入队已接近满级、或者已转职到终位的单位成长分可能很高，`headroom` 却接近 0。只看成长分会把已经练满的人排到最前。反过来，`headroom` 也不能单独当排序键，它奖励低等级入队的人，不看这些人后来有没有窗口。

`maxed` 是终局上限，不是期望值也不是概率。它按「当前职业从入队等级长到 20，拿转职加成，在终位职业上再长到 20」算，每一步的成长率都按满额计入，所以带小数。源码的措辞是 every growth succeeded, exactly, not a probability, and not a plan。不要把它描述成期望值，那会让读者以为这里是二项分布的均值。排序按上限说话，并在假设块里声明这是上界。

`maxed` 只给 class id 最小的那条分支，每条分支各自的上限在 `maxedByBranch` 里。按属性跨分支取最大值会拼出一个不存在的单位。

`maxedByBranch` 为空是一个可判定的状态：该单位当前职业没有出边，入队时就处在终位。这时 `maxed` 本身是对的，它是当前职业从入队等级长到 20 的上限，已经越过基础职业，没有基础段。

`classLine` 会把这类单位的基础职业排在前面，形如 `Cavalier > Paladin`，读起来像「还能从 Cavalier 走到 Paladin」，实际上这是它入队前走过的路。判断入队后还有没有得转，看 `maxedByBranch` 是否非空，不看 `classLine` 有几项。不要拿 `class_branches` 有没有子节点来驳斥这个结论：它描述的是职业的子节点，不是这个单位还能不能转。

`promotedAtJoin` 的含义是「单位自身标记为已晋升」且「当前职业无出边」，源码是 `!hasPromotion && unit.isPromotedClass`。单位表没标已晋升、但也没有出边的职业会给 `false`，不要反推成「还能转」。

## 3. 职业差异化：练一个单位的理由是它的 niche

```bash
node src/index.ts niches <db>          # 每个 niche：武器集、职业数、能到达它的入队者
node src/index.ts projection <db>      # 每单位的 classLine / maxed / maxedByBranch / promotedAtJoin
node src/index.ts roles <db>           # 每个职业的 mobility 分类
```

`projection` 覆盖名册与入队者的并集。两个集合在真实 hack 上谁也不包含谁，名册里有人永远不入队，入队者里也有人不在名册。两者都在输出里，交集才是候选池：先用 `availability` 的 `joinMapIndex` 非 null 过滤。

不要因为某个入队者在结果里没有行就以为他不可练，也不要因为名册里有人有行就把他当候选。对确实没有行的单位，写「无上限数据」，不要自己从 `classes` 表重算。重算会绕开 cap 分步、转职加成与 `+5` 仲裁，和 `maxed` 对不上。

`niches` 的排序是四键：`joinerCount` 为 0 的垫底，然后 `joinerCount` 升序，然后 `classCount` 升序，最后按 niche 字符串。开头那批就是结构性独占。

`joinerCount === 1` 不自动构成理由，要先看 `classCount`。无武器职业会让 `none|normal` 这类行有二三十个职业，却只剩一个入队者可达，它是最不稀缺的能力。值得写成理由的结构性独占是 `joinerCount === 1` 且 `classCount === 1`。`classCount` 大而 `joinerCount` 小，说明那些职业实际是敌方或 NPC 专用，不是玩家侧的选择。

`joinerCount > 0` 也不等于「可以练进去」。唯一的可达者可能入队即终位（`maxedByBranch` 为空，见 §2），那个 niche 是既成事实，不构成「练他」的理由。读 `niches` 的 `joiners` 时要用 `projection.maxedByBranch` 过一遍，否则会把已转职的人写进推荐理由。

计数按 profile 不按名字。职业表里有同名同 profile 的重复条目，`niches` 已经把同 profile 合到一行。自己写的连接一律用 `class_id` 或 `classIds`，不要按 `classes.name` join。

niche 键的文法是 `武器集|移动方式`，武器之间用 `+` 连接表示同时会，是并集不是二选一，`@xxx` 后缀是该职业的 `special_action`。所以 `axe+bow|normal` 是既能用斧又能用弓的步行职业。

`roles` 只在你要按移动方式统计、而 `niches` 的键粒度太粗时才需要。`niches` 已经把 mobility 编进键里，单纯回答「谁飞」不必再跑它。

一个职业可以同时是转职目标、又还要再转一次的中间层。不要因为它在某个 niche 里出现过就当成终位。

上限集中度：武器集窄、攻击侧上限高的专精职业优于同成长的万金油职业。依据是 `maxedByBranch` 里各分支的 cap，不是职业名字。

`wl_*` 的数值是武器等级，不是字母也不是名字：`1/31/71/121/181/251` 分别是 `E/D/C/B/A/S`。换算实现是 `src/tables/items.ts` 的 `weaponRankLetter`。CLI 不输出字母，所以直接用数值比大小，`> 0` 即有该武器。常见错误是把 121 读成 A、181 读成 S，实际是 B 和 A。

`+5` 不是单向的，不要自己写转职图。它常常成对互指，字段本身说不出哪端是基础。方向靠 `sortOrder` 仲裁，而 hack 可能不填。`buildPromotionGraph` 的处理是：分支表当主源，`+5` 只在两侧都有排序、且它指向的高阶职业不是分支表里的基职业时才参与。`niches` 和 `projection` 都已经用它。

不要自己重算这张图来校正，也不要据此断言某些边是伪造的。把守卫改成看基础侧会连方向一起颠倒，进而删掉大量真边；改成「分支表已给出该孩子」会放行反向边。想看某个单位到底能转去哪，看它自己的 `maxedByBranch`，那是这张图的输出。

两份数据都无法表达方向时，该职业拿不到转职目标。常见原因是 `+5` 自指，或者排序未填且 `+5` 指向外。舞娘与傍子这类终位职业本来就没有转职。这类单位在答案里标「转职方向未定」，不要猜。

## 4. 技能

先看规模：

```sql
SELECT (SELECT COUNT(*) FROM skills) skills, (SELECT COUNT(*) FROM unit_skills) unit_skills,
       (SELECT COUNT(*) FROM class_skills) class_skills,
       (SELECT COUNT(*) FROM unit_skill_learn) unit_learn,
       (SELECT COUNT(*) FROM class_skill_learn) class_learn;
```

全为 0 就是原版 ROM，本节跳过。GBA 三部原版的模型里没有技能。

有行时（hack），三个来源形状不同，要按单位拼：`unit_skills` 是固有技能，`class_skills` 是职业静态绑定，`class_skill_learn` 是分级习得。职业带技能的权重高于单位固有技能，因为职业表现一个单位的定位。

`class_skill_learn.level` 的 255 是哨兵，意思是「无等级门槛」，不是「永远不学」。有技能系统的 ROM 上这类行往往占一半以上。

四个开关列 `player_only` / `enemy_only` / `both_sides` / `hard_only` 决定生效范围。读它们再决定要不要算进玩家侧的强度。

技能是否进排序要显式声明。仓库不给合并规则，所以要么在假设块里写明「技能不进分数，只作定性描述」，要么自己定权重并写出。

## 5. 入队窗口

```bash
node src/index.ts availability <db>                     # 默认只出标量
node src/index.ts availability <db> --full              # 追加逐章状态
node src/index.ts expcurve <db> --actor-level <入队等级>  # 逐章经验带宽
node src/index.ts expcurve <db> --difficulty hard       # 只看一个难度，默认三个都出
```

窗口长度是 `availableCount / totalAfterJoin`，先判 `joinPosition` 再除。三个字段的 null 语义一致：

`availableCount`、`totalAfterJoin`、`gaps` 在入队章不在播放序上时都是 `null`，不是 0 也不是空数组。这三个字段描述的是同一件事，就是主线窗口。空数组会被读成「入队后一章都没缺」，而离线入队单位的窗口无定义。判据是 `joinPosition === null && joinMapIndex !== null`。

为什么不用 0：0 会被读成没入队，而这些单位确实入队了，只是在播放序没覆盖的地图上，主线窗口无定义。

另一类 null 不要混进来：`joinMapIndex === null` 是永不入队，不在候选池，不是窗口未知。

对离线入队的单位不要自己编窗口。他们可能在支线、外传，也可能只在跳章菜单里。写进限制段，让他们按成长分和 niche 参评，不按窗口折价。

`gaps` 的元素形状是 `{ fromPosition, toPosition, reason }`，不是 `start`/`end`。`availableCount` 已经扣过它们。有 gap 的单位里，相当一部分的唯一 gap 就在自己的入队章，所以可用章数会系统性地少算入队那一章。这是 `availability` 的启发式边界，写进限制段即可。

想看经验带宽而不是章数，用 `expcurve`。它给每章的 `totalExp` 与 `expectedLevels`，从入队章起累加就是该单位的经验上限。不要直读 `expectedLevels` 当「还能升几级」，它不 clamp 到 20 级，只用它做相对比值。

`--actor-level` 默认 20，这个默认值本身就是结论级假设，量级上比难度轴还大。预算随攻击方等级单调下降，而成长期的入队等级普遍在 1 到 20 之间，默认 20 会把早期入队单位的可用经验系统性地压低。所以任何引用 `expcurve` 数字的地方都要写出 `--actor-level`。比较不同单位时要么统一用入队等级区间，要么统一用默认值，不能一个单位一个值。

`expcurve` 的 `meta.actor` 回显解析后的 `level` / `classPower` / `promoted`，`meta.difficulties` 列出实际出数的难度。引用数字时照抄这个块，它是唯一能证明某次结论出自哪组参数的记录。

难度是一条真轴，不要按一种难度把话说死。`--difficulty` 只出一个难度，默认三个都出。换难度要重算，不要照抄另一组参数下的数字，同一个晚期入队单位在不同难度下的窗口结论可以反过来。

难度不一定单调。有些 ROM 上 `normal` 的总预算反而低于 `easy`，增量集中在后段章节。所以「难度越高压得越紧」这个推论不成立，结论要按你真正跑的参数说话。

回答前量一下每根轴在本次 ROM 上的区分度。窗口折价经常是空轴：如果池子里 `availableCount / totalAfterJoin` 几乎全为 1，它就没有分辨率，真正有区分度的是 `expcurve` 的剩余预算占比。区间宽度小于成长分相邻差距时，在答案里写「声明了公式，但它没有改变名次」。

## 6. 转职道具：时机与分配

```sql
SELECT id, name FROM items WHERE is_promotion_item = 1;
SELECT item_id, class_id, effect_code FROM item_promotions;
SELECT s.map_index, si.item_id FROM shop_items si
  JOIN shops s ON s.id = si.shop_id
WHERE si.item_id IN (SELECT item_id FROM item_promotions);
SELECT map_index, item_id FROM map_objects WHERE kind = 'chest';
```

把 SQL 写成文件或用 heredoc 跑。不要在单引号 shell 字符串里嵌单引号，`kind='chest'` 会被 shell 吃成 `kind=chest` 并报 `no such column`。

先确认这件道具拿不拿得到，再谈分配。每件 `is_promotion_item = 1` 的道具都要把三个来源求并：`shop_items`、`map_objects` 的宝箱、`gains` 的 `items[]`。零结果的写进限制段，不要当可分配资源。

事件授予用 `gains` 取，它的 `items[]` 带 `mapIndex` 与 `unitId`。`event_item_grants` 表本身没有 `map_index`，不要直接查它。也不要自己补一个 `map_index`：`event_scripts` 到 `chapter_event_slots` 的 join 会双重计数且漏计。同一个 script 可以占多个 slot，也有 script 不属于任何 slot。这不会报错，只会给出一个错的数。`gains` 已经在 `tables/eventTrace.ts` 里做了可达闭包，直接用它的结果。

点名授予要拆开看，并且校验目标能不能用。「点名」指 `unitId` 是真实单位 id：`65535` 是当时行动的单位，`0` 是无指定，`null` 是没有单位字段。不要假设真正点名的总是少数，有的 ROM 上大半授予都指向具体单位。

只尊重真正点名的那些，并逐条拿 `units.class_id` 去 `item_promotions.class_id` 里找。目标单位用不了这件道具的情况是存在的，不校验就会在答案里写出一个不可能发生的转职。

`item_promotions.class_id` 的语义是「能用这件道具的基础职业」，不是「它能转出的职业」。验证方式是取一件万能道具（`effect_code = 45`），看它列出的职业是否都是非终位。

终位判据用 `class_branches` 无子女，即 `branch_1 = 0 AND branch_2 = 0`。不要用 `classes.promotes_to_class_id = 0`：这个字段在已完成的转职链上会反向指回基础职业，它描述的是「谁是我基础」，不是「我有没有下一步」。`classes` 表也没有 `is_promoted_class` 列，那列在 `units` 上。想要权威答案直接读 `projection.maxedByBranch`。

时机必须先折成 play position，从 `map_index` 到 `derived_play_order.position`。不在播放序里的地图不在主线上，这种道具报「无主线时机」，不许报「早期」。不要按商店种类推断，每张地图都要真查。

分配规则：道具给「它能用的、niche 最稀缺的、成长质量最高的、窗口还没走完的」单位。窄口径道具（`effect_code` 25、26、27、28、29、47、49、50）给需要那条分支的人。

万能道具先查供给量再决定要不要分配。路线多到十几条、覆盖几十个基础职业的，那是日用品，不是分配决策；路线只有个位数的，才是真选择。供给充足就照实说，不要臆造一个「谁拿」的权衡。

## 7. 武器与金钱预算

金钱走 `gains` 的 `gold[].mapIndex` 加 `delta`，按 play position 累计。`event_gold` 表没有 `map_index`，理由同上，不要直接查。

价格看 `items.unit_price`，这是每条用量的单价，买入是 `uses * unit_price`。`items` 表没有 `kind` 列，类别用 `items.type_name` 或 `items.is_weapon`。商店种类在 `shops.kind`（weapon / item / secret / prep，prep 的 `map_index` 为 NULL）。

`unit_price` 有 65535 哨兵，直接 `ORDER BY unit_price DESC` 或 `MAX()` 会拿到幽灵武器。可用价格的模板是 `WHERE is_weapon = 1 AND unit_price BETWEEN 1 AND 20000 AND name <> ''`。不筛的话会得出荒谬的单价。

商店 `kind = 'secret'` 不等于「卖转职道具的店」。秘店里可能卖属性药，也可能什么都不卖，还有可能是空表。必须逐店查 `shop_items` 里到底有没有 `item_promotions` 里的道具。

先看主线金里有多少真的在主线上。事件金常常集中在离线地图（塔层、竞技场、试炼），总额不等于可用现金。这两个数都要报，差别往往是十倍以上。

把现金按 play position 累加到具体时点，再和下个商店报价比。只算总额会得出「买得起」，与时机不符。典型情形是转职秘店在中期开，而大额事件金要到更后面才到账，那个时点的现金只够买半件。

结论是「第几章买得起什么」。若这条轴全程不咬死，明说它不咬死，不要编一个约束。对照时要算价格乘数量。

## 8. 组装答案

前七节取事实，这一节是判断。失败模式通常不是数据不够，而是拼接步骤没有可复算的定义：每个读者自己发明一套排序键与常量，两份答案就不可比。所以排序键要写成公式，常量要声明。

产出四部分：

1. 排序名单，每人一行理由，点明是哪些轴的数值定了他的位置。
2. 稀缺能力覆盖表：用 §3 的结构性独占（`joinerCount === 1` 且 `classCount === 1`，且唯一可达者不是入队即终位），写明哪些 slot 没填、哪些是 `joinerCount === 0` 的结构空洞。
3. 假设块。
4. 一句模型不承诺什么。

### 8.1 排序键给公式

至少把下列三个量显式算出来并列进名单表，排序键就是在它们上面做选择。

| 量 | 定义 | 来源 | 回答什么 |
| --- | --- | --- | --- |
| `growthScore` | 七个成长列按声明权重的加权和 | `units.growth_*` | 长得好不好 |
| `headroom` | `Σ(maxed) − Σ(startingStats)` | `projection` | 还剩多少可以长 |
| `window` | `availableCount / totalAfterJoin`，或从入队章起的剩余经验占比 | `availability` / `expcurve` | 还来得及吗 |

默认起点，可以改但改了要写出来：先按「能否到达结构性独占 niche」分层，层内按 `headroom × window` 降序，`growthScore` 只做同分仲裁。

排序键必须声明，并且落到这三个量上。只写「稀缺优先」不够。报答案时把每人的三个数一起列出来，读者才能自己重排。

### 8.2 先量区分度

每根轴参与排序前先量区间宽度。最常失效的是窗口轴：如果大多数单位的值都贴近上限，它就没有分辨率，这时候起作用的其实是从入队章起的剩余经验占比。某根轴的宽度小于相邻单位的差距时，在答案里写「声明了该公式，但它没有改变名次」，不要用大段篇幅描述一个没起作用的乘数。

### 8.3 声明名单规模

名单该几人没有默认值，但必须声明 N 与理由，因为它直接改变覆盖结论。可行的依据是 `chapter_placements` 的逐章上场数、`force_sortie` 的强制出击名单，或「覆盖全部结构性独占 niche 所需的最小集合」。同一份分析写「建议 14 人」和写「建议 8 人」是两个答案。

### 8.4 覆盖表算边际

如果排序键以稀缺 niche 优先，「最少几人能覆盖全部 `joinerCount === 1` 的 niche」必然成立，覆盖表就不再是对名单的独立审计。有信息量的是边际覆盖曲线：第 1、3、5、8、12 人各新增哪几个 niche，从第几人起新增为零。写出这条曲线，读者才知道名单在哪里停止增益。

### 8.5 假设块的固定条目

成长权重向量。难度，写成声明过的选择，写明按哪个难度、因为什么，并同时写出 `--actor-level`，因为它对数字的影响比难度更大。死亡策略，它与难度常同时变化，不要只改一个。extract 的 partial 告警行数。窗口折价公式，或者「该轴没有区分度」的结论。

随机立场不要写「按成长率期望值」。`maxed` 是每次成长都成功的上界，不是期望值。正确写法是「按确定性上界排序，期望模型不存在，实际成长会低于这张表」。

三类「没算进去」要写进假设块，不要默默跳过：

- `joinUnresolved` 非 null 的单位，按类型分别说明（§1）。
- 入队章不在播放序的单位，没有窗口折价（§5）。
- 有入队、但没有 projection 行的单位，如果有（§3）。

## 9. 工具用法

输出信封不统一。`roster`、`joins`、`availability`、`niches`、`roles`、`projection`、`transitions` 是裸数组；`gains` 是 `{gold, items}`；`expcurve` 是 `{meta, budgets}`。先判 `Array.isArray()` 再消费，否则 `j[0]` 会静默得到 `undefined`。

`availability` 的默认输出只含标量。逐章状态是这份数据里最大的一块，只在问题真的关于某一章时才加 `--full`，并且重定向到文件。

`sqlite3` 默认是带框线的表格输出，不能直接读也不能直接喂给排序。一律加 `-list` 或 `-csv`，再按需加 `-noheader`。

`node:sqlite` 的 `StatementSync` 只有 `.all()`，没有 `.get()`，取一行用 `.all()[0]`。

常见表名与列名挂错的位置：`item_promotions.effect_code` 不在 `items`；`classes.promotes_to_class_id` 不在 `class_branches`，后者只有 `class_id`、`branch_1`、`branch_2`；`classes` 没有 `is_promoted_class`，在 `units` 上；`items` 没有 `kind`；`event_gold` 与 `event_item_grants` 都没有 `map_index`；`event_unit_loads` 没有 `unit_id`；`shop_items` 的列是 `position` 不是 `slot`。

名册没有 `roster` 表或视图，`SELECT ... FROM roster` 会报 `no such table`。名册就是 `units WHERE has_support_data = 1`，或者直接跑 `roster` 命令。

## 不要

- 按 `growth_total` 排序。
- 用 SQL 手数候选池。
- 把 `availableCount` / `totalAfterJoin` 直接除。入队章在播放序外时它们是 `null`，除出来是 `NaN`，而 `NaN` 参与排序会静默污染排名。先判 `joinPosition`。
- 用减法算「名册里永不入队的人数」。
- 靠 `gaps` 的形状判断离线入队，判据是 `joinPosition === null && joinMapIndex !== null`。
- 只凭 `joinMapIndex` 为 null 就判「永不入队」，先看 `joinUnresolved`。
- 用 `classes.promotes_to_class_id = 0` 判终位。
- 拿 `classLine` 的长度当「还能转几次」。
- 自己重算转职图去校正 `+5` 边。
- 按 `classes.name` 做 join。
- 把 `items.unit_price` 的 65535 当价格参与排序或平均。
- 假设商店的 `map_index` 一定在播放序里，或假设 `kind = 'secret'` 就卖转职道具。
- 把某个具体 ROM 的结论当规则用。每个 ROM 都要自己查。
- 把 `chapter_placement_steps` 当敌人行为，它只是初始移动意图。
- 物化单位与敌人的矩阵。这个问题不需要战斗模型。
- 编数字。答案里每个计数都必须来自本次会话跑过的命令或查询。
- 把 SQL 嵌进单引号 shell 字符串。
- 在 `/tmp` 下跑 `node src/index.ts`，入口文件找不到。所有命令从仓库根跑，db 路径用绝对路径。
