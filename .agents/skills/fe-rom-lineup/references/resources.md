# 训练机会、资源与技能

按问题读取相应章节，不为局部职业比较执行整套资源审计。下列 `src/` 路径均相对仓库根。

## 1. 出勤与经验机会

```bash
node src/index.ts availability <db>
node src/index.ts availability <db> --full
node src/index.ts expcurve <db> --difficulty normal --actor-level 20 --actor-class-power 3
```

`availability` 默认给标量与 gap 摘要；只有需要具体章状态时才用 `--full` 并保存输出。`windowRatio` 是出勤完整度，`availableCount` 是剩余可用章数，二者分别报告。gap 元素为 `{ fromPosition, toPosition, reason }`，计数已经扣除 gap，不要重复扣减。

状态推导是启发式：友军/移除记录会优先于已入队状态，同章先友军后招募可能让入队章被计作 gap。章节布阵中没有出现也不等于离队。说明实际影响，不自行补回计数。

离线入队、未定入队、未入队都没有定义好的主线窗口，保持 `null`。不要拿相邻章预算代替离线入队章，也不要暗填 0 或 1。

`expcurve.data.budgets` 只覆盖播放序上 `playable = 1` 的章。先固定难度和攻击方参数，再按 position 从入队章起求 `totalExp` 之和。若只统计 availability 标为 available / forced 的章，明确声明该过滤规则；目标时点在终盘前时也要截到该时点。可除以同一参数下全路线预算得到占比，分母为 0 时保持未定义。

比较不同单位的机会时共用一组攻击方参数，不逐人换成各自等级后直接比较预算。需要看等级敏感性时，对同一候选集合运行另一整组参数，报告顺序是否改变。

当前默认是固定 Lv20、class power 3、未晋升，不是每次对 ROM 动态求众数。引用结果时附 `meta.parameters.actor / difficulties / assumptions`；来源在同层的 `sources`。难度不保证预算单调。

预算的边界：

- 假设所有计入敌人由同一个固定攻击方击杀，不考虑队友分摊、命中、生存、武器消耗与攻击方升级；
- 可达事件不一定触发，重复加载又可能只计一次；partial 还可能漏事件，不能把累计值当真实游玩的严格全局上界；
- `expectedLevels` 是预算除以 100，不 clamp 到等级上限，也不代表单位实际会升这些级；
- 杖、舞蹈、救援等非敌人经验不在预算里，不能用这份预算否定这些单位的训练机会；
- `--actor-promoted` 增加有效等级，但上位攻击方的 class-bonus-B 项未建模；这组预算适合条件比较，不是真实成长过程；
- 完整局限以本次 `meta.parameters.assumptions` 为准，不把无关游戏的规则套到当前 ROM。

## 2. 转职方案与可得资源

先检查选定分支需要什么，再查来源。SQL 可从以下事实开始：

```sql
SELECT id, name FROM items WHERE is_promotion_item = 1;
SELECT item_id, class_id, effect_code FROM item_promotions;
SELECT s.id, s.kind, s.map_index, si.position, si.item_id,
       si.effective_uses * i.unit_price AS buy_price
FROM shop_items si
JOIN shops s ON s.id = si.shop_id
JOIN items i ON i.id = si.item_id
WHERE si.item_id IN (SELECT item_id FROM item_promotions)
ORDER BY s.id, si.position;
SELECT map_index, item_id, flag FROM map_objects WHERE kind = 'chest';
```

每件所需道具合并商店、宝箱与 `gains.data.items` 三类来源。查询无来源时写“已检查来源中未找到”，不证明 ROM 绝无掉落或其他获得机制；该道具不能在当前证据下参与确定分配。

`item_promotions.class_id` 是使用道具时的源职业，不是目标职业。核对方案当时的源职业可以使用它，并且所选目标存在于模型转职图。仅凭效果码（包括 45 / 0x2d）不能宣称对所有职业通用；按当前 ROM 的兼容表判断。共用 staff effect 的多个物品会共享兼容列表，兼容行数不是道具供给数量。

道具出现场所、脚本路径、可领取数量和可使用条件分开检查：

- `map_index` 映射到 `derived_play_order.position` 才有当前路线时机；离线来源不算主线现货；
- `shops.map_index IS NULL` 是备战商店，无章节归属不等于从序章开始随时可买；需要备战访问条件；
- 秘店不一定卖转职道具，入口条件与库存要分别确认；
- 宝箱还要检查钥匙/开锁能力与访问条件，不能从存在 door 对象推断宝箱能打开；
- 宝箱的非零 flag 是一次性标志；flag 为 0 也不据此凭空计入无限供给；
- 多条脚本可达路径不等于多件独立奖励，互斥事件不能同时分配；
- 能在很多店购买不等于免费或无限可负担；检查计划数量、是否限量与累计支出。

事件授予用 `gains`，不要把 `event_item_grants` 经 slot 简单连接补 map_index；共享脚本与调用闭包会造成漏计或重复。`gains` 的记录仍是可达指令，需要核实实际触发与次数。

`unitId` 65535 表示当时行动单位，0 表示无指定，null 表示没有单位字段。真实 ID 表示接收者，不自动表示道具只能由他使用。接收者不能使用时，检查能否转交给符合源职业限制的单位；未经验证不编造专属绑定。

将一次性物品和购买款分配到具体名单方案，不重复使用。资源冲突时重选方案或降为条件推荐；只有来源和数量已支持需求时才说“当前不构成约束”。

## 3. 武器价格与现金情景

`items.is_weapon` 已存在，由提取器的 `type <= 7` 规则得出；hack 修改物品类型后该规则仍可能不可靠。结合 `type_name`、武器参数与效果核对异常，不因物化为列就当作游戏运行时的权威分类，`item_effectiveness` 也不能识别所有普通武器。

物品要求读 `items.weapon_rank_letter` 或数值 `weapon_rank`；单位与职业的 `wl_*` 也是数值。字母阈值为 E 1..30、D 31..70、C 71..120、B 121..180、A 181..250、S >=251。职业能用某武器家族不代表单位已满足某件武器的等级要求。

商店买入价为 `shop_items.effective_uses * items.unit_price`。列表的 `uses = 0` 表示满耐久，不代表免费。卖价可按半价估算，若影响结论再核对实际取整与出售限制。计划总价还要乘购买数量。

`unit_price` 为 u16，65535 没有数据库哨兵契约。对极端价格、空名字及与类别不符的行逐项核实；使用价格区间做探索时披露被过滤行数，不能据此永久排除真实物品。

金钱事实用 `gains.data.gold` 的 `mapIndex` 与带符号 `delta`，另查 `map_objects` 的金钱宝箱。先把当前播放序内与序外收益分开，序外金不自动进入主线现金。

可达事件的正负增量不能直接累加成保证持有现金：奖励可能互斥，负值指令可能属于未选择的消费分支，初始金、卖出与玩家采购也未必已知。需要一个声明过的现金情景：

```text
cash(p) = 初始金 + 截至 p 实际纳入情景的收益
          − 截至 p 纳入情景的事件支出 − 已选采购总价
```

只纳入该情景会触发的事件，声明未知初始金与其他收支如何处理。在每个采购时点更新余额；不能让同一笔金同时支撑多份方案。无法核实事件条件时，报告“按这些奖励均触发的情景可购买”，不报告保证买得起。

## 4. 技能只按已验证的获得方式计入

先查本次提取的规模：

```sql
SELECT (SELECT COUNT(*) FROM skills) AS skills,
       (SELECT COUNT(*) FROM unit_skills) AS unit_skills,
       (SELECT COUNT(*) FROM class_skills) AS class_skills,
       (SELECT COUNT(*) FROM unit_skill_learn) AS unit_learn,
       (SELECT COUNT(*) FROM class_skill_learn) AS class_learn;
```

全空只能说明本次没有提取到受支持的技能数据，不能反推 ROM 是原版。当前提取器支持的系统范围见 `src/tables/skills.ts` 与 `src/rom/skillSystem.ts`。

有数据时，按同一单位与所选职业路线拼接：`unit_skills` / `class_skills` 是各自至多一个静态技能，`unit_skill_learn` / `class_skill_learn` 是习得表。职业技能与个人技能的价值由实际效果和获得时点决定，不固定“职业高于个人”的权重。

习得表的 `player_only` / `enemy_only` / `both_sides` / `hard_only` 只在启用 class-skill 扩展时解码，无扩展时均为 false，`level` 是整个字节。`both_sides` 表示前两个 side 位同时设置，不能看到 `enemy_only` 为 true 就直接剔除这一行；先解释组合，再看难度与等级。

先检查 `raw_level`。255 是特殊编码，不能称为“无等级门槛、等级一到就学”。上游语义涉及直接加载到职业与转职获得的差别，当前解码还可能在扩展开启时将它拆成 level 31 和多个 true 标志。未核实实际获得路径前单列为未定，不自动给所选转职方案加上该技能。

默认技能只作定性说明；若进分数，逐项声明效果依据、获得条件、权重与重复技能处理。缺少技能效果或获得证据时保留未知，不按名字推测强度。
