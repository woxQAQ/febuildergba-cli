# 参考程序的构建与运行（§8）

> 本文件是 [`AGENTS.md`](../AGENTS.md) 的拆分件（原 `§8`），章节编号保持原样。
> 索引见 [`docs/README.md`](README.md)。

## 8. 附录：参考程序的构建与运行

只有在**交叉验证数据**时才需要。日常开发 CLI 用不到。

### 项目概况

| | |
|---|---|
| 语言 / UI | C# / Windows Forms |
| 目标框架 | .NET Framework 4.0（`app.config` 要求运行时 4.5） |
| 解决方案 | `FEBuilderGBA/FEBuilderGBA/FEBuilderGBA.sln`（VS2010 格式，`ToolsVersion 12.0`） |
| 工程 | 单个 `FEBuilderGBA/FEBuilderGBA/FEBuilderGBA.csproj` |
| 规模 | ~477,000 行 C#，~768 个 `.cs`（全部平铺在 `FEBuilderGBA/FEBuilderGBA/` 下） |
| 包管理 | **无** —— 没有 NuGet，没有 restore |
| 平台 | **仅 Windows** |

### 构建

```bat
cd FEBuilderGBA
msbuild FEBuilderGBA.sln /p:Configuration=Debug /p:Platform=x86
```

或用 Visual Studio 打开 `FEBuilderGBA/FEBuilderGBA/FEBuilderGBA.sln` 直接构建。输出在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/`。

### 运行所需的两样外部资源 —— **仓库里已经有了**

> ⚠️ 早期版本写「这两样都不在仓库里，必须自己补」，**这是错的**。实测两者都在，
> 且**都被 git 跟踪**（`FEBuilderGBA/FEBuilderGBA/bin/Debug/config/` 有 43,075 个文件）：

1. **`config/` 目录树** —— 已在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/config/`：
   ```
   config/
   ├── data/          游戏数据表（422 个文件，见 §1.1）
   ├── patch2/        社区补丁 + MOD_*.txt
   ├── translate/     <lang>.txt 翻译资源
   └── config.xml     用户设置（首次运行生成）
   ```
2. **`7-zip32.dll`**（LGPL 2.1）—— 已在 `FEBuilderGBA/FEBuilderGBA/bin/Debug/7-zip32.dll`。
   见 `README.7-zip32.dll.md`。

`Program.cs` 的 `CheckConfigDirectory()` / `Check7ZipDLL()` 会校验它们。
**所以在这台机器上直接 `msbuild` 就能跑**，不需要从安装包拷任何东西。
（`FEBuilderGBA/FEBuilderGBA/bin/Debug` 下目前只有 `config/`、`7-zip32.dll`、`FEBuilderGBA.exe.config` ——
exe 本身仍需自己构建。）

### 测试（DEBUG 构建）

没有测试框架。`Program.DebugTESTRunner()` 用反射调用全程序集里的静态无参方法：`TESTNOW_*` → `TEST_*` → （带 `--test`/`--testonly` 时）`TESTFULL_*`。断言用 `Debug.Assert`，测试方法就地写在被测代码所在的文件里，包在 `#if DEBUG` 中。

```bat
:: 只跑测试然后退出
FEBuilderGBA\FEBuilderGBA\bin\Debug\FEBuilderGBA.exe --testonly
```

### 常用命令行参数

| 参数 | 用途 |
|---|---|
| `--rom=<path>` | 启动时打开指定 ROM |
| `--lastrom` | 打开上次使用的 ROM |
| `--force-version=<FE7U\|FE7J\|...>` | 强制指定 ROM 版本 |
| `--lint` | ROM 检查并退出 |

### 改这个 C# 项目时的注意事项（如果真要改）

- 命名空间统一是 `FEBuilderGBA`，不要新建命名空间
- **不要手改 `*.Designer.cs`** —— 是设计器生成的
- **新加的 `.cs` 文件必须手动加进 `FEBuilderGBA/FEBuilderGBA/FEBuilderGBA.csproj` 的 `<Compile Include>`** —— 这个工程不用通配符，漏了就不会被编译
- 提交信息/标签格式：`ver_YYYYMMDD.NN`

---
