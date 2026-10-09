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
**memo 是 non-enumerable**（第六轮改）：`JSON.stringify(rom)` / `{...rom}` 只会拿到
`path/rom/identity/layout/text` 五个急切字段，不会误触发全量计算。

**`chapters` 的视图**：`playOrder.sequence`（游玩顺序，含 `role`/`playable`）、
`playOrder.mainPath`（无 detour 主路径）、`branches`、`offPath`、`chapters[]`、`joinOrder[]`。

## CLI 契约（第六轮确立）

**退出码**：`0` 成功 / `1` ROM 读不了或解析失败 / `2` 参数错。
`UsageError`（`commands/types.ts`）= 用户可以重打一遍的错，走 2；
其它异常走 1。`RomNotFoundError` = 文件路径问题，一行消息不抛栈。
不在 `run()` 里校验的命令，参数校验要提到 `args.ts`。

**配置文件语言**：`cli/data/*.txt` 默认**英文优先**（`.en` → 裸日文 → `.zh`），
`--lang <en|ja|zh>` 可切，`ja` 即裸文件。**`event_FE8.en.txt` 是 `event_FE8.txt`
的超集（多 6 条 opcode）** —— 上游 `U.ConfigDataFilename`(U.cs:3180) 是
"调用方语言 → 英文 → 裸文件"，原来移植成 `['', '.en', '.zh']` 把顺序写反了。
`info.configData` 会报出实际用了哪个目录/语言/表。

**`hex()` 在 `src/format.ts`（不是 `cli/`）** —— `rom/`/`tables/`/`analysis/` 都要用，
从 `cli/` import 会把依赖方向搞反。**但线路格式不能套它**：`huffman.ts` 的
`@XXXX` 转义码是 4 位裸十六进制、无 `0x`，解码侧用 `/@([0-9A-Fa-f]{4})/` 匹配。

**Node 版本是 `>=22.18`**：type stripping 在 22.6 就要 `--experimental-strip-types`，
22.18 才默认开。**`tsc` 过 ≠ 能跑**：类型检查接受构造函数参数属性
（`constructor(readonly x: T)`），Node 的类型剥离不接受，运行时会
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。改完要真跑一次。

**字段含义不能随 flag 变**：`roles.roster.populatedUnitSlots` 恒为全部非空槽位
（FE8U = 255），`--playable-only` 只影响 coverage/healers/magicUsers。
**静默降级必须 stderr 警告一次**（`loadRom` 的 `requireConfigDir()`，库用法传
`warn: () => {}` 静音）。**不在 `run()` 里校验的命令，参数校验要提到 `args.ts`**
（多余位置参数现在会 exit 2）。

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
- 测"改动前"的基线：`git stash push -- src package.json` → 跑 → `git stash pop`。
  untracked 的 `reports/` 不受影响，同一个冒烟脚本可跨版本复用
  （脚本放 `/tmp/smoke.sh`，输出到 `/tmp/smoke-{old,new}/`）。
- 命令行端到端耗时里约 9.5 s 是 Node 启动 + TS 源码剥离，
  进程内省下的几百 ms 在命令行几乎看不见 —— **别用端到端时间验收惰性化**。
- **`sed`/`grep` 被 WorkBuddy 的 shim 接管**（`app.asar.unpacked/cli/vendor/shim/`），
  BSD 语法 `-i ''` 会报 "No such file or directory"。**用 `/usr/bin/sed` 和 Grep 工具**。
- **Edit 工具的 `old_string` 不能以换行结尾** —— 末尾换行会被吃掉，把下一行粘上来。
  批量改文件用 python 脚本，别用 Edit 逐个来。

## VQ v3 规模基线（第五轮）

units 62 行 / classes 127 / supports 159 边 + byUnit 62 /
chapters joinOrder 62 + 60 图 / `playOrder` 49 行（48 可部署，8 外传，主路径 41）/
objects 301 / items 255 / shops 34 / terrain 62 / enemy-stats 3246 条 /
validate 53 项（50 过 3 警 0 错）。
**开局只有 5 人对 5 个槽位；最挤是 p26 `No Way Out`（7 槽位对 48 人）。**
