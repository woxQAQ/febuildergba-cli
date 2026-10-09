# febuildergba-cli 项目长期笔记

## 命令与排序口径（第五轮确立，最重要）

**13 个命令**（`storypath` 已删除，并入 `chapters`）：诊断 `info`/`validate`/`text`；
队伍 `units`/`classes`/`roles`/`supports`；地图 `chapters`/`objects`/`terrain`；
物品与敌情 `items`/`shops`/`enemy-stats`。

**排序只有一个键：`storyOrder`（游玩位置，1-based）。**
- `chapterNumber`（准备画面章节号）**每一幕都从 1 重来**，VQ 上 79 行里 36 张真实图撞号，
  ch1 = map 0/12/18/21。**永远不要用它排序**，只用于显示。
- `mapIndex` 是地图设置表的**行号**，算进了未使用槽位和据点图。也不要用它排序。
- `storyOrder` 来自 `chapters` 的 `playOrder`（解每图 END_EVENT 跳转得到），
  主线 + 插在分支点的外传。没有游玩位置的图 → `null`，排序时**排在最后**（是"未知"，不是"很晚"）。
- 真实路径是 `map16 → map41 → map42 → map17`（章节号 5→6→7→8 看着正常，但 map41/42
  的章节号其实是 6/7，靠章节号推不出相邻关系）。

**给 `load.ts` 加表**：只有 `readFileSync`/`detectVersion`/`getLayout`/`makeTextContext`
是急切的，其余都是 `memo()` 记忆化 getter。**getter 的依赖靠"读另一个 getter"声明，
文件里的顺序没有意义**，加表时不必考虑排序。

**`chapters` 的视图**：`playOrder.sequence`（游玩顺序，含 `role`/`playable`）、
`playOrder.mainPath`（无 detour 主路径）、`branches`、`offPath`、`chapters[]`、`joinOrder[]`。

## 输出模型约定（第四轮去噪后确立）

`fe-rom` 各命令的**默认输出只含有信息量的部分，`--all` 是全部**。
新加字段/新写命令都按这条走，别让默认输出又变成全表转储。

已落地的默认收缩：

- `units` 默认只出带支援数据的名单（62），`--all` 才是全部槽位。
  `--playable-only` 是默认的显式写法，保留兼容。
- `chapters.joinOrder` 默认只出角色记录；`chapters[].forcedUnits` 只列本图记录，
  `mapIndex=0xFF` 的"全图强制"在顶层 `forcedDeployment.everyMap` 里只出现一次，
  **消费方要并集**（`reports/vq/analyze.py` 已这么写）。
- `classes.impassableTerrains` 只在 `--all` 下输出。
- `supports.byUnit[].partners` 只有 `{id, name}`；数值一律从 `edges` 取
  （`edges` 每个无序对一行 `a<b`，反向不一致时在 `mismatch` 里）。
- `enemy-stats` 默认只出**分布**（`overall`/`byRoutine`/`chapters[].summary`/
  `chapters[].classes[]`/`negativeSamples`）；逐条 `samples` 只在 `--all`。
  即使 `--all` 也不输出 `unitId` 与 `grow`。

## 判据：去噪，不是去重

输出只保留"这个 ROM 作为一款游戏的事实"。**只服务于解析器自身的记录是噪音**，
三类：定位信息（地址/指针/表偏移）、解码残留（原始字节、未解码字符串）、
解析器账目（逐条 dump、数字的来源分解、推断来源标记）。

两个**有意保留的例外**，下轮别删：

- `info` 的全部地址——它的职责就是报地址，删了没别处可查。
- `chapters[].itemsGiven[].address` / `goldEvents[].address`——**跨章去重键**，
  一个脚本被多张图引用，删了会把一笔 5000 金币算 17 次。

消费方只有 `reports/vq/analyze.py`。**动输出模型前后都要拿它的产出对 diff**：
`cd reports/vq && python3 analyze.py > full-analysis.txt`。
**改"去噪"类改动时结论应当逐字节不变；改排序口径时结论就该变**，两者验收条件不同。

## 环境坑

- 跑 ROM 用**绝对路径**；相对路径会 ENOENT（有时前面加 `../fixtures/` 可用，别依赖）。
- 命令名是 `enemy-stats`（连字符）；`text` 必须带文本 id 或 `--range a-b`。
  **拼错命令名时 CLI 会报错，但 `2>/dev/null` 会把它吃掉**——
  上一轮因此漏掉了 1.25 MB 的 `enemy-stats`。批量跑命令时别吞 stderr。
- 全命令冒烟要放后台跑（13 命令 × 2 ROM 约 10 分钟），会被 120s 默认超时杀掉。
- 临时验证脚本放 `/tmp`，别堆在 `cli/` 或 `reports/` 下。
- 归因字段体积要**按"键名 + 值"计费**；只算值会系统性低估短字段
  （`samples[].grow` 单看很小，乘 3246 行就是 35 KB）。
- 测"改动前"的基线可以用 `git stash push -- cli/src` + 跑 + `git stash pop`；
  untracked 的文件（`cli/tmp-*.ts`、`reports/`）不受影响，正好可以跨版本复用同一个脚本。
  用 git reset 收尾取消暂存。
- 命令行端到端耗时里约 9.5 s 是 Node 启动 + TS 源码剥离，
  进程内省下的几百 ms 在命令行几乎看不见 —— **别用端到端时间验收惰性化**。

## VQ v3 规模基线（第五轮）

units 62 行 / classes 127 / supports 159 边 + byUnit 62 /
chapters joinOrder 62 + 60 图 / `playOrder` 49 行（48 可部署，8 外传，主路径 41）/
objects 301 / items 255 / shops 34 / terrain 62 / enemy-stats 3246 条 /
validate 53 项（50 过 3 警 0 错）。
**开局只有 5 人对 5 个槽位；最挤是 p26 `No Way Out`（7 槽位对 48 人）。**
