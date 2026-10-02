# 如何从这个 C# 代码库里挖 ROM 结构（§2）

> 本文件是 [`AGENTS.md`](../AGENTS.md) 的拆分件（原 `§2`），章节编号保持原样。
> 索引见 §0.1 文档地图。
>
> **拆出来的原因**：`AGENTS.md` 是「每次会话都会被注入」的项目指南，但注入有长度上限 ——
> 2026-10-02 那次会话的注入在 §1.2 中段被截断，按该位置的字节偏移反推约 **14.5KB**。
> §2 整节都在这条线之外，留在那里等于对 AI 不可见。
> 注入里保留的是一句话概要，本文件是完整手法与代码样例。
>
> **五种手法，按使用频率排序。**「想查 X 读哪个 C# 文件」的完整索引见
> [`reference-index.md`](reference-index.md)（§7）。

## 2.1 一切指针都在 `ROMFEINFO` 的子类里

每个游戏一个类：`ROMFE7U.cs`、`ROMFE7JP.cs`、`ROMFE6JP.cs`、`ROMFE8U.cs`、`ROMFE8JP.cs`、`ROMFE0.cs`（未知 ROM）。

文件里长这样：

```csharp
unit_pointer = 0x9A274;   //ユニットの開始位置
unit_maxcount = 253;      // ユニットの最大数
unit_datasize = 52;       // ユニットのデータサイズ
```

这就是 ROM 里所有已知表的位置和大小。**这是你的主要信息源。**

## 2.2 这些值几乎都是「指针槽」的偏移，不是表本身的偏移

这是最容易踩的坑，务必理解清楚：

```
RomInfo.xxx_pointer  =  「存放指针的那个 4 字节槽位」的 file offset
表真正的 file offset  =  p32(RomInfo.xxx_pointer)
```

即 `p32(slot)` = 读取 slot 处的 u32（一个 `0x08xxxxxx` 的 GBA 指针），再减去 `0x08000000` 得到 file offset。

证据在 `PatchForm.cs:9372` `ReplacePointerSub()`：它用 `Program.ROM.u32(Program.ROM.RomInfo.item_pointer)`
读出一个**原始 GBA 指针**去和 `searchPointer` 比较；以及 `InputFormRef.cs:5792` 的 `Init()`：

```csharp
this.BasePointer = U.toOffset(basepointer);
if (U.isSafetyOffset(this.BasePointer)) {
    this.BaseAddress = Program.ROM.p32(this.BasePointer);   // ← 解引用一次
}
```

**所以 CLI 里读取任何表之前，必须先解引用。** 只有少数以 `_address` 结尾的字段
（如 `max_level_address`、`text_recover_address`）是直接偏移，不需要解引用。

CLI 侧已经实现好了，**是 `RomBuffer` 上的方法，不是自由函数**（`cli/src/rom/RomBuffer.ts`）：

```ts
rom.p32(slot)     // 读 slot 处的 u32 → GBA 地址 → file offset           （RomBuffer.ts:131）
rom.p32p(slot)    // 二级指针 = p32(p32(slot))，用于 Huffman 树基点      （RomBuffer.ts:137）
rom.toOffset(v)   // 值 ∈ [0x08000000, 0x0A000000) 才减基址，否则原样返回（RomBuffer.ts:90）
```

**不要自己再写一个 `p32(buf, off)` 自由函数** —— 上面那个 `toOffset` 的边界判断
（值不在范围内时原样返回，而不是减基址）必须和 C# 侧一致，否则症状是
「大多数表都对、个别表整体错位」，极难定位。

## 2.3 表结构靠 `InputFormRef` 的构造参数还原

每个编辑器 Form 都有一个 `static InputFormRef Init(Form self)`，那就是一张表的完整定义：

```csharp
return new InputFormRef(self
    , ""                                                            // 列表控件名
    , Program.ROM.RomInfo.unit_pointer                              // ① 指针槽偏移
    , Program.ROM.RomInfo.unit_datasize                             // ② 每条记录字节数
    , (int i, uint addr) => i < Program.ROM.RomInfo.unit_maxcount   // ③ 有效记录判定
    , (int i, uint addr) => { ... }                                 // ④ 列表显示名
    );
```

- ② 就是你要的**结构体大小**
- ③ 就是你要的**记录条数**（`DataCount`）或终止条件
- 表地址 = `p32(①)`（见 §2.2）

## 2.4 字段偏移藏在控件名里 —— 关键技巧

FEBuilderGBA 的 WinForms 控件遵循一个命名约定：**`<类型字母><字节偏移>`**。

| 前缀 | 含义 | 字节数 |
|---|---|---|
| `B` / `b` | byte | 1 |
| `W` | word | 2 |
| `D` | dword | 4 |
| `P` | pointer | 4 |
| `l` / `h` | byte | 1 |

换算表就是 `InputFormRef.cs:5033` 的 `public static uint GetTypeLength(char c)` —— 上面这张表
是它那个 `switch` 的全文（**小写 `w` / `d` / `p` 不在表里**，所以 `W`/`D`/`P` 只认大写）。
调用点在 `InputFormRef.cs:13137`、`PatchForm.cs:7255`，都是拿名字首字母去换长度。

控件旁边那些 `J_11`、`L_24_WEAPON`、`X_WEAPON_LV` 之类的 Label，它们的 `Text` 就是字段名（日文）。

**所以还原一个结构体的标准操作是：**

```bash
# 1. 列出所有绑定到结构体的控件（名字里就带偏移量）
grep -oE "this\.[A-Za-z_0-9]+ = new (System\.Windows\.Forms\.)?(NumericUpDown|TextBoxEx|ComboBoxEx|CheckBoxEx|ListBoxEx)" UnitFE7Form.designer.cs \
  | sed 's/this\.//' | awk '{print $1}' | sort -u

# 2. 提取所有 Label 的文本，用来给字段命名
grep -nE 'this\.[A-Za-z_0-9]+\.Text = "' UnitFE7Form.designer.cs \
  | sed 's/^\([0-9]*\):.*this\.\([A-Za-z_0-9]*\)\.Text = "\(.*\)";/\1 \2 = \3/'
```

两边一对，结构体就出来了。§3 里的表格就是这么挖出来的。

## 2.5 名字不是字符串，是文本 ID —— 必须过 Huffman 解码

ROM 里存的是 `u16` 文本 ID，不是字符。链路是：

```
u16(unitAddr)  →  文本 ID  →  TextForm.Direct(id)  →  FETextDecode.Decode(id)
```

算法实现在 `FETextDecode.cs:327` 的 `huffman_decode()`。详见 §3.8；两种存储格式见 §3.9。
