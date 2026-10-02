# 权威来源索引（§7）

> 本文件是 [`AGENTS.md`](../AGENTS.md) 的拆分件（原 `§7`），章节编号保持原样。
> 索引见 §0.1 文档地图。
>
> **拆出来的原因**：这是一张「想查什么 → 读哪个 C# 文件」的查表，
> 只在真正动手挖的时候才需要 —— 而 `AGENTS.md` 每次会话都被注入且会被截断。
>
> 路径一律相对仓库根；C# 源码目录 = `FEBuilderGBA/FEBuilderGBA/`（见 §0）。

## 7. 权威来源索引

| 想查什么 | 读这个文件 |
|---|---|
| ROM 里所有表的指针/大小 | `FEBuilderGBA/FEBuilderGBA/ROMFE7U.cs`、`ROMFE7JP.cs`、`ROMFE8U.cs`、`ROMFE8JP.cs`、`ROMFE6JP.cs` |
| ROM 版本识别 | `FEBuilderGBA/FEBuilderGBA/Rom.cs` → `LoadLow()` |
| 角色表结构 | `FEBuilderGBA/FEBuilderGBA/UnitFE7Form.cs` + `UnitFE7Form.designer.cs` |
| 角色通用查询（名字、ID 反查） | `FEBuilderGBA/FEBuilderGBA/UnitForm.cs` |
| 职业表结构 | `FEBuilderGBA/FEBuilderGBA/ClassForm.cs` + `ClassForm.designer.cs` |
| **职业特性位 → 位名** | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs` → `GetInfoByBitFlag()` (7453) + `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/unitclass_checkbox_*.txt`（§3.4.1） |
| 支援关系表 | `FEBuilderGBA/FEBuilderGBA/SupportUnitForm.cs` |
| **支援 C/B/A 门槛（81/161/241）** | `FEBuilderGBA/FEBuilderGBA/SupportUnitForm.Designer.cs:460` → `EXPLAIN.Text`（§3.5.1） |
| **支援对话解锁点数（80/160/240）** | **反汇编** `GetUnitSupportBonuses` / `UnitGainSupportExp`（§3.13） |
| **相性加成如何随等级放大** | **反汇编** `StoreAddedAffinityBonusesForSupportLevel`（§3.7.2 / §3.13） |
| **支援距离 / 单人 5 级上限** | **反汇编** `GetUnitSupportBonuses` / `CanUnitSupportNow`（§3.5.1） |
| 支援会话表 | `FEBuilderGBA/FEBuilderGBA/SupportTalkFE7Form.cs` |
| 支援相性加成表 | `FEBuilderGBA/FEBuilderGBA/SupportAttributeForm.cs`（**只有读写，没有等级换算**） |
| 相性名称（炎雷風氷闇光理） | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs:7006` → `GetAttributeName()`；**也可从 ROM 文本表解出**（文本 id 见 §3.7） |
| **地形名表** | `FEBuilderGBA/FEBuilderGBA/MapTerrainNameForm.cs` + `MapTerrainNameEngForm.cs`（§3.12） |
| **文本控制码清理** | `FEBuilderGBA/FEBuilderGBA/TextForm.cs:1262` → `StripAllCode()`（单位名也要过，见 §3.12） |
| 文本解码（Huffman） | `FEBuilderGBA/FEBuilderGBA/FETextDecode.cs` |
| **原版函数符号表** | `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/asmmap_FE8.txt`（`.en` / `.zh` 变体）（§3.13） |
| **FE8 反编译（字段名/常量的第二意见）** | `FireEmblemUniverse/fireemblem8u` → `include/bmreliance.h` + `src/bmreliance.c`（§3.13.2） |
| **地图设置表 / 终止判定** | `FEBuilderGBA/FEBuilderGBA/MapSettingForm.cs` → `IsMapSettingEnd()` (64)（§3.11.2） |
| **章节条件表 → 初始配置块** | `FEBuilderGBA/FEBuilderGBA/EventCondForm.cs` → `MakeUnitPointer()` (1564) / `MakeUnitPointerEventScan()` (1743)（§3.11.3） |
| **事件脚本反汇编器** | `FEBuilderGBA/FEBuilderGBA/EventScript.cs` → `DisAseemble()` + `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/data/event_*.txt`（§3.11.4） |
| **强制出击表** | `FEBuilderGBA/FEBuilderGBA/EventForceSortieForm.cs`（只暴露 2 个字段）+ `ROMFE8U.cs:95` + 反汇编 `IsCharacterForceDeployed_`（§3.14） |
| **搜索型指针槽的解析** | `FEBuilderGBA/FEBuilderGBA/U.cs` → `FindROMPointer()` 三个重载（7644 / 7667 / 7705）（§2.2 / §3.11.2） |
| 指针/偏移工具函数 | `FEBuilderGBA/FEBuilderGBA/U.cs` → `toOffset` / `isPointer` / `isSafetyOffset` |
| ROM 读写原语 | `FEBuilderGBA/FEBuilderGBA/Rom.cs` → `u8/u16/u32/p32/p32p` |
| `InputFormRef` 参数含义 | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs` → `Init()` (5792)、`GetTypeLength()` (5033)、`IDToAddr()` (5561) |
| 控件名 → 偏移的约定 | `FEBuilderGBA/FEBuilderGBA/InputFormRef.cs` → `GetTypeLength()` (5033) |

**通用挖法**（拿到新表时）：找到对应 `XxxForm.cs` 的 `Init()` → 读出指针槽/大小/条数 →
打开 `XxxForm.designer.cs`，用 §2.4 的两条 grep 还原字段偏移和名称。
