# 章节与事件

本文是 `cli/` 中「章节」与「事件」两层的证据记录：哪些结论是从 ROM 字节或
FEBuilderGBA 反汇编读出来的，哪些是推断。代码里的引用（如
`tables/chapters.ts` 的 `docs/chapters-and-events.md` §3.19）都指向本文。

## 1. 地图设置表

`map_setting` 记录按 `layout.map.settingRecordSize` 步进，末尾以 `+0 == 0`
的哨兵记录结束（`readMapSettingTable`，`tables/chapters.ts`）。记录数不是
常量：不同版本、不同 hack 都可能扩表，所以读取以哨兵为准，`count` 只是上
界。

`readMapSettingTable` 返回的 `countSource` 记录这个数是从哪来的（哨兵 /
布局上限），因为「表多长」本身是一条需要可见的推断。

章节号与地图设置行不是一回事：`chapterNumber`（含 gaiden 的 8.5 半步）是
准备画面的编号，`map_index` 才是行号。分析一律用 `map_index`，顺序用
`derived_play_order`。

## 2. 条件槽与事件脚本

每章的 `condTableAddr` 指向一张条件槽表。槽的种类由 `config/data` 的
`eventcond_<game>.txt` 给出名字；`SLOT_TABLE_KINDS` 里的种类（TURN / TALK /
OBJECT / ALWAYS）是**小记录表**，每条 12 字节，脚本指针在 `+4`，读 64 条或
直到 `+0 == 0`；`START_EVENT` / `END_EVENT` 直接就是脚本指针；其余种类
（PLAYER_UNIT / ENEMY_UNIT / TRAP / FREEMAP_*）不是脚本。

以上对应 `EventCondForm.MakeUnitPointer`（`tables/eventTrace.ts` 的模块
注释）。

脚本按起始地址唯一化后**线性解码一次**，遇到退出码（参考实现的
`isExitCode`）、连续 10 条以上 UNKNOWN、或 4000 条上限就停。停下来的原因
写进 `event_scripts.stop_reason` —— UNKNOWN 指令的宽度是猜的
（`UNKNOWN_SIZE`），所以「在哪停、为什么停」是数据，不是日志。

## 3. 单位配置块

### 3.19 FE8 没有敌人配置表

原版 GBA FE 的部署块（初回配置）只放玩家侧单位；敌人来自事件脚本里的
`LOAD*` 指令指向的单位块。所以「这一章有哪些敌人」不是一个表的查询，而是
**遍历该章能到达的脚本、读每个单位块的阵营**。

单位块与部署块是**同一种记录**，同一个 `readPlacements` 读它：
`layout.map.unitDataSize` 字节一条，`+0 == 0` 结束
（`EventUnitForm.Init`，EventUnitForm.cs:147）。这面镜像是游戏本身的结构，
不是为了复用而复用。

阵营不是独立字段，而是 `+3` 这个位域的 bits 1-2：

```
bit  0      autolevel     - L_3_UNITGROW_GROW（不成长 / 职业成长）
bits 1-2    allegiance    - L_3_UNITGROW_ASSIGN（自军 / 友军 / 敌军 / 消灭）
bits 3-7    level         - L_3_UNITGROW_LV
```

字段语义的参考：`InputFormRef.cs:993-1094`（`linktype == "UNITGROW"`）读写
这些掩码，`EventUnitForm.Designer.cs:1255-1313` 给出每个名字背后的下拉项。
解码实现是 `parseUnitGrowAssign` / `unitSideOf`。

因此「红单位和蓝单位」的唯一区别就是这两位，记录其余部分完全相同。
`removed`（消灭）不是一个阵营，而是「地图载入时删除」——hack 移除名册单位
的手段。

### 3.20 坐标与「走到哪」

FE8 把坐标打包进一个 u16：`x = bits 0-5`、`y = bits 6-11`、`ext = bits
12-14`（`decodeUnitPosition`，对应 `U.MakeFe8UnitPos`，U.cs:1770）。FE6/FE7
的坐标字就是普通的两个字节，没有 `ext`。

单位记录里存的坐标是**布阵位置**，不是它最终站的地方。真正的走位在
`+8` 指向的 8 字节记录数组里（u16 打包坐标、u8 速度、u8 单位 id、u16 等待
帧），条数在 `+7`；`EventUnitForm.cs` 按 `8 * i` 写。所以「这一格的敌人会
不会动过来」要读两张表。

`ext` 的 bit `0x2` 是アイテムドロップ（死亡时掉落物品，
`EventUnitForm.cs:2575`），其余位是布阵前的动画/姿势选择。

### 3.21 初始物品

`+12..15` 是四个初始物品槽，`0` 为空（`EventUnitForm.Designer.cs` 的
`B12..B15` 标注为 所持品1..4）。**敌人的装备只存在于这里**——部署块存的是
玩家/军师侧单位。槽位 0 不是「已装备槽」：GBA FE 在战斗时从可用武器里
选，所以「攻击力」是 join `items` 之后再挑，没有单一的「装了什么」。

## 4. 谁能到达哪一章

`collectPlacementSites` 以一章为范围，从它的每个条件槽出发，沿 `CALL`
闭包收集所有 `POINTER_UNIT` 指令及其单位块。**同一章内**按
`(指令地址, 块地址)` 去重；不同章之间不去重——一个块被两章共享，在整体普查
里是一个块，在逐章投影里是两章的敌人，两者都对，回答的是不同问题
（`scripts/unit-placement-census.ts` 因此自己做跨章去重）。

`classifyUnitArg`（`tables/chapters.ts`）从指令的模式串和参数位置判定这次
加载的性质：`recruit`（LOAD1 一类，进玩家军）／`load` / `cutscene` /
`other`。「到达」不等于「触发」——带旗标或回合条件的脚本可能永不执行，所有
基于到达的派生（`recruits`、`gains`、`joins`、`expcurve` 的增援计数）都带
着这条缺口，各自的模块注释里写明。

## 5. 顺序

`derived_play_order` 是**唯一**物化的顺序来源：主线和外传被「在分支点之后
插入」拼接成一条有位置编号的序列，`chapterNumber` 排不出这个顺序。它的输入
是各章 `END_EVENT` 脚本（及其 CALL 闭包）里的转移目标，即 `transitions`
命令打印的东西。外传之外的分支（`playOrder.branches`）和闭环检测
（`closedLoop`）只有运行时的形状，没有表能表达，所以留在 `meta` 里。
